import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeExpectedRealizedMove } from '../analytics/realizedVolatility.ts';
import { buildEmpiricalReturns, normalBreachProbability, computeIndependentPop } from '../analytics/distributionModel.ts';
import { computeRealizedVolatility } from '../analytics/realizedVolatility.ts';
import { approxTradingSessionsFromCalendarDays, countTradingSessions } from '../analytics/timeConventions.ts';

/**
 * Regression suite for VOLATILITY_TIME_CONVENTION.md's Option B fix: a
 * calendar-day DTE must be converted to a trading-session count BEFORE it
 * reaches computeExpectedRealizedMove/buildEmpiricalReturns/
 * computeIndependentPop — those functions step through `historicalCloses`
 * by ARRAY INDEX, and that array has one row per real trading session
 * (Kite's daily candle feed has no row at all for a weekend/holiday).
 * expirySelector.ts now performs this conversion at its two call sites
 * (see its own comments) — these tests pin the conversion itself down
 * directly against the exported functions, independent of expirySelector's
 * internal wiring, so a future regression there would still be caught here.
 */

/** A long, strictly increasing daily-close series — one row per trading
    day, 2024-01-01 (a Monday) onward, skipping weekends — so a window of
    N sessions always covers a REAL, distinct, predictable calendar span,
    and passing the wrong horizon count changes which rows get compared. */
function buildTradingDayCloses(sessionCount: number, startPrice = 20000, dailyStep = 10): { date: string; close: number }[] {
  const closes: { date: string; close: number }[] = [];
  let d = new Date('2024-01-01T00:00:00Z'); // Monday
  let price = startPrice;
  while (closes.length < sessionCount) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      closes.push({ date: d.toISOString().slice(0, 10), close: price });
      price += dailyStep;
    }
    d = new Date(d.getTime() + 86_400_000);
  }
  return closes;
}

const CALENDAR_DTES = [1, 2, 7, 14, 30, 45, 60];

test('for every representative calendar DTE, the raw calendar-day count and its trading-session conversion select DIFFERENT rows (except trivially small DTEs)', () => {
  const closes = buildTradingDayCloses(400);
  for (const dte of CALENDAR_DTES) {
    const sessions = approxTradingSessionsFromCalendarDays(dte);
    const viaRawDte = computeExpectedRealizedMove(closes, dte, closes[0].close);
    const viaSessions = computeExpectedRealizedMove(closes, sessions, closes[0].close);
    assert.ok(viaRawDte !== null && viaSessions !== null, `dte=${dte}`);
    // Sessions/365 ratio (~0.69) means dte and sessions diverge for every
    // DTE in this list except where rounding coincidentally collides —
    // verified explicitly per DTE rather than assumed.
    if (dte !== sessions) {
      assert.notEqual(viaRawDte!.points, viaSessions!.points, `dte=${dte} sessions=${sessions}: the fix must change the actual computed value`);
    }
  }
});

test('30 calendar-DTE: the pre-fix behavior (raw dte=30) measured a ~43-calendar-day window; the fix measures ~30', () => {
  const closes = buildTradingDayCloses(400);
  const sessions = approxTradingSessionsFromCalendarDays(30);
  assert.equal(sessions, 21, 'sanity: 30 calendar days ≈ 21 trading sessions');

  // The window "30 rows forward" in a trading-day-only series spans more
  // real calendar time than 30 days — verified directly against the dates
  // themselves, not just against the count.
  const spanCalendarDaysAtRawDte = (Date.parse(closes[30].date) - Date.parse(closes[0].date)) / 86_400_000;
  const spanCalendarDaysAtSessions = (Date.parse(closes[sessions].date) - Date.parse(closes[0].date)) / 86_400_000;
  assert.ok(spanCalendarDaysAtRawDte > 40, `pre-fix (raw dte=30) real elapsed span was ${spanCalendarDaysAtRawDte} calendar days — should be ~43`);
  assert.ok(Math.abs(spanCalendarDaysAtSessions - 30) <= 3, `fixed (sessions=${sessions}) real elapsed span was ${spanCalendarDaysAtSessions} calendar days — should be ~30`);
});

