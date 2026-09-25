# OUT_OF_SAMPLE_VALIDATION_REPORT.md

**Baseline used: `BASELINE_V1`** (see `BASELINE_V1.md` / `src/options-auto/backtest/baselineV1.ts`).
No strategy parameter was changed to produce this report. Verdict criteria were committed to
**before** this report was generated — see `VALIDATION_CRITERIA.md`, not adjusted after the fact.

## 0. Production safety precondition

`options_autotrade_order_intents` is **still not applied** to production Supabase (re-verified this
phase via a direct REST check: 404). **AUTO must not be enabled.** Exact process to apply it:

```bash
# Option A — Supabase SQL editor (simplest): paste the contents of
# src/options-auto/migrations/008_order_intents.sql into the project's SQL
# editor and run it.

# Option B — Supabase CLI, once linked and authenticated:
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push   # or: psql "$DATABASE_URL" -f src/options-auto/migrations/008_order_intents.sql
```

After applying, verify (no real broker order is placed by any of this):
- **Table exists**: `curl "$SUPABASE_URL/rest/v1/options_autotrade_order_intents?select=id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"` returns `200`, not `404`.
- **Partial unique index exists / duplicate claim fails / normal claim succeeds / terminal intent allows later re-entry**: already proven by `src/quant/__tests__/orderIntent.test.ts` (7 tests, all passing, re-verified this phase) against a real in-memory model of the same atomic-insert semantics the Postgres partial unique index provides. Run `npx tsx --test src/quant/__tests__/orderIntent.test.ts` any time to reconfirm.
- **AUTO fails closed on DB/reconciliation failure**: proven by `src/quant/__tests__/liveFill.test.ts` (12 tests, including the 4 TIMEOUT/ambiguity tests) and `src/quant/__tests__/brokerReconciliation.test.ts` (14 tests) — all re-verified passing this phase.

## 1. Frozen BASELINE_V1 parameters

See `BASELINE_V1.md` for the full table. Nothing in it was touched by this phase.

## 2. Walk-forward methodology

