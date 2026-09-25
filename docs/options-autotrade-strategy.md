# Options Auto-Trader — Strategy Reference

This document describes exactly what the Options Auto-Trader does today, as implemented in this
codebase (`src/quant/`, `src/options-auto/`, `api/options-autotrade.ts`). It is not a marketing
description — every number below is a real, currently-configured default, and every rule is traced
to the source file that implements it. Where a threshold is explicitly a "provisional, not yet
backtested" starting point in the code's own comments, that is called out rather than glossed over.

## 1. What this is

A fully automated, defined-risk **options premium-selling** system for three Indian index
underlyings — **NIFTY, BANKNIFTY** (NSE, exchange `NFO`) and **SENSEX** (BSE, exchange `BFO`).
It only ever sells credit spreads or iron condors — undefined-risk (naked) positions are never
built. It does not use price-action indicators (no RSI/MACD/moving-average signals drive entries);
direction is read purely from the options volatility surface (skew), and separately, sizing/risk is
governed by real account equity and hard exposure caps.

Three execution modes exist (`options_autotrade_settings.execution_mode`):
- **OFF** — scans no-op entirely.
- **PAPER** — the full pipeline runs against live market data, but no real order is placed; fills
  are simulated instantly at the live price (`src/quant/execution/paperFill.ts`).
- **AUTO** — real orders are placed against your actual Zerodha/Kite account, sized against your
  actual account balance (not a self-declared number).

## 2. The pipeline, end to end

Two recurring server-triggered jobs drive everything (external cron-job.org pingers hitting
`api/options-autotrade.ts` with a shared-secret `Authorization: Bearer` header — see
`OPTIONS_AUTOTRADE_CRON_SECRET`):

- **`resource=paper-scan&symbol=<NIFTY|BANKNIFTY|SENSEX>`** — every 30 minutes during market
  hours, once per symbol. Looks for a NEW entry.
- **`resource=position-monitor`** — every 1 minute during market hours. Re-quotes every OPEN
  position and evaluates exits. Runs regardless of execution_mode or daily-lock state — exits are
  never blocked.

### 2.1 Pre-flight gates (before any candidate is even built)

In order, each one a hard no-op if it fails (`handlePaperScan`, `api/options-autotrade.ts`):

1. `execution_mode` must be `PAPER` or `AUTO` (anything else — `OFF` — no-ops).
2. Market must be open (`isMarketOpenIST()` — real IST clock check).
3. **Daily risk lock** must not already be engaged (see §6).
4. A live Kite session must exist (`kite_session` table) — no session, no-op.
5. The instruments master (`options_instruments`, refreshed daily by a separate sync job) must
   have data for this symbol, and must be **no older than 96 hours** — a stale sync hard-blocks
   trading rather than silently trusting outdated expiry/strike data.
6. At least one expiry must fall inside the configured DTE band (`min_dte`–`max_dte`, default
   **2–60 days**).

### 2.2 Building the live chain

- Spot price and India VIX are fetched in one batched Kite `/quote` call.
- For every eligible expiry, strikes within **±8% of spot** are selected
  (`selectStrikesNearSpot`, `src/lib/optionsChainLive.js`).
- All expiries' instrument keys are combined into one flat list and fetched in as few `/quote`
  calls as possible, chunked at Kite's documented cap (500 instruments/request) — this keeps a
  single scan to 1–2 live quote calls regardless of how many expiries are eligible.
- Quotes are normalised and enriched (`src/quant/enrich.ts`): each leg gets a model-implied
  volatility and Black-76 Greeks (delta/gamma/theta/vega/rho), computed from the **mid price**
  (falling back to settlement, then last-traded price only if mid is unavailable — see
  `pricing.markPricePreference` in `src/quant/config.ts`).

### 2.3 Direction: skew, not price action

For each eligible expiry independently (`src/quant/strategies/regimeSelect.ts`):

- The **25-delta risk reversal** (call IV minus put IV at the 25-delta strikes) is computed
  (`src/quant/analytics/skew.ts`).
