import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryBlock, exitCheck, istClock, shadowFill } from '../lifecycle.ts';
import { IST, SIGNAL_DATE, EXPIRY } from './fakes.ts';

const sig = { signalDate: SIGNAL_DATE, createdAtMs: IST(SIGNAL_DATE, 10, 13) };
const base = (nowMs: number) => ({ clock: istClock(nowMs), nowMs, isTradingDay: true, modeEnabled: true, killSwitch: false, signal: sig, alreadyEnteredThisWeek: false });

test('entry: allowed on the signal day right after the signal', () => {
  assert.equal(entryBlock(base(IST(SIGNAL_DATE, 10, 14))), null);
});

test('entry: blocked without a signal, on another day, after the grace window, twice in a week, when disabled or killed', () => {
  const now = IST(SIGNAL_DATE, 10, 14);
  assert.equal(entryBlock({ ...base(now), signal: null }), 'NO_SIGNAL_THIS_WEEK');
  assert.equal(entryBlock(base(IST('2026-10-15', 10, 14))), 'SIGNAL_NOT_TODAY');
  assert.equal(entryBlock(base(IST(SIGNAL_DATE, 10, 40))), 'ENTRY_WINDOW_PASSED');
  assert.equal(entryBlock({ ...base(now), alreadyEnteredThisWeek: true }), 'ALREADY_ENTERED_THIS_WEEK');
  assert.equal(entryBlock({ ...base(now), modeEnabled: false }), 'MODE_DISABLED');
  assert.equal(entryBlock({ ...base(now), killSwitch: true }), 'KILL_SWITCH');
  assert.equal(entryBlock(base(IST(SIGNAL_DATE, 15, 45))), 'OUTSIDE_MARKET_HOURS');
});

const pos = { direction: -1 as const, f0: 24_211.8, expiry: EXPIRY };

test('monitor: 300 points Wed-Fri (worked example target 23,911.80) — hit at or beyond it', () => {
  const fri = IST('2026-10-16', 13, 41);
  assert.equal(exitCheck({ ...pos, clock: istClock(fri), isTradingDay: true, futureLtp: 23_912 }).exit, false);
  const hit = exitCheck({ ...pos, clock: istClock(fri), isTradingDay: true, futureLtp: 23_910.5 });
  assert.equal(hit.reason, 'TARGET_HIT');
  assert.equal(hit.target.toFixed(2), '23911.80');
});

test('monitor: 400 points on Monday and Tuesday (23,811.80)', () => {
  const mon = IST('2026-10-19', 11, 0);
  assert.equal(exitCheck({ ...pos, clock: istClock(mon), isTradingDay: true, futureLtp: 23_900 }).exit, false);
  assert.equal(exitCheck({ ...pos, clock: istClock(mon), isTradingDay: true, futureLtp: 23_811.8 }).reason, 'TARGET_HIT');
});

test('monitor: ticks outside 09:15-15:30 never trigger', () => {
  assert.equal(exitCheck({ ...pos, clock: istClock(IST('2026-10-16', 16, 0)), isTradingDay: true, futureLtp: 23_000 }).exit, false);
});

test('scheduled exit 15:10 and safety net 15:20 on the expiry day only; no stop otherwise', () => {
  assert.equal(exitCheck({ ...pos, clock: istClock(IST(EXPIRY, 15, 9)), isTradingDay: true, futureLtp: 24_400 }).exit, false);
  assert.equal(exitCheck({ ...pos, clock: istClock(IST(EXPIRY, 15, 10)), isTradingDay: true, futureLtp: 24_400 }).reason, 'SCHEDULED_EXIT');
  assert.equal(exitCheck({ ...pos, clock: istClock(IST(EXPIRY, 15, 21)), isTradingDay: true, futureLtp: 24_400 }).reason, 'SAFETY_EXIT');
  assert.equal(exitCheck({ ...pos, clock: istClock(IST('2026-10-19', 15, 15)), isTradingDay: true, futureLtp: 24_900 }).exit, false); // deep adverse, not expiry day: holds
});

test('a position still open after its expiry date is EXPIRED', () => {
  assert.equal(exitCheck({ ...pos, clock: istClock(IST('2026-10-21', 9, 30)), isTradingDay: true, futureLtp: 24_000 }).reason, 'EXPIRED');
});

test('SHADOW fill: BUY only at an ask within the marketable limit, SELL only at a bid within it — never at LTP', () => {
  assert.deepEqual(shadowFill('BUY', { ltp: 36.8, bid: 36.75, ask: 36.95 }), { limit: 39.8, fill: 36.95 });
  assert.equal(shadowFill('BUY', { ltp: 36.8, bid: 36.75, ask: 41 }), null);
  assert.equal(shadowFill('SELL', { ltp: 118.6, bid: 118.45, ask: 118.7 })!.fill, 118.45);
  assert.equal(shadowFill('SELL', { ltp: 118.6, bid: 100, ask: 118.7 }), null);
  assert.equal(shadowFill('BUY', { ltp: 36.8, bid: null, ask: null }), null);
});