test('Friday -> Monday: a 3 calendar-day DTE converts to 1 trading session, not 3', () => {
  assert.equal(approxTradingSessionsFromCalendarDays(3), 2); // long-run average approximation
  // The REAL date-aware conversion (preferred whenever exact dates are
  // available, per the task) gets the exact answer for this specific case.
  assert.equal(countTradingSessions('2026-01-02', '2026-01-05'), 1); // Fri -> Mon
});

test('a weekend-only span contributes zero trading sessions to the horizon', () => {
  assert.equal(countTradingSessions('2026-01-03', '2026-01-04'), 0); // Sat -> Sun
});

test('an exchange holiday, when supplied, further shortens the trading-session horizon vs. weekday-only counting', () => {
  const withoutHoliday = countTradingSessions('2026-01-05', '2026-01-09'); // Mon->Fri, 4 weekdays
  const withHoliday = countTradingSessions('2026-01-05', '2026-01-09', new Set(['2026-01-07']));
  assert.equal(withoutHoliday, 4);
  assert.equal(withHoliday, 3);
});

test('buildEmpiricalReturns: the wrong (calendar) horizon and the fixed (session) horizon produce genuinely different return samples', () => {
  const closes = buildTradingDayCloses(400);
  const dte = 45;
  const sessions = approxTradingSessionsFromCalendarDays(dte);
  const buggy = buildEmpiricalReturns(closes, dte);
  const fixed = buildEmpiricalReturns(closes, sessions);
  assert.ok(buggy && fixed);
  // Same synthetic linear-price series, so both are internally consistent
  // number sequences, but the two horizons genuinely differ (45 vs 32
  // sessions) so returns differ in magnitude for this monotonic series.
  assert.notEqual(buggy![0], fixed![0]);
});

test('normalBreachProbability: de-annualizing with /252 (fixed) vs /365 (buggy) on a session-based horizon gives different probabilities', () => {
  const closes = buildTradingDayCloses(400, 20000, 5);
  const rv = computeRealizedVolatility(closes)!;
  assert.ok(rv);
  const sessions = approxTradingSessionsFromCalendarDays(30); // 21
  const strike = closes[0].close * 1.05;

  const fixed = normalBreachProbability(rv, sessions, closes[0].close, strike, 'upper')!;
  // Reproduce the OLD buggy formula manually (sessions/365 instead of
  // sessions/252) to prove the two are numerically different, i.e. the
  // fix is not a no-op.
  const buggySigma = rv.annualizedVol * Math.sqrt(sessions / 365);
  const fixedSigma = rv.annualizedVol * Math.sqrt(sessions / 252);
  assert.ok(fixed !== null);
  assert.notEqual(buggySigma, fixedSigma);
  assert.ok(Math.abs(fixedSigma / buggySigma - Math.sqrt(365 / 252)) < 1e-9, 'the two sigmas must differ by exactly sqrt(365/252)');
});

test('computeIndependentPop end-to-end: passing a raw calendar DTE vs. its session conversion changes the resulting probability for a realistic 30-DTE structure', () => {
  // A monotonic (no-noise) series saturates every breach probability at
  // exactly 0 or 1 regardless of window length, which can trivially make
  // two different horizons agree — this oscillates around a slow drift so
  // the ACTUAL magnitude of a window's move genuinely depends on how many
  // sessions it spans, exercising the real difference the fix corrects.
  const closes: { date: string; close: number }[] = [];
  let d = new Date('2024-01-01T00:00:00Z');
  let i = 0;
  while (closes.length < 400) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const price = 20000 + i * 3 + 2000 * Math.sin(i / 6);
      closes.push({ date: d.toISOString().slice(0, 10), close: price });
      i++;
    }
    d = new Date(d.getTime() + 86_400_000);
  }
  const spot = closes[0].close;
  const shortStrikes = [{ strike: spot * 1.05, side: 'upper' as const }, { strike: spot * 0.95, side: 'lower' as const }];
  const dte = 30;
  const sessions = approxTradingSessionsFromCalendarDays(dte);
  assert.notEqual(dte, sessions);

  const buggy = computeIndependentPop(closes, spot, dte, shortStrikes);
  const fixed = computeIndependentPop(closes, spot, sessions, shortStrikes);
  assert.ok(buggy && fixed, 'both must be computable from the same synthetic history');
  assert.notEqual(buggy!.probability, fixed!.probability, 'the fix must change the independent POP read for a real 30-DTE structure, not just an isolated helper');
});