- Every index chain carries a permanent baseline put skew (crash-protection demand), so the
  reading is compared against a **±1.5 vol-point band** (`DEFAULT_SKEW_THRESHOLD = 0.015`), not
  zero:
  - Risk reversal **> +1.5%** → **bullish** → build a **Bull Put Spread** (sell OTM put, buy
    further OTM put as protection).
  - Risk reversal **< −1.5%** → **bearish** → build a **Bear Call Spread** (sell OTM call, buy
    further OTM call as protection).
  - Within the band → **neutral** → build an **Iron Condor** (both sides at once).

This is the literal implementation of "sell puts when the market looks bullish, sell calls when it
looks bearish" — driven by the volatility surface, not by trend/momentum indicators.

A **separate, independent "Market Regime"** read (trend via 20/50-session EMA, realized-vol
percentile, and a whipsaw/choppiness check — `src/quant/analytics/marketRegime.ts`) is computed
from real historical closes and India VIX and is shown alongside every decision for context. **It
does not gate or filter trades today** — it is diagnostic-only, explicitly kept separate from the
skew-driven strategy choice so the two are never conflated in the UI.

### 2.4 Strike and wing selection

For the chosen structure, a grid of candidates is generated and priced
(`src/quant/strategies/strikeOptimizer.ts`):

- **Short-strike delta targets explored:** 0.10, 0.16, 0.20, 0.25, 0.30 (`DEFAULT_DELTA_TARGETS`).
- **Wing widths explored:** 2×, 4×, 6× the chain's own strike step (50 pts for NIFTY, 100 for
  SENSEX, etc.) — three widths per side.
- That's up to 5 × 3 = 15 raw candidates per structure per expiry (duplicates that resolve to the
  same actual strikes are merged).
- Every candidate is priced with real net credit, max profit, max loss, breakeven, and net Greeks
  (`ironCondor.ts` / `creditSpread.ts`).
- **Hard liquidity gate**: any leg with **zero open interest AND zero volume**, or a bid/ask
  spread ≥ **50%** of mid (`fatalSpreadPct`), makes the whole candidate `UNTRADABLE` and it is
  discarded outright — never merely scored lower (`src/quant/analytics/liquidity.ts`).
- Surviving candidates are ranked by **expected value per unit of risk**
  (`pop·maxProfit − (1−pop)·maxLoss`, divided by maxLoss) and the best one is kept per expiry.

### 2.5 Expiry selection

Every eligible expiry is run through the full pipeline independently
(`src/quant/strategies/expirySelector.ts`), then compared on that same EV-per-unit-of-risk metric.
The winning expiry's best candidate is what actually gets evaluated for trading.

### 2.6 Trade Quality Score (0–100)

The winning candidate is scored against a weighted composite
(`src/quant/strategies/tradeQualityScore.ts`), a fully-documented-as-provisional set of weights:

| Component | Weight | What it measures |
|---|---|---|
| Premium edge (IV vs. realized vol) | 20 | Is implied volatility rich vs. what has actually realized historically |
| Independent expected value | 20 | Does *this specific* structure have positive EV under a probability model that does **not** come from the same IV that priced it (empirical historical-return distribution, or a realized-vol lognormal fallback) |
| IV rank | 12 | Where current ATM IV sits vs. its own 1-year history |
| Strike safety | 13 | Distance of the short strike from the forward, in expected-move standard deviations |
| Risk/reward | 8 | maxProfit / maxLoss |
| DTE suitability | 8 | Penalizes both too-near (gamma risk) and too-far (capital efficiency) expiries; flat 100 in a 14–45 DTE plateau |
| Liquidity | 8 | Spread quality plus an OI/volume penalty (halves the score if below minimums) |
| POP (probability of profit) | 7 | Deliberately *small* weight — POP is derived from the same IV that priced the trade, so it's close to a tautology; kept only as a sanity check |
| Margin efficiency | 4 | Credit collected per rupee of margin required (only when a live margin figure was fetched) |

A component whose input isn't available (e.g. no IV history yet for a symbol) is **excluded, not
defaulted to zero** — the remaining weights renormalize.

The score is then classified (`src/quant/strategies/decisionGate.ts`):

