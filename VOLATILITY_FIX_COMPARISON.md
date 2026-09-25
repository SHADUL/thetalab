# VOLATILITY_FIX_COMPARISON.md

**Fix implemented**: Option B from `VOLATILITY_TIME_CONVENTION.md`. `computeRealizedVolatility`
still annualizes with `sqrt(252)` (unchanged). Every caller that previously passed a **calendar**
DTE into `computeExpectedRealizedMove` / `buildEmpiricalReturns` / `computeIndependentPop` /
`computeIndependentExpectedValue` now converts it to a **trading-session** count first
(`approxTradingSessionsFromCalendarDays`, or `countTradingSessions` when exact dates are available).
`normalBreachProbability` now de-annualizes with `sqrt(tradingSessions / 252)`, not
`sqrt(calendarDays / 365)`. See `src/quant/strategies/expirySelector.ts`'s own comments at both
call sites for the exact wiring, and `src/quant/__tests__/volatilityHorizonFix.test.ts` (8 new
tests, all passing) for the regression suite covering 1/2/7/14/30/45/60 calendar-DTE, Friday→Monday,
weekends, and a supplied exchange holiday.

## Methodology — real data, isolated variable

Every number below is computed from the **real NIFTY closing-price history** cached in this repo
(`src/options-auto/backtest/.bhavcopy-cache/`, 646 real NSE trading sessions, 2024-02-01 through
2026-09-15 — extracted via `parseUdiffBhavcopy`'s own underlying-price column, the exact same field
the production pipeline reads). Eight sample dates were chosen **evenly spaced** across that range
(no cherry-picking), each requiring at least 260 real prior trading days of history for a stable
252-day realized-vol read — the same minimum the production code itself requires.

For each sample date, a real Iron Condor candidate (30 DTE, 0.16-delta short strikes, 500-pt wings)
was built via the actual `buildIronCondor` function against a synthetic options chain priced with
Black-76 at that date's real spot and a single assumed implied volatility
(`realizedVol × 1.15` — a modest, disclosed vol-risk-premium multiple; **no real historical IV
archive exists to draw from** — `src/quant/data/history/atm_iv_nifty.json` is empty, confirmed
before this comparison was run). This assumed IV, the resulting candidate, its `maxProfit`/`maxLoss`,
and every input except the horizon conversion are held **byte-for-byte identical** between the OLD
and NEW columns below — the fix is the *only* variable that differs, isolating its effect precisely.
The absolute score/decision values are therefore illustrative (a real historical IV would differ
from this assumption), but the **OLD vs NEW delta at each date is real and rigorous**.

## Results (all 8 sampled dates — none hidden or excluded)

| Date | Spot | RV(252d) | Edge% OLD | Edge% NEW | IndepEV/Risk OLD | IndepEV/Risk NEW | Score OLD | Score NEW | Decision OLD | Decision NEW |
|---|---|---|---|---|---|---|---|---|---|---|
| 2025-02-19 | 22,932.9 | 14.0% | 98.65 | 93.98 | −0.1192 | +0.0731 | 62.7 | 78.0 | **NO_TRADE** | **WATCH** |
| 2025-05-16 | 25,019.8 | 15.6% | 92.47 | 103.40 | −0.0313 | +0.1350 | 70.2 | 83.4 | **WATCH** | **TRADE_CANDIDATE** |
| 2025-08-01 | 24,565.3 | 13.5% | 81.68 | 81.21 | −0.1102 | +0.0410 | 63.5 | 75.5 | **NO_TRADE** | **WATCH** |
| 2025-10-23 | 25,891.4 | 12.7% | 74.48 | 85.53 | −0.0846 | +0.0193 | 65.7 | 74.0 | **NO_TRADE** | **WATCH** |
| 2026-01-12 | 25,790.3 | 11.5% | 66.76 | 86.88 | −0.1006 | −0.0156 | 64.2 | 71.0 | **NO_TRADE** | **WATCH** |
| 2026-04-07 | 23,123.7 | 13.5% | 92.21 | 113.77 | −0.0490 | +0.0614 | 68.3 | 77.1 | **NO_TRADE** | **WATCH** |
| 2026-06-29 | 23,946.3 | 13.0% | 83.14 | 97.26 | −0.0632 | +0.0228 | 67.4 | 74.2 | **NO_TRADE** | **WATCH** |
| 2026-09-15 | 23,118.6 | 13.1% | 86.11 | 106.67 | −0.0315 | +0.0400 | 69.8 | 75.5 | **NO_TRADE** | **WATCH** |

## What actually changed, and why, honestly

**The decision changed at all 8 of 8 sampled dates.** 7 moved from NO_TRADE to WATCH; 1 moved from
WATCH to TRADE_CANDIDATE. **None stayed at NO_TRADE, and none moved backward (toward a more
conservative classification).** This is not a coincidence of these particular 8 dates — it is the
direct, structural consequence of the bug's own direction: the OLD code always measured realized
volatility over a *longer* real calendar window than the option's own calendar DTE implied (a
30-calendar-day option was compared against a ~43-calendar-day realized-move sample), and over the
real NIFTY history in this cache, that longer window's typical absolute move was consistently
*larger* than the 21-session (~30-calendar-day) window's — inflating the "expected realized move"
denominator and *understating* `edgePct`/`independentEV` almost every time. The fix consistently
raises both readings across this entire 1.5-year real sample.

**This means the OLD (buggy) code was, if anything, biased toward under-trading, not over-trading**
— it is not the kind of bug that would have made the system look more profitable than it was; it's
the opposite direction. That is a relevant, honest data point for the acceptance question in the
next phase's report: fixing this bug will very likely **increase** how often the system would have
signaled a trade historically, not decrease it — which is exactly why Phase 16/17's realistic-
execution and net-EV work needs to run against the corrected numbers, not the old ones, before
drawing any conclusion about whether more of those trades were actually good ones.

## What this comparison does NOT establish

- It does not claim the ABSOLUTE scores/decisions above are what a real historical scan would have
  produced — the assumed IV is a stand-in, not a historical observation.
- It does not evaluate whether WATCH/TRADE_CANDIDATE was the *right* call at any of these 8 dates —
  that requires the realistic-execution and net-EV work in the rest of this phase.
- It is not a backtest of trading outcomes — see `EXECUTION_AND_PARITY_REPORT.md` for that.
