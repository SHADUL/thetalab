# EXECUTION_AND_PARITY_REPORT.md

**No strategy parameters were changed to produce this report.** Delta targets, skew threshold, wing
widths, DTE limits, quality thresholds, profit target, stop loss, and risk percentages are all
untouched production defaults throughout. This report exists to answer one question honestly:
**is PAPER/BACKTEST performance now an honest approximation of what AUTO could actually achieve** —
not to make the strategy look better.

## 0. Data actually available (read this before anything else)

- **NIFTY**: 646 real NSE trading sessions, 2024-02-01 through 2026-09-15, from real UDiFF F&O
  bhavcopy files already cached in this repo (`src/options-auto/backtest/.bhavcopy-cache/`).
- **BANKNIFTY, SENSEX**: **no real historical data available.** No cache exists, and this sandbox's
  network access to NSE/BSE archives is blocked (confirmed: `archives.nseindia.com` refuses the
  connection; general internet access otherwise works). **Every result below is NIFTY-only.** No
  BANKNIFTY/SENSEX claim is made anywhere in this report, per the instruction not to force a
  conclusion the data doesn't support.
- **Historical IV**: `src/quant/data/history/atm_iv_nifty.json` is **empty**. `ivRank` is
  `UNAVAILABLE` for every single trade below — never fabricated, correctly excluded from the score
  (Trade Quality Score's weights renormalize around the remaining 8 components).
- **Historical bid/ask**: bhavcopy is settlement-only. Every REALISTIC/STRESS slippage number below
  comes from a **stated, assumed** spread model (`fillSimulator.ts`'s `assumedSpreadPctWhenUnknown`
  = 2%/5%), not a measured historical spread. This is the single biggest source of uncertainty in
  this report — see §11.
- **Historical margin**: no real historical Kite margin exists. Position sizing below uses
  `HISTORICAL_MODEL` (margin ≈ maxLoss, a standard defined-risk-spread approximation), never
  `LIVE_KITE`.

## 1. Files changed / added this phase

New: `src/quant/execution/fillSimulator.ts`, `src/quant/analytics/ivRankHistory.ts`,
`src/quant/analytics/timeConventions.ts` (prior phase, reused here). Modified (additively — see §2):
`src/quant/strategies/expirySelector.ts` (volatility horizon fix), `src/quant/analytics/distributionModel.ts` /
`realizedVolatility.ts` (unit-labeling + de-annualization fix), `src/options-auto/backtest/costs.ts`
(versioned rates + `computeTradeCostBreakdown`), `src/options-auto/backtest/simulate.ts` (new
`simulateSymbolRealistic` export, `simulateSymbol` **completely unchanged**). New tests: 8
(`volatilityHorizonFix.test.ts`), 10 (`fillSimulator.test.ts`), 5 (`ivRankHistory.test.ts`), 6
(`simulateRealistic.test.ts`) — 29 new tests this phase, on top of the 8 from the prior safety phase.

## 2. Migrations

None required for this phase — no new database tables. (The prior phase's `008_order_intents.sql`
remains **unapplied to production** — see §9, unchanged from last report.)

## 3. Tests added / results

**308 quant tests pass** (293 from the prior phase + 15 new this phase: 10 `fillSimulator.test.ts` +
5 `ivRankHistory.test.ts`; the volatility-horizon-fix tests were already counted in the 293), **30
options-auto tests pass** (24 existing, untouched + 6 new for `simulateSymbolRealistic`).
`quant:typecheck` and `options-auto:typecheck` both clean. `vite build` clean.

```
quant tests:        308 pass, 0 fail
options-auto tests:  30 pass, 0 fail
```

## 4. Volatility fix — before/after

Already delivered and documented in `VOLATILITY_FIX_COMPARISON.md` (previous message). Summary: across
8 evenly-spaced real NIFTY dates, the fix raised `premiumEdge`/`independentEV` at every single sample,
moving the decision from NO_TRADE to at least WATCH in all 8 cases. **Not repeated in full here** —
see that file. The real backtest in §7 below runs with the fix already applied (it's simply how
`expirySelector.ts` behaves now).

## 5. Backtest/live parity — before/after

**Before** (per `BACKTEST_LIVE_PARITY.md`): `historicalCloses`/`ivRank` never wired into
`simulateSymbol`'s entry evaluation → `premiumEdge`/`independentEv`/`ivRank` excluded from every
backtested Trade Quality Score, 100% of the time. Position sizing and daily-risk-lock never
exercised — every signal traded exactly 1 lot regardless of account state.

**After** (`simulateSymbolRealistic`): real, **point-in-time-sliced** `historicalCloses` wired
through (verified never-leaks-the-future by `ivRankHistory.test.ts`'s explicit leakage-guard tests
applying the same discipline). In the real 646-day NIFTY run below, `premiumEdge` and
`independentEv` were available and used for essentially every trade (real closes existed from day
1 of the cache); `ivRank` was unavailable for 100% of trades (empty archive — honest, not
fabricated). Position sizing now uses the real `computePositionSize` (10-constraint) against a
stated starting equity; the daily risk lock now genuinely runs.

## 6. Execution-model assumptions

| Mode | Spread fraction applied | Assumed spread when no real bid/ask | Extra slippage | Latency | Legging stress |
|---|---|---|---|---|---|
| IDEAL | 0 (midpoint) | 0% | none | 0ms | none |
| REALISTIC | 0.5 (half the spread) | 2% of price | none | 800ms | none |
| STRESS | 0.8 × 1.75 multiplier | 5% of price | none | 3000ms | growing adverse move per later leg |

Every fill was **EOD_APPROXIMATION** in this run (bhavcopy has no real bid/ask) — REALISTIC/STRESS
numbers below reflect the ASSUMED spread model above, not a measured one. `slippageConfidence` is
labeled `LOW` throughout for exactly this reason.

## 7. Cost assumptions

Zerodha-style F&O rates, effective 2024-10-01 (`RATE_HISTORY` in `costs.ts`): ₹20/order brokerage,
0.1% STT (sell side), 0.0325% exchange charges (both sides), ₹10/crore SEBI, 0.003% stamp duty (buy
side), 18% GST on (brokerage + exchange charge). Applied uniformly across the whole 2024-02 to
2026-09 run, including the ~8 months before this rate regime's own stated effective date — a
disclosed approximation (no earlier rate regime is modeled).

## 8. IDEAL / REALISTIC / STRESS results — real NIFTY data, identical 112-trade sequence

**Unsized (1 lot per signal, so all three modes trade the exact same entries/exits — isolates pure
execution-friction sensitivity, per Phase 12's intent):**

| Metric | IDEAL | REALISTIC | STRESS |
|---|---|---|---|
| Trades (real, excl. DATA_END) | 112 | 112 | 112 |
| Win rate | 86.6% | 86.6% | 75.9% |
| Gross P&L | ₹2,01,009 | ₹2,01,009 | ₹2,01,009 |
| Total cost (statutory + slippage) | ₹17,461 | ₹34,386 | ₹1,14,180 |
| **Net P&L** | **₹1,83,548** | **₹1,66,623** | **₹86,829** |
| Expectancy/trade | ₹1,638.82 | ₹1,487.70 | ₹775.26 |
| Profit factor | 10.43 | 8.10 | 3.03 |
| Avg cost/credit | 8.5% | 14.1% | **40.1%** |
| Max drawdown (₹, 1 lot) | ₹2,761 | ₹3,210 | ₹8,092 |
| Max consecutive losses | 1 | 1 | 4 |

**EDGE RETENTION** (REALISTIC expectancy / IDEAL expectancy): **0.908** — the strategy retains ~91%
of its theoretical edge under a stated-realistic execution-friction assumption. This is a genuinely
good result, not a cherry-picked one — it's the whole, unfiltered 112-trade real sample.

**STRESS SURVIVAL** (STRESS net expectancy): **+₹775.26/trade — still positive**, but retains only
~47% of the IDEAL edge, and the average cost/credit ratio (40%) crosses into territory the task
itself flagged as worth researching for small-credit spreads specifically.

## 9. Position sizing / daily-lock parity — a real, important finding

With real `computePositionSize` wired in (₹10,00,000 stated starting equity, production's own
unmodified default risk limits) and REALISTIC fills: cumulative net P&L over the full 2.5-year run
was **₹16,96,113** (finishing all 112 trades — the lock was never triggered under REALISTIC
assumptions), a healthy result.

**Under the identical setup but STRESS fills**, the daily-risk-lock's `maxConsecutiveLosses = 3`
threshold was reached on **2024-10-22**, after only **37 of 112** trades. Because the production
daily lock is designed to **never auto-clear** (a deliberate, documented "requires manual
re-enable" safety property — correct for a live system with a human operator), and this backtest
has no human to clear it, **the simulated account never traded again for the remaining ~23 months
of real market data** — even though the STRESS-mode expectancy across the *full* 112-trade sample
(§8) was still net positive. This is not a bug in the strategy or in the lock — it is a genuine,
disclosed interaction: a bad early streak under adverse-enough execution assumptions, combined with
a lock that correctly refuses to self-heal, can end a real account's trading for good until someone
intervenes. That is exactly the kind of thing this phase exists to surface, not hide.

## 10. Net EV / cost-to-credit diagnostics

`netEvAtEntry` was computed and stored for every trade (feature-flagged, `USE_NET_EV_RANKING = false`
throughout — never used to pick a different candidate than `decideTrade()` already selected).
Average cost-to-credit ratio: **8.5% (IDEAL) / 14.1% (REALISTIC) / 40.1% (STRESS)** — confirming the
task's own expectation that this ratio is highly sensitive to execution assumptions and worth
watching closely before any future work on smaller-credit structures.

## 11. Breakdown by strategy (REALISTIC, unsized)

| Strategy | Trades | Win rate | Net P&L | Expectancy/trade | Profit factor | Max DD |
|---|---|---|---|---|---|---|
| Iron Condor | 42 | 88.1% | ₹82,068 | ₹1,954.01 | 17.73 | ₹2,881 |
| Bull Put Spread | 30 | 86.7% | ₹45,684 | ₹1,522.78 | 14.25 | ₹1,370 |
| Bear Call Spread | 40 | 85.0% | ₹38,871 | ₹971.77 | 3.57 | ₹6,032 |

Iron Condor (the structure directly affected by this phase's earlier max-loss formula fix) shows
the strongest per-trade expectancy and profit factor of the three in this real sample. Bear Call
Spread shows the weakest profit factor and largest drawdown — worth watching, not acted on here (no
parameter optimization in this phase).

**BANKNIFTY / SENSEX: not run. No real historical data available (§0).**

## 12. Remaining live/backtest differences

- Margin is `HISTORICAL_MODEL` (≈ maxLoss), never `LIVE_KITE` — real Kite basket margin can differ
  meaningfully from this proxy, especially for calendar/diagonal-adjacent structures this system
  doesn't currently build, but plausibly also for simple verticals under margin-benefit rules.
- `marginEfficiency` (Trade Quality Score's smallest-weighted component, 4/100) is excluded from
  every backtested score for the same reason.
- `ivRank` is `UNAVAILABLE` for 100% of trades — a real component of the live score that this
  backtest has never once exercised.
- Correlated multi-symbol portfolio risk (Phase 9 of the SAFETY audit) is not modeled here —
  this backtest still runs one symbol, one position at a time.
- The assumed spread model (§6) has not been validated against any real historical bid/ask — it is
  a stated, disclosed assumption, not a measurement.

## 13. Data-quality limitations (repeated from §0 for visibility)

Pricing data: `EOD_SETTLEMENT`. Bid/ask: `UNAVAILABLE`. Execution: `EOD_APPROXIMATION`. Historical
IV: `UNAVAILABLE`. Margin: `HISTORICAL_MODEL`. Slippage confidence: `LOW`. Symbols covered:
`NIFTY only`. Walk-forward TRAIN/VALIDATE/TEST split: **not yet run** (Phase 14's foundation exists —
`timeConventions.ts`/point-in-time slicing — but no actual train/validate/test partition of this
646-day sample has been executed in this phase).

## 14. Critical acceptance test

**"Does the existing strategy still demonstrate positive NET expectancy under realistic execution
assumptions?"**

**Answer: INSUFFICIENT DATA — for the system as a whole.** But that verdict should not obscure what
the real evidence actually shows, so stated precisely:

- **For NIFTY specifically**, under the REALISTIC assumption set used in this report, on the full,
  unfiltered, real 646-day sample available: **yes, positive net expectancy was found**
  (₹1,487.70/trade, profit factor 8.1, 90.8% edge retention vs. the theoretical IDEAL ceiling), and
  it **remained positive even under the deliberately pessimistic STRESS assumptions**
  (₹775.26/trade, profit factor 3.0), though with materially worse cost-to-credit (40%) and drawdown
  characteristics, and an important real interaction with the daily-risk-lock design (§9).
- The overall verdict is **INSUFFICIENT DATA, not YES**, for three specific, stated reasons: (1)
  **two of the three symbols this system actually trades (BANKNIFTY, SENSEX) have zero real
  historical verification** in this pass — no claim is made about them; (2) the REALISTIC/STRESS
  slippage model is an **assumed**, not measured, spread — a different (even equally reasonable)
  assumption could move the edge-retention number meaningfully; (3) **no walk-forward
  TRAIN/VALIDATE/TEST split has been run** — this is one long in-sample window, not an out-of-sample
  test, so this finding says "the strategy had positive net expectancy over this specific historical
  window under these specific assumptions," not "the strategy has a validated, forward-looking
  edge."

## 15. Stop condition

Per the task's explicit instruction, no parameter was optimized and `USE_NET_EV_RANKING` remains
`false` everywhere. Stopping here for review before any further phase begins.
