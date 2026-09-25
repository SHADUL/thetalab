# VOLATILITY_TIME_CONVENTION.md

**Status: analysis only. No production math has been changed.** New helpers
(`src/quant/analytics/timeConventions.ts`, tested) exist so a future fix can
state its unit explicitly — they are not yet called from
`realizedVolatility.ts` or `distributionModel.ts`.

## 1. What one historical return observation represents

`HistoricalClose[]` (`realizedVolatility.ts:16-19`) is populated by
`fetchHistoricalCloses` (`api/options-autotrade.ts:305-319`), which calls
Kite's `/instruments/historical/<token>/day` candle endpoint. **Each row is
one real trading session's close** — weekends and market holidays simply
produce **no row at all**; they are not zero-filled, not interpolated, not
present in any form. `computeRealizedVolatility`'s log returns
(`realizedVolatility.ts:33-35`) are therefore computed between
**consecutive trading-session closes**, already trading-time-spaced by
construction, not calendar-time-spaced.

## 2. Is realized volatility annualized in trading-time or calendar-time?

**Trading-time.** `computeRealizedVolatility` (`realizedVolatility.ts:40`):
`annualizedVol = stdev(logReturns) * sqrt(252)`. Given finding #1 — the
input returns are already one-per-trading-session — **this is the textbook-
correct convention in isolation**: annualizing a trading-day-spaced return
series uses the number of trading sessions per year (252 is the standard
approximation for NSE, whose actual count is closer to ~250), not calendar
days. ACT/365 being Black-76's day-count convention does **not**, by itself,
make sqrt(252) wrong here — these are two different clocks used for two
different purposes (option time-decay vs. historical-return sampling
density), and the task instructions were right to flag this as needing
verification rather than an assumed bug.

## 3. Does `horizonDays` mean trading days or calendar days? — **This is the real inconsistency**

This is where an actual bug lives, and it is more specific than "sqrt(252)
vs sqrt(365)."

- `computeExpectedRealizedMove(closes, horizonDays, currentSpot)`
  (`realizedVolatility.ts:59-72`) and `buildEmpiricalReturns(closes,
  horizonDays)` (`distributionModel.ts:43-52`) both use `horizonDays` as a
  **row-index offset** into the trading-session-spaced `closes` array:
  `sorted[i + horizonDays]`.
- Every real caller of these two functions passes **`dte`** — computed as
  `Math.round(slice.timeToExpiry * 365)` in `expirySelector.ts:110`, i.e. a
  **CALENDAR-day** count derived from `enrich.ts`'s ACT/365 `timeToExpiry`
  (`expirySelector.ts:135`: `computePremiumEdgeForExpiry(slice, atmIv, dte,
  ...)`; `expirySelector.ts:157-162`:
  `computeIndependentExpectedValue(..., dte)`).