Chronological, non-shuffled. `src/options-auto/backtest/walkForward.ts`'s `buildWalkForwardWindows`
rolls TRAIN(12mo)→VALIDATE(3mo)→TEST(3mo) forward by the TEST length each iteration, over the full
real NIFTY history (2024-02-01 to 2026-09-15). **5 windows fit.** An explicit leakage assertion
(`assertNoLeakageAcrossWindow`) was run against every window and passed for all 5 — no TRAIN/VALIDATE-
dated observation is ever dated on/after that window's own TEST start. This is layered on top of
the per-day point-in-time slicing `simulateSymbolRealistic` already performs internally (tested
separately in `ivRankHistory.test.ts`'s leakage-guard tests) — two independent leakage checks, not
one.

Because this is a **rules-based system with no parameters fit from TRAIN/VALIDATE data** (BASELINE_V1
is frozen, not learned), the walk-forward exercise here does not "train" anything — it exists to
(a) prove the chronological-isolation machinery itself is sound, and (b) partition trades into
non-overlapping TEST segments for honest out-of-sample reporting, rather than reporting one
continuous in-sample number.

| Window | TRAIN | VALIDATE | TEST |
|---|---|---|---|
| 0 | 2024-02-01 → 2025-02-01 | 2025-02-01 → 2025-05-01 | 2025-05-01 → 2025-08-01 |
| 1 | 2024-05-01 → 2025-05-01 | 2025-05-01 → 2025-08-01 | 2025-08-01 → 2025-11-01 |
| 2 | 2024-08-01 → 2025-08-01 | 2025-08-01 → 2025-11-01 | 2025-11-01 → 2026-02-01 |
| 3 | 2024-11-01 → 2025-11-01 | 2025-11-01 → 2026-02-01 | 2026-02-01 → 2026-05-01 |
| 4 | 2025-02-01 → 2026-02-01 | 2026-02-01 → 2026-05-01 | 2026-05-01 → 2026-08-01 |

## 3. TEST-only results (all 5 windows aggregated, NIFTY, real data)

| Metric | IDEAL | REALISTIC | STRESS |
|---|---|---|---|
| Trades | 51 | 51 | 51 |
| Win rate | 86.3% | 86.3% | 78.4% |
| Gross P&L | ₹1,20,043 | ₹1,20,043 | ₹1,20,043 |
| Net P&L | ₹1,11,962 | ₹1,02,401 | ₹57,684 |
| Expectancy/trade | ₹2,195.34 | ₹2,007.86 | ₹1,131.05 |
| Profit factor | 10.93 | 8.53 | 3.47 |
| Max drawdown (1 lot) | ₹2,761 | ₹3,210 | ₹5,848 |
| CVaR (worst 5% of trades) | −₹2,330 | −₹2,839 | −₹4,875 |
| Per-trade Sharpe* | 5.61 | 5.18 | 3.08 |
| Per-trade Sortino* | 8.74 | 6.68 | 2.80 |
| Avg cost/credit | 7.6% | 14.2% | 43.6% |

*Labeled explicitly: these are per-trade-return Sharpe/Sortino approximations (same convention
`metrics.ts` already discloses), **not** a daily-equity-curve annualized Sharpe/Sortino — a genuine
daily mark-to-market equity curve was not built in this phase (this system's positions are held
1-20 days at a time with no intermediate daily unrealized-P&L series persisted in the backtest);
flagging this explicitly rather than presenting the two as equivalent, per this task's own
instruction.

## 4. Year-by-year and per-window stability

| Window | TEST period | Trades | Expectancy/trade (REALISTIC) |
|---|---|---|---|
| 0 | 2025-05→08 | 13 | ₹3,174.24 |
| 1 | 2025-08→11 | 12 | ₹2,205.96 |
| 2 | 2025-11→2026-02 | 5 | ₹420.30 |
| 3 | 2026-02→05 | 12 | ₹2,619.58 |
| 4 | 2026-05→08 | 9 | ₹125.33 |

**5 of 5 windows (100%) were individually net-expectancy-positive.** Median window expectancy:
**₹2,205.96**. Worst window: **₹125.33** (window 4, still positive, but the weakest — only 9
trades). Best window: **₹3,174.24** (window 0).

By calendar year (TEST-only, REALISTIC): **2025**: 28 trades, ₹2,477.37/trade, PF 14.12. **2026**
(through Aug, partial year): 23 trades, ₹1,436.30/trade, PF 4.98. Both years individually positive;
2026 weaker than 2025 so far, consistent with windows 2 and 4 (both partly/fully in 2026) being the
two weakest windows.

## 5. Strategy-type stability (TEST-only, REALISTIC)

| Strategy | Trades | Expectancy/trade | Profit factor | Max DD | Avg cost/credit |
|---|---|---|---|---|---|
| Iron Condor | 17 | ₹2,736.21 | 17.15 | ₹2,881 | 10.0% |
| Bull Put Spread | 20 | ₹2,016.13 | 19.34 | ₹1,370 | 18.3% |
| Bear Call Spread | 14 | ₹1,111.64 | 2.83 | ₹3,210 | 13.4% |

All three structures are individually TEST-only-positive. **Bear Call Spread is the weakest** by
profit factor (2.83, vs. Iron Condor's 17.15 and Bull Put's 19.34) and has the largest drawdown of
the three. Flagged, not acted on — no structure disabled this phase.

## 6. Regime diagnostics (descriptive only — no filter applied)

**Trend regime** (real, point-in-time EMA-based, TEST-only trades): positive expectancy in **every**
bucket — STRONG_BULLISH (₹2,346/trade, n=11), BULLISH (₹2,092, n=14), NEUTRAL (₹1,333, n=9), BEARISH
(₹1,861, n=8), STRONG_BEARISH (₹2,269, n=9). **Realized-vol regime**: also positive in every bucket
— HIGH_VOLATILITY (₹2,569, n=14), ELEVATED (₹1,206, n=10), NORMAL (₹1,325, n=9), LOW_VOLATILITY
(₹2,358, n=18). **Skew regime**: not computed as a separate bucket — `strategyLabel` (§5) already
**is** the skew-bias output one-to-one (bullish skew → Bull Put, bearish → Bear Call, neutral → Iron
Condor per `regimeSelect.ts`), so §5's breakdown already answers this question without duplicating
the calculation. **India VIX regime: not available** — bhavcopy carries no VIX field; not computed,
not approximated, not fabricated.

No regime bucket shows a negative or collapsed result in this sample — descriptive finding only, no
production behavior changed.

## 7. Daily-lock operator-policy comparison (STRESS + ₹10L sizing — the regime that actually triggered the lock)

| Policy | Trades | Net P&L | Last entry | Max drawdown |
|---|---|---|---|---|
| NEVER_CLEAR (production's real, unchanged behavior) | 37 | ₹2,14,349 | 2024-10-11 | ₹34,714 |
| CLEAR_NEXT_TRADING_DAY | 114 | ₹4,60,247 | 2026-08-11 | ₹3,84,985 |
| CLEAR_AFTER_1_SESSION | 114 | ₹4,60,247 | 2026-08-11 | ₹3,84,985 |
| CLEAR_AFTER_3_SESSIONS | 115 | ₹4,69,499 | 2026-08-11 | ₹3,84,985 |

The lock triggered **once**, on **2024-10-11**, after which `NEVER_CLEAR` (production's actual,
unchanged behavior) permanently stopped trading for the remaining ~23 months of real data. All three
CLEAR_* policies resumed trading and accumulated far more total P&L simply by trading far longer —
**but max drawdown also grew roughly 11×** (₹34,714 → ₹3,84,985), which is largely a function of
trading over ~23 more months rather than evidence the clearing policies are individually riskier
per trade. **Do not read this as "faster clearing is better"**: the comparison conflates trade count
with policy quality — a fair judgment needs per-trade or per-unit-time risk-adjusted comparison,
which this phase did not additionally compute. `CLEAR_NEXT_TRADING_DAY` and `CLEAR_AFTER_1_SESSION`
produced numerically identical results in this sample — consistent with there being no actual entry
signal on the one extra day that distinguishes them, not evidence the two policies are equivalent in
general.

## 8/9/11. Live data capture — schema only, not yet collecting

`src/options-auto/migrations/009_live_data_capture.sql` adds three append-only tables:
`options_chain_snapshots` (Task 8), `options_execution_quality` (Task 9), `options_iv_history`
(Task 11, per-symbol-**and**-per-expiry-tenor, not one generic number). **These tables are schema
only in this phase** — no scan/monitor/paper-fill code has been wired to write into them yet. That
wiring (inserting a snapshot row on every live quote batch, an execution-quality row on every
PAPER/SHADOW/AUTO fill) is real, additional work not completed here, and is the actual prerequisite
for Task 10 (slippage-model calibration) and a defensible historical IV-rank archive — flagged
honestly as the next concrete step, not attempted partially.

## 10. Slippage-model calibration status

**Cannot be done yet.** Calibrating `REALISTIC_EMPIRICAL` against observed bid/ask/fill data
requires the `options_execution_quality` table (§8/9) to actually contain rows, which requires the
wiring above to have run live for some period first. `REALISTIC_V1` (this codebase's current,
assumption-based model — 2% assumed spread, 0.5 spread-fraction, etc.) remains the only model in
use. No empirical distribution of spread/mid, entry/exit slippage, or slippage-by-DTE/liquidity/
VIX/time-of-day exists to fit from yet.

## 12. Symbol data coverage

| Symbol | Status | Note |
|---|---|---|
| NIFTY | `HISTORICAL_BACKTEST_AVAILABLE` | 646 real cached NSE sessions, 2024-02-01 to 2026-09-15 |
| BANKNIFTY | `FORWARD_DATA_ONLY` | Ingestion code already exists (`bhavcopy.ts`'s `bhavcopyUrl()` already targets NSE for this symbol) — no historical cache exists in this sandbox, and this sandbox's network cannot reach `archives.nseindia.com` to build one. Must be run from an environment with real NSE archive access (e.g. production). |
| SENSEX | `FORWARD_DATA_ONLY` | Same situation — `bhavcopyUrl()` already targets BSE for this symbol; no cache, same network limitation. |

No synthetic option-chain data was substituted for either symbol anywhere in this or the prior
report — every number in §3-§7 above is NIFTY-only, real bhavcopy data.

## 13. Historical cost-rate accuracy

Fixed this phase: `costs.ts`'s `RATE_HISTORY` now has **two** dated entries — the pre-2024-10-01
options-STT rate (0.0625%, a confirmed historical fact, the same SEBI circular already cited in this
codebase) and the post-2024-10-01 rate (0.1%) used in the prior report. Every trade in §3-§7 now
looks up its own trade date's applicable rate via `ratesEffectiveOn()`. **Only the STT component is
independently dated/verified** — brokerage, exchange charges, SEBI charges, stamp duty, and GST are
held constant at current rates across the whole window and are **not** independently confirmed
per historical sub-period (`costs.ts`'s new `COST_MODEL_LIMITATION` constant states this plainly) —
treat absolute historical cost figures as approximate, not exact.

## 14. Monte Carlo — TEST-only trade sequence, block bootstrap (not iid)

Block bootstrap (block length 5, preserving short-run sequential dependence — not a naive
independent-observation resample) over the 51 real TEST-only REALISTIC trades, 5,000 simulations:

- Median ending equity: ₹1,02,141 · 5th percentile: ₹65,868 · 1st percentile: ₹50,741
- Median max drawdown: ₹3,210 · 95th percentile max drawdown: ₹5,385
- P(drawdown > 10% of a stated ₹50,000 1-lot reference capital): **7.7%**
- P(drawdown > 20% of that reference capital): **0%** (never observed in 5,000 simulations)
- Observed loss-streak lengths in the real TEST-only sample: seven streaks, **every one length 1**
  — no observed instance of 2+ consecutive losses in this 51-trade out-of-sample set.

**This is a risk-distribution tool, not evidence of alpha** — restated per this task's own explicit
instruction, since the numbers above are encouraging and could otherwise be misread as a
profitability claim.

## 15. 1-lot vs. portfolio-sized capital curve (TEST-only)

| | 1-lot (per-trade edge) | Sized (₹10L equity, capital-growth effect) |
|---|---|---|
| Trades | 51 | 51 |
| Net P&L | ₹1,02,401 | ₹10,20,103 |
| Expectancy/trade | ₹2,007.86 | ₹20,002.01 (avg 19.5 lots/trade) |
| Win rate | 86.3% | 86.3% (identical — sizing doesn't change which trades occur under REALISTIC) |

Reported as two separate concepts, per this task's explicit instruction: the **1-lot column is the
actual per-trade edge** (small, real, and what §3-§6 above are all built from); the **sized column
is a capital-growth effect** of applying that same edge at ~19.5x average size under BASELINE_V1's
own unmodified 2%-risk-per-trade sizing rule — it is not a separately-validated result and must
never be read as "the strategy makes ₹20,000/trade," only as "this is what the SAME edge compounds
to at this account size."

## 16. Remaining live/backtest differences

Unchanged from the prior phase's list (margin is `HISTORICAL_MODEL` not `LIVE_KITE`; correlated
multi-symbol portfolio risk not modeled; assumed, not measured, slippage) — **plus**, newly
identified this phase: the daily-lock's real "never auto-clears" behavior has now been shown to
produce a materially different (much shorter) real trading history under adverse execution
assumptions than any of the operator-policy alternatives, and live IV-rank/execution-quality/option-
chain-snapshot data collection has not yet started (§8-11).

## 17. Acceptance question

**"Does BASELINE_V1 demonstrate robust positive out-of-sample net expectancy?"**

Checking against `VALIDATION_CRITERIA.md`, committed before this report:

1. Positive aggregate TEST-only net expectancy (REALISTIC): **₹2,007.86/trade — YES.**
2. Profit factor > 1.0: **8.53 — YES.**
3. Edge does not depend entirely on one year/window: **5 of 5 windows individually positive; no
   single window or year is 100% of the result — YES.**
4. REALISTIC remains positive: **YES** (same as #1).
5. STRESS behavior documented: **YES** — STRESS remains positive TEST-only too (₹1,131.05/trade, PF
   3.47), though materially weaker, with a real, disclosed daily-lock interaction (§7).
6. Minimum sample size (≥20 TEST trades): **51 — YES.**

**Automatic INSUFFICIENT DATA conditions**: none triggered for NIFTY (≥20 trades, ≥2 windows, real
data exists).

## Answer: **YES** — for NIFTY, under BASELINE_V1, under REALISTIC execution assumptions, on
**TEST-only** out-of-sample trades.

This is a narrower, more specific YES than it may look at first glance, and the report is explicit
about the boundary of what it covers:

- This verdict is **NIFTY-only**. BANKNIFTY and SENSEX remain `FORWARD_DATA_ONLY` (§12) — **no
  claim is made about either symbol**, and this YES must never be generalized to "the system" as a
  whole until they are independently tested.
- The REALISTIC/STRESS slippage numbers rest on an **assumed**, not empirically measured, spread
  model (§10) — the actual live execution-quality data needed to validate or correct that assumption
  does not exist yet (§8/9).
- "Robust" here means: passes the pre-committed criteria on real, non-cherry-picked, chronologically
  isolated out-of-sample data, across 5 windows and 2 partial calendar years. It does **not** mean
  validated against a truly independent, never-before-touched holdout — the entire 2024-02 to
  2026-09 window has now been examined by this and the prior report, so a genuinely blind future
  period is the next real test, not a re-run of this same data.

## 18. Stop condition

No parameter was optimized. `USE_NET_EV_RANKING` remains `false`. AUTO was not enabled and no real
broker order was placed anywhere in this phase. Returning this report for review before any further
phase begins.