| Score | Action |
|---|---|
| < 70 | **NO_TRADE** |
| 70–79 | **WATCH** |
| 80–89 | **TRADE_CANDIDATE** |
| ≥ 90 | **HIGH_CONVICTION** |

Every decision — including NO_TRADE — is logged with the full numeric reasoning (skew reading,
market regime, premium edge, IV rank, POP, risk/reward, liquidity tier, and the score itself),
visible in the dashboard's decision explanation and Activity Log.

### 2.7 Position sizing

Only run once a candidate clears the score threshold. Ten independent caps are each expressed as
"max lots this constraint alone would allow," and the **minimum across all ten** wins — a single
generous limit can never override a tighter one (`src/quant/strategies/positionSizing.ts`):

| Constraint | Default |
|---|---|
| Max risk per trade | 2% of equity |
| Max daily loss budget | 4% of equity |
| Max weekly loss budget | 8% of equity |
| Max portfolio risk (sum of open positions' max loss) | 10% of equity |
| Max margin utilization | 60% of available funds |
| Max concurrent open positions | 5 |
| Max net delta per underlying | ±300 |
| Max net gamma (whole portfolio) | ±50 |
| Max net vega (whole portfolio) | ±5000 |
| Max risk in a correlated group (e.g. NIFTY+BANKNIFTY pooled) | 6% of equity |

**Equity/available-funds source, by mode:**
- **PAPER** sizes against `reserved_fund`, a number you type into settings — there is no real
  balance to check it against.
- **AUTO** sizes against your **real, live Kite account balance**, fetched fresh every scan
  (`fetchRealAvailableFunds`). If that fetch fails for any reason, AUTO **refuses to size or place
  any order that cycle** rather than falling back to the self-declared `reserved_fund` number.

A per-lot margin requirement is fetched live from Kite's `/margins/basket` endpoint before sizing.
If sizing resolves to 0 lots, that is logged as a genuine NO_TRADE with the exact binding
constraint cited (e.g. "daily loss budget already exhausted").

### 2.8 Pre-trade validation

Immediately before execution, ten checks must all pass (`src/quant/execution/preTradeValidation.ts`):
market data freshness, market open, every leg resolved to a real tradingsymbol, sufficient margin,
risk limits (lots > 0), no duplicate position already open on the same symbol/expiry/strategy,
price slippage since scoring (max 1.5%), strategy still valid, Greeks within limits, and max-loss
recalculation drift (max 5%). One failed check blocks the whole trade.

### 2.9 Execution

- **PAPER**: every leg is filled instantly at the live quoted price
  (`src/quant/execution/paperFill.ts`).
- **AUTO**: real market orders are placed against Zerodha. **BUY (hedge) legs are filled first,
  confirmed COMPLETE, before the SELL (short) leg is placed** — this is deliberate, not incidental:
  firing the naked short first makes Zerodha demand full standalone margin (~₹1.5L/lot) before it
  can recognize the hedge is coming; firing the long leg first gets the position recognized as a
  hedged spread immediately (~₹30–45k/lot) (`src/quant/execution/liveFill.ts`).
- If any AUTO leg's closing/opening order doesn't confirm filled, the position is marked in a
  state that is **never auto-retried** — it requires manual reconciliation against the broker
  directly, so a partial failure can never silently double-execute.

## 3. Managing an open position (every 1 minute)

`handlePositionMonitor` re-quotes every leg of every ACTIVE position in one batched pass (bounded
API usage regardless of how many positions are open):

- **Live mark-to-market P&L** is computed and persisted every cycle using the **mid price** of the
  live bid/ask (falling back to last-traded price only when depth is unavailable) — the same
  pricing convention entry uses, so unrealized P&L is never mixing two different price bases.
- A **sanity bound** rejects an obviously-bad quote: cost-to-close can never legitimately exceed
  1.5× the structure's own (maxProfit + maxLoss) ceiling. If a re-quote implies more than that
  (a stale/erroneous print on a thin leg), that cycle is skipped entirely for that position rather
  than acting on the bad number.

### 3.1 Exit triggers, checked in this fixed priority order

(`src/quant/execution/exitEngine.ts`)

1. **SHORT_STRIKE_BREACHED** — underlying has reached a short strike. Checked first; real,
   immediate danger.
2. **STOP_LOSS_MAX_LOSS** — closing now would realize a loss at or beyond the structure's own
   defined max loss.
3. **STOP_LOSS_CREDIT_MULTIPLE** — cost to close has grown to **2× the credit collected** (default
   `stop_loss_credit_multiple = 2`) — a softer, earlier stop than waiting for the hard max loss.
4. **PROFIT_TARGET** — **50%** of max credit already captured (default `profit_target_pct = 50`) —
   don't hold for the last few rupees of theta.
5. **TIME_EXIT** — **≤ 2 DTE** remaining (default `time_exit_dte = 2`) — same gamma-risk window new
   entries are excluded from.

Any trigger closes the **entire** position (all legs), immediately, at the live re-quote (PAPER)
or via real closing market orders, hedge-first-out-of-danger sequencing (AUTO — shorts closed
before longs, since removing the unbounded-risk leg first matters most on exit too).

## 4. Daily risk lock

Checked **before** any live Kite call is even made, so a locked day costs nothing beyond one
database read (`src/quant/execution/dailyRiskLock.ts`):

- **MAX_DAILY_LOSS** — today's realized P&L has reached **−4% of equity** (`max_daily_loss_pct`).
- **MAX_CONSECUTIVE_LOSSES** — **3** consecutive losing closes in a row (`max_consecutive_losses`).

Once locked, **no new entries** are attempted for the rest of the day — but position-monitor keeps
running regardless, so open positions are still managed and can still be exited. The lock is never
auto-cleared; clearing it is a separate explicit action in the dashboard
(`resource=clear-daily-lock`).

## 5. What this system deliberately does NOT do

Documented directly in the code's own comments, not omissions discovered after the fact:

- No RSI/MACD/moving-average-style technical indicators drive entries.
- No event-risk calendar (earnings, RBI policy dates, expiry-week effects) — no data source exists
  for it yet.
- No historical-setup-performance component in the quality score — would require a backtest
  engine's track record, which exists (`src/options-auto/backtest/`) but isn't wired into live
  scoring.
- Market regime (trend/volatility/whipsaw) is computed and shown, but does **not** currently gate
  or block any trade — it's explicitly diagnostic-only today.
- Every threshold called out above as a "default" (skew band, delta targets, wing widths, quality
  weights, decision thresholds, risk limits, exit triggers) is stated in the code as a **provisional
  starting point pending real backtesting**, not a validated, tuned parameter. They're deliberately
  plain numbers specifically so they can be argued with and adjusted, not a black box.

## 6. Where to look in code

| Concern | File |
|---|---|
| All quant thresholds (spread/OI minimums, mark-price preference) | `src/quant/config.ts` |
| Skew → strategy selection | `src/quant/strategies/regimeSelect.ts` |
| Independent market regime (diagnostic only) | `src/quant/analytics/marketRegime.ts` |
| Strike/wing candidate generation + liquidity gate | `src/quant/strategies/strikeOptimizer.ts`, `src/quant/analytics/liquidity.ts` |
| Expiry comparison | `src/quant/strategies/expirySelector.ts` |
| Trade quality scoring | `src/quant/strategies/tradeQualityScore.ts` |
| NO_TRADE/WATCH/TRADE_CANDIDATE/HIGH_CONVICTION thresholds | `src/quant/strategies/decisionGate.ts` |
| Position sizing (10 caps) | `src/quant/strategies/positionSizing.ts` |
| Pre-trade validation | `src/quant/execution/preTradeValidation.ts` |
| Real order execution + BUY-before-SELL sequencing | `src/quant/execution/liveFill.ts` |
| Paper fill simulation | `src/quant/execution/paperFill.ts` |
| Exit triggers | `src/quant/execution/exitEngine.ts` |
| Daily risk lock | `src/quant/execution/dailyRiskLock.ts` |
| Orchestration (scan cron, monitor cron, settings) | `api/options-autotrade.ts` |
| Backtest engine (not wired into live scoring) | `src/options-auto/backtest/` |
