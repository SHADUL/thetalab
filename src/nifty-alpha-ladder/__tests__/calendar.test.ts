import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTradingDay, isSignalWeekday, isWithinSignalWindow, weekIdempotencyKey, SESSION_WINDOW_START_MIN, SESSION_WINDOW_END_MIN } from '../calendar/signalCalendar.ts';

const noHolidays = () => false;

test('normal Wednesday: a trading day and a signal weekday', () => {
  const wed = new Date('2026-09-30T00:00:00Z'); // a Wednesday
  assert.equal(isTradingDay(wed, noHolidays), true);
  assert.equal(isSignalWeekday(wed, false), true);
});

test('Wednesday holiday -> Thursday fallback is a signal weekday', () => {
  const thu = new Date('2026-10-01T00:00:00Z'); // the Thursday after the Wednesday above
  // precedingWednesdayHadData = false because Wednesday was a holiday (no data)
  assert.equal(isSignalWeekday(thu, false), true);
});

test('normal Wednesday with no fire -> Thursday is rejected (at most one signal day per week)', () => {
  const thu = new Date('2026-10-01T00:00:00Z');
  // precedingWednesdayHadData = true because Wednesday WAS a trading session with data, it just didn't fire
  assert.equal(isSignalWeekday(thu, true), false);
});

test('exchange holiday is rejected as a trading day', () => {
  const wed = new Date('2026-09-30T00:00:00Z');
  const isHoliday = (d: Date) => d.toISOString().slice(0, 10) === '2026-09-30';
  assert.equal(isTradingDay(wed, isHoliday), false);
});

test('weekend is never a trading day regardless of the holiday calendar', () => {
  const sat = new Date('2026-10-03T00:00:00Z');
  assert.equal(isTradingDay(sat, noHolidays), false);
});

test('Monday and Friday are never signal weekdays', () => {
  assert.equal(isSignalWeekday(new Date('2026-09-28T00:00:00Z'), false), false); // Monday
  assert.equal(isSignalWeekday(new Date('2026-10-02T00:00:00Z'), false), false); // Friday
});

test('session window boundaries: 09:31 and 14:31 inclusive, 09:30 and 14:32 excluded', () => {
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_START_MIN), true);
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_END_MIN), true);
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_START_MIN - 1), false);
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_END_MIN + 1), false);
});

test('weekIdempotencyKey: Wednesday keys to itself, Thursday keys to the preceding Wednesday', () => {
  assert.equal(weekIdempotencyKey(new Date('2026-09-30T00:00:00Z')), '2026-09-30');
  assert.equal(weekIdempotencyKey(new Date('2026-10-01T00:00:00Z')), '2026-09-30');
});
