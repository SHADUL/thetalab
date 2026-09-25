# QUANT_AUDIT.md — Options Auto-Trader: Full Architecture & Correctness Audit

**Scope**: `src/quant/`, `src/options-auto/`, `src/options-auto/backtest/`, `api/options-autotrade.ts`.
**Method**: Read-only. No code was modified to produce this document. Every claim below is traced
to a specific file and line. Verdicts: **OK** / **CONCERN** / **BUG**.
**Posture**: This audit does not recommend any threshold change. Its only job is to establish
whether the system is measuring and executing itself honestly. Phases 1+ (from your instructions)
should not begin until you've reviewed this and told me which findings to act on first.

---

## Executive summary

The pricing core (Black-76, IV solver, forward derivation, skew, enrichment/data-quality gating) is
**unusually well-built** — correct sign conventions, no silent data fabrication anywhere, honest
"refuse rather than guess" discipline enforced consistently. That is the right foundation to build
the requested robustness program on top of.

Four findings actually matter, in order of severity:

1. **BUG — Iron Condor max-loss formula is wrong** (`src/quant/strategies/ironCondor.ts:153`).
   Overstates max loss on every condor, contaminating position sizing, the risk/reward score, and
   the stop-loss trigger threshold. **Confirmed by me, algebraically, below.**
2. **BUG (critical) — no idempotency key, no distributed lock, no broker-side reconciliation
   before placing or retrying a live order** (`api/options-autotrade.ts`, `handlePaperScan`'s AUTO
   path). Under a concurrent/overlapping cron invocation, this system can place **duplicate real
   orders** against your live Zerodha account. This is the highest-priority item in the entire
   16-phase plan you outlined — it's Phase 2 and Phase 17's core concern, and it's real today.
3. **CONCERN — paper/backtest fills are optimistic by construction**: every leg fills instantly at
   the exact quoted price, zero slippage, zero partial fills (`src/quant/execution/paperFill.ts`).
   This is honestly disclosed in the code's own comments, but it means **every net-expectancy number
   you've seen so far is a ceiling, not an estimate** — this is exactly why you asked for Phase 1
   (realistic execution modeling) and Phase 3 (net EV).
4. **CONCERN — realized-volatility annualization (252 trading days) is inconsistent with the rest
   of the pipeline's ACT/365 (calendar-day) convention** used by Black-76, `enrich.ts`, and expected
   move. This mismatch is small (factor of `sqrt(365/252) ≈ 1.204`) but flows directly into the
   premium-edge score, the independent EV model, and IV rank — three of the highest-weighted
   components in Trade Quality Score.

Nothing found rises to "the system is lying about its own profitability" — but finding #3 means the
system has never yet been tested against reality, and finding #2 means real capital is at
operational risk independent of whether the strategy itself has edge. Both should be fixed before
any of Phases 3–16 (which are about *finding* edge) are worth spending time on, because right now
neither the cost basis nor the execution safety is solid ground to build on.

---

## 1. Architecture audit

The pipeline is a clean, linear pipe with one good discipline running through it: **raw data →
normalize/enrich (never repair) → price → filter (hard gates) → score (soft signal) → decide → size
→ validate → execute → monitor → exit**, and almost every stage refuses to proceed on missing data
rather than substituting a guess. Concretely, verified end to end:

```
Kite /quote (live) or bhavcopy (EOD)
  -> src/quant/data/adapter.ts       (never defaults missing OI/price to 0)
  -> src/quant/enrich.ts             (forward, IV, Greeks; every fallback labeled with a DataIssue)
  -> src/quant/strategies/regimeSelect.ts   (skew -> Bull Put / Bear Call / Iron Condor)
  -> src/quant/strategies/strikeOptimizer.ts (delta x wing grid, HARD liquidity gate)
  -> src/quant/strategies/expirySelector.ts  (best expiry by EV/risk)
  -> src/quant/strategies/tradeQualityScore.ts (9-component 0-100 score)
  -> src/quant/strategies/decisionGate.ts     (NO_TRADE/WATCH/TRADE_CANDIDATE/HIGH_CONVICTION)
  -> src/quant/strategies/positionSizing.ts   (10 independent caps, min wins)
  -> src/quant/execution/preTradeValidation.ts (10 checks, one fail blocks all)
  -> src/quant/execution/liveFill.ts | paperFill.ts (BUY-before-SELL live sequencing)
  -> src/quant/execution/legFailureHandler.ts / stateMachine.ts (real partial-fill states)
  -> api/options-autotrade.ts: handlePositionMonitor (1-min re-quote, exitEngine.ts)
  -> src/quant/execution/dailyRiskLock.ts     (blanket entry refusal, never auto-clears)
```