**So a calendar-day count is being used as a trading-session array offset.**
Concretely: a 30-calendar-day DTE gets treated as "30 rows forward in the
trading-session array" — but 30 trading sessions is roughly `30 * 365/252 ≈
43` **calendar** days of real elapsed time (trading days are only ~69% of
calendar days). The result: **"the realized move over a 30-calendar-day
horizon" is actually measured over a ~43-calendar-day historical window** —
a materially longer look-back than the option's own horizon claims to be
horizon-matched against.

**Direction of the resulting error, and why it matters**: a longer
historical window typically shows a larger typical absolute move (more
elapsed time to accumulate movement), so `expectedRealizedMove.pct` is
systematically **inflated** relative to the option's true DTE. That
inflated denominator **understates** `IvRvEdge.edgePct` (`impliedMovePct /
expectedRealizedMove.pct`, `realizedVolatility.ts:90-94`) — the single
highest-weighted component in Trade Quality Score (`premiumEdge`, weight
20/100). The same `dte`-as-trading-session-offset pattern also understates
`buildEmpiricalReturns`'s implied breach window in
`computeIndependentPop`/`computeIndependentExpectedValue`
(`distributionModel.ts`, `independentEv`, weight 20/100) — the other
highest-weighted component. **Both of the two primary edge signals in the
scoring model inherit this same systematic bias**, not independently, since
both are fed the same `dte` value through the same mismatched convention.

## 4. How are weekends/holidays treated?

Implicitly, by absence. Kite's candle feed has no row for a non-trading
day, so any calendar-day count fed as a trading-day array offset silently
"skips over" more real elapsed time than the number suggests (§3). No
explicit market-holiday calendar exists anywhere in this codebase —
`countTradingSessions` (new helper) accepts an optional holiday set but
defaults to Mon–Fri-only, which will still slightly overcount trading
sessions around exchange holidays (Republic Day, Diwali, etc.) until a real
NSE/BSE holiday list is wired in. This is a known, disclosed gap in the new
helper, not a claim that it's exact.

## 5. What time basis does Black-76 receive?

ACT/365 calendar year fraction (`enrich.ts:35-37`'s `yearFraction`, fed
straight into `black76.ts`'s `timeToExpiry`), continuously-compounded
`rate`, decimal `vol`. Confirmed consistent throughout the pricing engine
(`black76.ts:37`, `enrich.ts` header, `config.ts`'s `dayCount: 'ACT/365'`).
Not in question — this part of the pipeline is internally consistent.

## 6. What time basis does the empirical distribution model receive?

Nominally "`horizonDays`," but as shown in §3, every real caller supplies a
**calendar-day** count (`dte`) into a function that consumes it as a
**trading-session** count. This is the actual defect: not "252 is wrong" or
"365 is wrong" in isolation, but that **two different clocks are mixed
across a single function boundary without conversion.**

A second, smaller instance of the same class of issue:
`normalBreachProbability` (`distributionModel.ts:78`):
`sigmaHorizon = realizedVol.annualizedVol * Math.sqrt(horizonDays / 365)`.
Here `realizedVol.annualizedVol` is 252-trading-day-annualized (§2), but
it's de-annualized with a **365-calendar-day** divisor and a `horizonDays`
value that (per §3) is itself a calendar-day count being misused elsewhere
as a trading-day count. Two wrongs don't cancel here: de-annotating a
252-based annualized vol with a calendar divisor is its own separate
inconsistency, layered on top of the `horizonDays` unit confusion in §3.

## 7. The mathematically consistent conversion (two options, either is correct — pick one, don't mix)

**Option A — full calendar-day convention.** Change
`computeRealizedVolatility`'s annualization from `sqrt(252)` to `sqrt(365)`,
and treat every "days" parameter throughout as calendar days consistently
(matching Black-76/enrich.ts). Simple, but slightly non-standard for RV
estimation (the return series itself is trading-day-spaced, not
calendar-day-spaced, so a calendar-day annualization implicitly assumes
weekend/holiday returns are zero, which they trivially are since no data
exists for those days — this is a real, if minor, statistical
approximation either way).

**Option B — full trading-day convention (recommended).** Keep
`sqrt(252)` in `computeRealizedVolatility` (correct as documented in §2).
Convert every `dte` (calendar) to an equivalent trading-session count
**before** it reaches `computeExpectedRealizedMove`/`buildEmpiricalReturns`/
`computeIndependentPop`, using the new `countTradingSessions` (when real
dates are available) or `approxTradingSessionsFromCalendarDays` (when only
a DTE integer is on hand, as is the case at every current call site). Then
also fix `normalBreachProbability`'s de-annualization to divide by 252, not
365, to match. This is the more standard practitioner convention for
equity/index realized-vol work and requires touching fewer numbers (only
the horizon conversion at the call sites in `expirySelector.ts`, plus one
divisor in `distributionModel.ts:78`).

### Worked numeric example (Option B, the recommended fix)

For a 30-calendar-day DTE:
- **Today (buggy)**: `computeExpectedRealizedMove(closes, 30, spot)` looks
  30 rows ahead in the trading-day array ≈ 43 calendar days of real
  history.
- **Fixed**: `computeExpectedRealizedMove(closes,
  approxTradingSessionsFromCalendarDays(30) /* = 21 */, spot)` looks 21 rows
  ahead ≈ 30 calendar days of real history — genuinely horizon-matched.

For `normalBreachProbability` with a 21-trading-session horizon:
- **Today (buggy)**: `sigmaHorizon = annualizedVol_252 * sqrt(30/365)`
  (mixes a 252-based annualized vol with a 365-based de-annualization).
- **Fixed**: `sigmaHorizon = annualizedVol_252 * sqrt(21/252)` — both sides
  of the ratio now trading-session-based, self-consistent.

## 8. Recommendation

**Option B.** It requires the smaller, more localized set of changes (a
horizon-unit conversion at the `expirySelector.ts` call sites, plus one
divisor fix in `distributionModel.ts`), it matches standard practitioner
convention for realized-vol work, and it leaves `computeRealizedVolatility`
— which is already correct — untouched.

**This document does not implement Option B.** Per the task's explicit
instruction, no production math has changed. Implementing it is a small,
mechanical, but *not* value-neutral change (it will move every historical
`premiumEdge`/`independentEv` reading, and by construction of Trade Quality
Score, every historical score) and should ship with an explicit
before/after comparison run against real historical data, not silently.

## 9. What's new in this codebase as of this task

- `src/quant/analytics/timeConventions.ts` — `calendarYearFraction`,
  `tradingYearFraction`, `countTradingSessions`,
  `approxTradingSessionsFromCalendarDays`. Not yet called by
  `realizedVolatility.ts`/`distributionModel.ts`.
- `src/quant/__tests__/timeConventions.test.ts` — 13 tests, including the
  explicit "Friday → Monday is 1 session, not 3 calendar days," "7
  calendar-DTE spans one weekend → 5 sessions," and "30 calendar-DTE → 21-22
  sessions, never 30" cases requested by the task.
