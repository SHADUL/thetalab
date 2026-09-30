import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nowIST, MARKET_OPEN_MIN, SESSION_WINDOW_START_MIN, SESSION_WINDOW_END_MIN, SIGNAL_CUTOFF_MIN,
  SCHEDULED_EXIT_MIN, SAFETY_EXIT_MIN, MARKET_CLOSE_MIN,
  isWithinSignalWindow, isPastSignalCutoff, isScheduledExitTime, isSafetyExitTime, isMarketOpen,
} from '../calendar/istClock.ts';

// A fixed instant: 2026-09-30T04:02:25Z = 2026-09-30 09:32:25 IST.
const KNOWN_INSTANT_UTC = Date.UTC(2026, 8, 30, 4, 2, 25);

test('nowIST: converts a real UTC instant to the correct IST calendar date and minute, regardless of server timezone', () => {
  const result = nowIST(KNOWN_INSTANT_UTC);
  assert.equal(result.dateISO, '2026-09-30');
  assert.equal(result.minutesSinceMidnight, 9 * 60 + 32);
});

test('nowIST: IST midnight rollover — 18:30 UTC is the START of the next IST day (00:00 IST)', () => {
  const result = nowIST(Date.UTC(2026, 8, 30, 18, 30, 0));
  assert.equal(result.dateISO, '2026-10-01');
  assert.equal(result.minutesSinceMidnight, 0);
});

test('boundary: 09:15 market open is exactly on the boundary (inclusive)', () => {
  assert.equal(isMarketOpen(MARKET_OPEN_MIN), true);
  assert.equal(isMarketOpen(MARKET_OPEN_MIN - 1), false);
});

test('boundary: 09:31-14:31 signal lattice is inclusive on both ends', () => {
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_START_MIN), true);
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_START_MIN - 1), false);
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_END_MIN), true);
  assert.equal(isWithinSignalWindow(SESSION_WINDOW_END_MIN + 1), false);
});

test('boundary: 14:30 cutoff — exactly 14:30 counts as past cutoff, 14:29 does not', () => {
  assert.equal(isPastSignalCutoff(SIGNAL_CUTOFF_MIN), true);
  assert.equal(isPastSignalCutoff(SIGNAL_CUTOFF_MIN - 1), false);
});

test('boundary: 15:10 scheduled exit', () => {
  assert.equal(isScheduledExitTime(SCHEDULED_EXIT_MIN), true);
  assert.equal(isScheduledExitTime(SCHEDULED_EXIT_MIN - 1), false);
});

test('boundary: 15:20 safety exit', () => {
  assert.equal(isSafetyExitTime(SAFETY_EXIT_MIN), true);
  assert.equal(isSafetyExitTime(SAFETY_EXIT_MIN - 1), false);
});

test('boundary: 15:30 market close is the last open minute (inclusive)', () => {
  assert.equal(isMarketOpen(MARKET_CLOSE_MIN), true);
  assert.equal(isMarketOpen(MARKET_CLOSE_MIN + 1), false);
});

test('exact minute values match the PDF exactly: 09:15, 09:31, 14:30, 14:31, 15:10, 15:20, 15:30', () => {
  assert.equal(MARKET_OPEN_MIN, 555);
  assert.equal(SESSION_WINDOW_START_MIN, 571);
  assert.equal(SIGNAL_CUTOFF_MIN, 870);
  assert.equal(SESSION_WINDOW_END_MIN, 871);
  assert.equal(SCHEDULED_EXIT_MIN, 910);
  assert.equal(SAFETY_EXIT_MIN, 920);
  assert.equal(MARKET_CLOSE_MIN, 930);
});