The backtest engine (`src/options-auto/backtest/`) is a **separate, disconnected** pipeline that
reimplements pricing/scoring against bhavcopy EOD data rather than reusing the live scan's exact
code path — meaning a change to the live scoring logic (`tradeQualityScore.ts`, `regimeSelect.ts`)
does **not** automatically get re-validated by the backtester unless someone manually keeps
`simulate.ts` in sync. This is a structural gap worth naming even though it isn't a "bug": the
backtest is currently a *parallel* implementation, not a *replay* of the same production code. Any
serious net-expectancy research program (your Phases 3–13) will produce more trustworthy answers if
`simulate.ts` is refactored to call the SAME `enrich.ts` / `strikeOptimizer.ts` / `tradeQualityScore.ts`
functions the live scan uses, rather than its own re-derivation. I have not verified whether
`simulate.ts` currently duplicates or actually imports this logic — that's the first thing to check
before trusting any backtest number as representative of what the live system would have done.

**Modes that exist today**: `OFF`, `PAPER`, `AUTO` (`options_autotrade_settings.execution_mode`).
There is no `SHADOW`, `ALERT_ONLY`, or `SEMI_AUTO` wired into the actual dispatch logic despite the
DB comment listing them as intended values (`schema.sql:43`) — Phase 14's `SHADOW` mode is a real
gap to build, not a rename.

---

## 2. Bugs / mathematical issues

### 2.1 BUG (confirmed) — Iron Condor max-loss formula

**File**: `src/quant/strategies/ironCondor.ts:153`
```ts
const maxLossPerUnit = Math.max(callWidth - callCredit, putWidth - putCredit);
```

**Correct formula**: `Math.max(callWidth, putWidth) - netCredit`.

**Proof**: at expiry, only one side can be breached. If the call side is breached (spot far above
the long call strike), the put spread expires worthless and its *entire* credit (`putCredit`) is
retained; the call spread loses `callWidth - callCredit`. Total P&L =
`putCredit - (callWidth - callCredit) = -(callWidth - callCredit - putCredit) = -(callWidth - netCredit)`.
So true max loss on a call-side breach is `callWidth - netCredit`, not `callWidth - callCredit`. The
current code subtracts only the call side's own credit, ignoring the credit banked on the (expiring
worthless) put side — it **overstates** max loss on both sides by exactly the other side's credit.

**Numeric example**: 200-pt-wide condor both sides, call credit 30, put credit 40 (net credit 70).
True max loss = 200 − 70 = **130**. Code reports `max(200−30, 200−40) = max(170, 160) = **170**` —
overstated by 40 (exactly the put-side credit).

**Downstream contamination** (all confirmed by tracing the call sites):
- `positionSizing.ts`'s `maxRiskPerTrade`/`maxDailyLoss`/`maxPortfolioRisk` constraints all divide a
  budget by `perLotMaxLoss` — an inflated max loss makes every Iron Condor **undersized** relative to
  its true risk (conservative-direction error, not dangerous, but wrong).
- `tradeQualityScore.ts`'s `riskReward = maxProfit/maxLoss` scores every Iron Condor candidate worse
  than it actually is — this is a **systematic bias against Iron Condors specifically** in the
  scoring/ranking step (credit spreads use `creditSpread.ts`'s correctly-computed single-sided
  `maxLoss = width - netCredit` and are unaffected).
- `strikeOptimizer.ts`'s `evPerUnitRisk = expectedValue / maxLoss` ranking is understated for condors
  for the same reason — condors can lose EV-ranking ties to credit spreads they should win.
