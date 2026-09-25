import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calendarYearFraction,
  tradingYearFraction,
  countTradingSessions,
  approxTradingSessionsFromCalendarDays,
} from '../analytics/timeConventions.ts';

test('calendarYearFraction: 365 calendar days is exactly 1.0', () => {
  assert.equal(calendarYearFraction('2026-01-01', '2027-01-01'), 1);
});

test('calendarYearFraction: 30 calendar days -> 30/365', () => {
  assert.ok(Math.abs(calendarYearFraction('2026-01-01', '2026-01-31') - 30 / 365) < 1e-12);
});

test('calendarYearFraction: to before from clamps to 0, not negative', () => {
  assert.equal(calendarYearFraction('2026-01-31', '2026-01-01'), 0);
});

test('tradingYearFraction: 252 sessions is exactly 1.0', () => {
  assert.equal(tradingYearFraction(252), 1);
});

test('tradingYearFraction: rejects a negative session count', () => {
  assert.throws(() => tradingYearFraction(-1));
});

test('countTradingSessions: Friday -> Monday is exactly 1 trading session, not 3 calendar days', () => {
  // 2026-01-02 is a Friday; 2026-01-05 is the following Monday.
  assert.equal(new Date('2026-01-02T00:00:00Z').getUTCDay(), 5, 'fixture date sanity check');
  assert.equal(countTradingSessions('2026-01-02', '2026-01-05'), 1);
});

test('countTradingSessions: a full weekend-spanning week is 5 sessions', () => {
  // Monday 2026-01-05 to the following Monday 2026-01-12: five weekdays
  // (Tue..Fri of that week, plus the following Monday) fall strictly after
  // the anchor and on/before the target.
  const count = countTradingSessions('2026-01-05', '2026-01-12');
  assert.equal(count, 5);
});

test('countTradingSessions: excludes a supplied market holiday that falls on a weekday', () => {
  // 2026-01-05 (Mon) -> 2026-01-09 (Fri): 4 weekdays (Tue,Wed,Thu,Fri).
  const withoutHoliday = countTradingSessions('2026-01-05', '2026-01-09');
  assert.equal(withoutHoliday, 4);
  const withHoliday = countTradingSessions('2026-01-05', '2026-01-09', new Set(['2026-01-07']));
  assert.equal(withHoliday, 3);
});

test('countTradingSessions: same date or inverted range is 0', () => {
  assert.equal(countTradingSessions('2026-01-05', '2026-01-05'), 0);
  assert.equal(countTradingSessions('2026-01-09', '2026-01-05'), 0);
});

test('countTradingSessions: 7 calendar-DTE spanning one weekend yields 5 sessions', () => {
  // Monday 2026-01-05 + 7 calendar days = Monday 2026-01-12 (one weekend
  // crossed) -> Tue,Wed,Thu,Fri,Mon = 5 trading sessions, not 7.
  assert.equal(countTradingSessions('2026-01-05', '2026-01-12'), 5);
});

test('countTradingSessions: 30 calendar-DTE is roughly 21-22 sessions, never 30', () => {
  const count = countTradingSessions('2026-01-05', '2026-02-04');
  assert.ok(count >= 20 && count <= 22, `count=${count}`);
  assert.notEqual(count, 30);
});

test('approxTradingSessionsFromCalendarDays: matches the long-run 252/365 ratio', () => {
  assert.equal(approxTradingSessionsFromCalendarDays(365), 252);
  assert.equal(approxTradingSessionsFromCalendarDays(0), 0);
  // 30 calendar days -> ~21 trading sessions (252/365 * 30 = 20.7 -> 21).
  assert.equal(approxTradingSessionsFromCalendarDays(30), 21);
});

test('approxTradingSessionsFromCalendarDays: reasonably close to a real countTradingSessions over a representative span', () => {
  const real = countTradingSessions('2026-01-05', '2026-02-04'); // 30 calendar days
  const approx = approxTradingSessionsFromCalendarDays(30);
  assert.ok(Math.abs(real - approx) <= 1, `real=${real} approx=${approx}`);
});