- `exitEngine.ts`'s `STOP_LOSS_MAX_LOSS` trigger (`currentCostToClose - maxProfit >= maxLoss`) fires
  later than the true structural max loss would justify, because the threshold itself is inflated —
  the "defined max loss" shown to you and used as a hard stop is not actually the position's real
  worst case.

**This is a real bug that should be fixed before any of the requested research phases (4–13) run**,
since research phases 6–8 compare Iron Condor performance against credit spreads, and this bug
currently biases that exact comparison.

### 2.2 CONCERN — realized volatility uses 252-day annualization; rest of pipeline uses ACT/365

**Files**: `src/quant/analytics/realizedVolatility.ts:40` (`Math.sqrt(variance) * Math.sqrt(252)`)
vs. `src/quant/enrich.ts:32,35-37` (`MS_PER_YEAR = 365*...`, explicit "ACT/365 year fraction") and
`src/quant/pricing/black76.ts:37` ("Time to expiry in years, ACT/365").

`distributionModel.ts:78` then de-annualizes the 252-based number with a 365-day divisor:
`sigmaHorizon = realizedVol.annualizedVol * Math.sqrt(horizonDays / 365)`. Mixing a 252-trading-day
annualization with a 365-calendar-day de-annualization understates/overstates horizon volatility by
`sqrt(365/252) ≈ 1.204×` depending on direction of the round-trip — a real, if modest, inconsistency.

**Why it matters**: this number feeds `premiumEdge` (20% weight) and `independentEv` (20% weight) in
Trade Quality Score — the two highest-weighted components — plus the independent POP model's normal
fallback. A ~20% systematic skew in "how volatile has this underlying really been" pushes the two
primary edge signals in a consistent direction every single time, not randomly — worth fixing before
trusting any of the Phase 4–8 research that compares thresholds against this signal.

**Recommended fix (not yet made)**: standardize on ACT/365 everywhere (matches Black-76/enrich.ts,
and matches how DTE/IV are already quoted), i.e. change `realizedVolatility.ts:40` to
`Math.sqrt(variance) * Math.sqrt(365)`. This is a one-line, low-risk fix but changes every historical
premium-edge/IV-rank number, so it should ship with a before/after comparison, not silently.

### 2.3 CONCERN — DTE calendar basis inconsistency in the backtester

**File**: `src/options-auto/backtest/simulate.ts:170` computes DTE from UTC midnight of both dates,
while the same position's entry-side pricing (`buildChainPayload`, `simulate.ts:94`) is anchored to
15:30 IST. Internally consistent for the one line it's used on (whole-day delta), but inconsistent
with the live system's own DTE convention (which flows from `enrichChain`'s IST-anchored `T`). Effect
is at most ±1 day at a boundary — not a look-ahead bias, but worth aligning before DTE-bucketed
research (Phase 6) runs, since a systematic 1-day skew at bucket boundaries (e.g., 7d vs 8d bucket)
could misclassify trades right at the edges of your requested DTE buckets.

### 2.4 No look-ahead bias found in the backtest's entry/exit sequencing

Specifically checked and **not found**: using day `i`'s close to decide day `i`'s entry (entry uses
only that day's own bhavcopy row); an off-by-one in the exit re-quote loop (each day's re-quote uses
that same day's data, never a future day); `DATA_END` forced closes leaking into real-outcome
statistics (`metrics.ts` explicitly excludes them from every stat). This is good news — Phase 12's
walk-forward validation has a sound point-in-time foundation to build on, once §2.1 and §2.2 are
fixed.

### 2.5 CONCERN — overlapping-window statistics overstate sample independence

**Files**: `realizedVolatility.ts:63` (`computeExpectedRealizedMove`) and `distributionModel.ts:47`
(`buildEmpiricalReturns`) both build their sample from **every overlapping `horizonDays`-forward
window** in history. This is standard practice and not wrong per se, but the resulting "sample count"
(e.g., 500 overlapping 20-day windows from 3 years of daily closes) vastly overstates the number of
*independent* observations behind the read — roughly `sampleCount / horizonDays` non-overlapping
periods actually exist. This doesn't bias the point estimate, but it means the model's own confidence
in that estimate (and by extension, the Trade Quality Score's treatment of a "252-sample" IV rank or
"500-observation" independent POP as if it were 252/500 independent trials) is overstated. Relevant
directly to Phase 12/13's request for genuine out-of-sample robustness — a Monte Carlo or
walk-forward validation that resamples these overlapping windows as if independent will understate
its own confidence interval.

---

## 3. Execution risks

### 3.1 BUG (critical) — no idempotency, no distributed lock, no broker reconciliation before a live order

**File**: `api/options-autotrade.ts`, `handlePaperScan`'s AUTO branch (~lines 784–925), confirmed by
exhaustive search: no unique DB constraint, advisory lock, `SELECT ... FOR UPDATE`, idempotency key,
or mutex of any kind exists anywhere in this file. The only "lock" concept present is
`checkDailyRiskLock` — a **risk-budget** gate, not a **concurrency** gate; it does nothing to stop
two overlapping invocations from both passing it.

**Exact failure mode**: the "duplicate position" check (`duplicateExists`, line 791) reads currently-
`ACTIVE` rows **once**, at the start of the scan. Between that read and the actual `INSERT` of the
new position (line 902), the code makes a live margin call, a live funds check, and — for AUTO — the
full multi-leg live order sequence (`runLiveExecution`), which itself spans multiple `await`s per leg
(quote fetch, place, poll-until-filled up to 15s, across up to `maxRetries+1` passes). For a 4-leg
iron condor this routinely spans tens of seconds, comfortably inside the function's own configured
60s `maxDuration` (`vercel.json`). **If this endpoint is invoked twice concurrently for the same
symbol** — an overlapping/retried cron trigger, a manual re-trigger while a slow scan is still
running, or a platform-level retry on a timeout — both invocations can independently see "no active
duplicate," both can pass every check, and **both can place real, duplicate multi-leg option orders
against the live account**, doubling real capital exposure with nothing in the code preventing it.
There is also no step anywhere that checks Kite's actual live `/orders` or `/positions` before
entering or retrying — the system only ever reasons about its own Supabase table and about fills
*within the current call*, never against the broker's independent source of truth.

This is squarely what your Phase 2 and Phase 17 exist to fix, and it is not hypothetical — cron-job.org's
own recent behavior in this project (retried/overlapping triggers after the auth-gate incident) shows
overlapping invocations do happen in practice, not just in theory.

### 3.2 CONCERN — `liveFill.ts` itself is correct; the gap is entirely in the caller

Verified `src/quant/execution/liveFill.ts` does its own job well: always resorts unfilled legs
BUY-before-SELL on every pass (matches the margin-sequencing requirement `ironCondor.ts`/`creditSpread.ts`
flag in their own comments), fetches a fresh quote before every single order and refuses if it's
stale/missing or has drifted >50% from the modeled price, blocks all later legs in a pass once one
leg fails, and on retry exhaustion actively unwinds every filled leg with MARKET orders while logging
"THIS LEG MAY STILL BE OPEN AT THE BROKER. Manual check required immediately." None of this helps
with §3.1, because this file only ever reasons about orders placed *within its own single call* — the
idempotency/lock guarantee has to live one layer up, in the caller.

### 3.3 OK — partial-fill states are real, not decorative

`legFailureHandler.ts` and `stateMachine.ts` were both verified to have genuine terminal states
(`PARTIALLY_FILLED`, `RECONCILIATION_REQUIRED`) that are never silently mapped to `FILLED`/`ACTIVE`/
`CLOSED`, and the retry loop is leg-status-gated (only ever re-attempts legs still unfilled), so a
retry cannot re-place an order for an already-filled leg. Good news for Phase 2's "never duplicate an
order because of retry" requirement — half of that requirement (retry-safety within one invocation)
is already met; the other half (§3.1, cross-invocation safety) is not.

### 3.4 OK — fail-closed behavior on stale/missing data, verified across every handler checked

`handleMargin`, `handleInstrumentsSync`, `fetchRealAvailableFunds`, `fetchHistoricalCloses` were all
checked for a stale-data fallback and none was found: each either fails closed (`502`/refusal) or
returns `null`/`[]` with the caller explicitly treating that as "exclude this signal," never as
"substitute a cached number." The 96-hour instrument-master staleness hard-block (already shipped,
`handlePaperScan` lines 566–574) is real and does what its comment claims.

---

## 4. Data-quality risks

- **Instrument master refresh cadence**: currently a 96-hour hard block, not a same-day requirement.
  Your Phase 11 ask ("do not consider a 96-hour-old derivatives master acceptable for AUTO") is a
  legitimate tightening — 96h is a "long-weekend-plus-holiday" safety margin, not a freshness target.
  Recommend a stricter same-trading-day check specifically gating AUTO (PAPER can keep the wider
  margin), independent of whether the daily sync cron itself is healthy.
- **No historical option-chain snapshot store exists today.** The system fetches live quotes for
  scanning/monitoring and discards them; `historicalCloses` (underlying closes only, not the option
  chain) is the only persisted history. Phase 11's request to start building a real historical
  options database is a genuine gap, not a preference — without it, DTE/delta/regime research
  (Phases 6–8) can only ever be backtested against bhavcopy EOD settlement data, not real intraday
  bid/ask/depth, which is a materially different (and more optimistic) data source than what AUTO
  actually trades against.
- **Bhavcopy is EOD-only, settlement-priced, no bid/ask.** This is honestly reflected throughout
  (`tradeQualityScore.ts`'s liquidity scorer explicitly handles spread-unavailable EOD data as a
  separate case, not a fabricated 0% spread) — but it means the *existing* backtester cannot ever
  produce a REALISTIC-mode fill simulation (Phase 1) on its own; that requires the new live-snapshot
  store, not a retrofit of bhavcopy data.
- **IV history archive (`buildIvHistory.ts` / `loadIvHistory`) stores one near-term ATM-IV point per
  session** (already flagged in the code's own comments, `expirySelector.ts:59-64`) — same single
  reading applied to every expiry evaluated in a scan, not a genuine per-expiry-tenor IV history. Not
  a bug, but a real limitation on how much to trust `ivRank` as expiry-specific.

---

## 5. Backtest weaknesses

1. **Not look-ahead biased** in its day-by-day walk (verified, §2.4) — this is the right foundation.
2. **Disconnected from the live scoring code** (§1) — currently a parallel reimplementation, not a
   replay of `tradeQualityScore.ts`/`regimeSelect.ts`/`strikeOptimizer.ts`. Needs verification (and
   likely refactoring) before any Phase 4–8 research result can be trusted as representative of what
   the live system would actually have done.
3. **Fill assumption is the live system's own optimistic PAPER assumption**, not a third, more
   pessimistic backtest-specific model — meaning the backtest and PAPER mode share the exact same
   blind spot (§2 above, paperFill.ts). This is precisely why Phase 1's IDEAL/REALISTIC/STRESS modes
   need to exist and be wired into both the backtester and PAPER, not just one of them.
4. **Costs are a static, disclosed approximation** (`costs.ts`) — six charge categories are genuinely
   implemented (brokerage, STT, exchange charges, GST, stamp duty, SEBI charges), none hardcoded to
   zero, but the code's own header invites verification against a live contract note before trusting
   absolute magnitudes, and the GST base (`brokerage + exchangeTxn` only) should be checked against
   whether your actual broker also charges GST on SEBI fees.
5. **Sharpe/Sortino are per-trade, not daily-equity-curve-based** (`metrics.ts`, honestly disclosed
   in its own header) — not wrong, but not the textbook definition either; fine for now, worth
   revisiting if Phase 16's dashboard reports these numbers next to industry-standard benchmarks.
6. **Overlapping-window statistical confidence is overstated** (§2.5) — relevant to how much weight
   Phase 12's Monte Carlo/walk-forward results should be given.

---

## 6. Proposed database migrations (not yet written)

For the phases you outlined, at minimum:
- `options_autotrade_settings.execution_mode` gains `SHADOW` as a valid value (currently only
  `OFF|PAPER|AUTO` are actually dispatched in `handlePaperScan`, despite the schema comment already
  listing `ALERT_ONLY|SEMI_AUTO`).
- A new `options_autotrade_order_intents` (or similarly named) table: one row per *attempted* entry,
  inserted **before** any live order is placed, with a unique constraint on
  `(symbol, expiry, strategy_label, trade_date)` — this becomes the actual concurrency lock for
  §3.1, not an application-level check-then-act read.
- A new `options_chain_snapshots` table (Phase 11): timestamped, storing spot/forward/VIX/expiry/
  strike/right/bid/ask/depth/LTP/volume/OI/IV/Greeks per scan — the foundation for a real historical
  options research database, distinct from the underlying-only `historicalCloses`.
- A new `options_autotrade_execution_log` table (Phase 1/3): one row per *leg fill attempt* (not just
  successful fills), recording `decision_mid, submitted_price, filled_price, slippage_rupees,
  slippage_bps, spread_at_entry, latency_ms`, plus the six cost components — this is what makes NET
  P&L (vs. gross) auditable per trade, not just aggregated.
- A new `skew_observations` table (Phase 4): `symbol, timestamp, dte_bucket, vix_regime, raw_rr25` —
  needed before any rolling z-score/percentile skew-threshold research can run at all.
- A new `risk_profile` config table or column set (Phase 15) so CONSERVATIVE/BALANCED/CURRENT can be
  swapped for research without touching the live `options_autotrade_settings` row.

I have not written any of these migrations yet — they're listed here for you to sequence against the
existing `src/options-auto/migrations/00N_*.sql` numbering before Phase 1 implementation starts.

---

## 7. Proposed files/modules (not yet written)

- `src/quant/execution/fillSimulator.ts` — IDEAL/REALISTIC/STRESS fill modes (Phase 1), replacing
  `paperFill.ts`'s single optimistic path; `paperFill.ts` itself likely becomes the IDEAL mode.
- `src/quant/execution/orderLock.ts` — the concurrency-lock primitive for §3.1 (Phase 2/17), backed
  by the new `options_autotrade_order_intents` table.
- `src/quant/execution/brokerReconciliation.ts` — pre-entry and pre-retry checks against Kite's live
  `/orders` and `/positions` (Phase 2/17).
- `src/quant/analytics/skewNormalization.ts` — rolling z-score/percentile/DTE-bucketed/symbol-specific
  skew models (Phase 4), alongside (not replacing) `regimeSelect.ts`'s current fixed threshold.
- `src/options-auto/backtest/netExpectedValue.ts` — gross-EV to net-EV conversion (Phase 3), consuming
  `costs.ts` plus a fill-simulator-derived slippage estimate.
- `src/options-auto/research/` — a new directory for the Phase 4–8 experiment scripts (DTE buckets,
  delta/wing grid, exit-parameter research, regime-filter backtests) — kept clearly separate from
  the production `src/quant/` engine so research code never accidentally becomes a live dependency.
- `api/options-autotrade-research.ts` (or a `resource=` addition to the existing file, to stay under
  Vercel's function cap) — serves the Phase 16 dashboard's research endpoints, reading from the new
  tables rather than recomputing on every page load.

---

## 8. Implementation sequence (proposed, awaiting your go-ahead)

Given the two BUGs found, I'd sequence the work differently from strict phase-number order:

1. **Fix §2.1 (Iron Condor max loss)** — a contained, mechanically-verifiable one-line fix plus a
   regression test asserting the algebraic identity (`maxLoss == max(callWidth,putWidth) - netCredit`
   and `maxProfit + maxLoss == max(callWidth,putWidth)` for symmetric wings). Low risk, high value,
   unblocks trustworthy Iron-Condor-vs-spread comparisons for later phases.
2. **Fix §3.1 (concurrency/idempotency)** — before anything else touches AUTO. This is Phase 2/17's
   core and should not wait for the research phases, since it's an operational risk independent of
   strategy quality. Implemented as the `order_intents` table + lock, PAPER/AUTO both exercised,
   tested by deliberately firing two overlapping invocations against a test Supabase project.
3. **Build Phase 1 (fill simulation modes) + Phase 3 (net EV)** together, since net EV is meaningless
   without a realistic cost/slippage model to subtract. Ship as a new diagnostic field alongside the
   existing gross metrics — never replacing them until validated.
4. **Fix §2.2 (RV annualization)** — small, mechanical, but should ship with an explicit before/after
   comparison of premium-edge/IV-rank numbers so you can see exactly what changes.
5. Then Phases 4–13 (skew normalization, regime experiment, DTE segmentation, delta/wing research,
   exit research, correlation/stress testing, event-safety, data quality, backtest validation,
   parameter robustness) — in whatever order you prefer, all in PAPER/research mode, all behind
   feature flags, none touching AUTO defaults until validated per your own Phase 13 robustness bar.
6. Phase 14 (SHADOW mode) as soon as the execution-log schema (#6 above) exists — it's cheap to add
   once the logging infrastructure from step 3 is in place.
7. Phase 15 (risk profiles) and Phase 16 (dashboard) last — they're presentation/configuration layers
   over data that only becomes meaningful once steps 1–4 are done.

Every step above: TypeScript/build check, unit tests, strategy tests, regression tests, feature-flagged,
PAPER/SHADOW-only until you explicitly enable AUTO for that specific change. Nothing changes the live
production default without your explicit sign-off, per your own instructions.

---

## Appendix — per-file verdicts (mine + delegated audit combined)

| File | Verdict | Note |
|---|---|---|
| `src/quant/pricing/black76.ts` | OK | Verified personally: correct d1/d2, sign conventions, theta/day, vega/1.0vol, rho=-T·price. |
| `src/quant/analytics/atmIv.ts` | OK | Verified personally. |
| `src/quant/analytics/skew.ts` | OK | Verified personally: riskReversal=call−put sign matches regimeSelect.ts's bullish/bearish labeling. |
| `src/quant/analytics/expectedMove.ts` | OK | |
| `src/quant/analytics/realizedVolatility.ts` | **CONCERN** | 252 vs 365 annualization mismatch — §2.2. |
| `src/quant/analytics/distributionModel.ts` | OK | Inherits §2.2's concern; never falls back to Black-76 POP — verified. |
| `src/quant/analytics/ivRank.ts` | OK | |
| `src/quant/strategies/creditSpread.ts` | OK | maxLoss = width − netCredit, correctly single-sided. |
| `src/quant/strategies/ironCondor.ts` | **BUG** | §2.1 — max-loss formula. |
| `src/quant/strategies/regimeSelect.ts` | OK | |
| `src/quant/strategies/strikeOptimizer.ts` | OK | Hard liquidity gate confirmed to reject before scoring, not just discount. |
| `src/quant/strategies/expirySelector.ts` | OK | |
| `src/quant/strategies/tradeQualityScore.ts` | OK | Weights are self-documented as provisional; math is internally consistent. |
| `src/quant/strategies/decisionGate.ts` | OK | |
| `src/quant/strategies/positionSizing.ts` | OK | 10 independent caps, min-wins, correctly implemented. |
| `src/quant/execution/preTradeValidation.ts` | OK | |
| `src/quant/execution/exitEngine.ts` | OK | Priority order matches header; formulas check out. |
| `src/quant/execution/dailyRiskLock.ts` | OK | |
| `src/quant/execution/liveFill.ts` | CONCERN | Correct in scope; idempotency gap belongs to caller (§3.1). |
| `src/quant/execution/paperFill.ts` | CONCERN | Explicitly optimistic, honestly disclosed — §2/Executive Summary #3. |
| `src/quant/execution/legFailureHandler.ts` | OK | |
| `src/quant/execution/stateMachine.ts` | OK | Real terminal states, no silent success mapping. |
| `src/quant/enrich.ts` | OK | Best-disciplined file in the codebase; verified personally. |
| `src/quant/types.ts` | OK | |
| `src/quant/data/adapter.ts` | OK | Never defaults missing OI/price to 0. |
| `src/options-auto/backtest/simulate.ts` | CONCERN | §2.3 DTE basis; no look-ahead bias found (§2.4). |
| `src/options-auto/backtest/costs.ts` | CONCERN | All 6 charges present; verify current rates (self-disclosed). |
| `src/options-auto/backtest/metrics.ts` | OK | Per-trade Sharpe approximation, honestly disclosed. |
| `src/options-auto/backtest/bhavcopy.ts` | OK | |
| `src/options-auto/scripts/runBacktest.ts` | OK | |
| `api/options-autotrade.ts` | **BUG** | §3.1 — critical concurrency/idempotency gap. |

No files were modified to produce this audit.
