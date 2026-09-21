import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateVwapScalperExit } from '../targetAndStop.ts';
import type { Bar, VwapBandsPoint } from '../types.ts';

function bar(t: number, h: number, l: number, c: number): Bar {
  return { t, o: c, h, l, c, v: 1000 };
}
function band(vwap: number): VwapBandsPoint {
  return { vwap, stdev: 1, upper1: vwap + 1, upper2: vwap + 2, upper3: vwap + 3, lower1: vwap - 1, lower2: vwap - 2, lower3: vwap - 3 };
}

test('LONG position exits on TARGET when a bar\'s high reaches that bar\'s own VWAP', () => {
  const bars = [bar(1, 95, 90, 93), bar(2, 101, 98, 99)]; // second bar's high (101) clears its own vwap (100)
  const bands = [band(100), band(100)];
  const result = evaluateVwapScalperExit('LONG', null, bars, bands);
  assert.equal(result.exited, true);
  assert.equal(result.reason, 'TARGET');
  assert.equal(result.exitPrice, 100);
  assert.equal(result.exitBarIndex, 1);
});

test('SHORT position exits on TARGET when a bar\'s low reaches that bar\'s own VWAP', () => {
  const bars = [bar(1, 105, 102, 103), bar(2, 101, 99, 100)]; // second bar's low (99) reaches its own vwap (100)
  const bands = [band(100), band(100)];
  const result = evaluateVwapScalperExit('SHORT', null, bars, bands);
  assert.equal(result.exited, true);
  assert.equal(result.reason, 'TARGET');
  assert.equal(result.exitBarIndex, 1);
});

test('LONG position exits on STOP when a bar\'s low reaches the fixed stop price, before any target condition', () => {
  const bars = [bar(1, 100, 94, 95)]; // low (94) breaches a stop at 95, well before vwap (110) is anywhere close
  const bands = [band(110)];
  const result = evaluateVwapScalperExit('LONG', 95, bars, bands);
  assert.equal(result.exited, true);
  assert.equal(result.reason, 'STOP');
  assert.equal(result.exitPrice, 95);
});

test('SHORT position exits on STOP when a bar\'s high reaches the fixed stop price', () => {
  const bars = [bar(1, 106, 100, 101)];
  const bands = [band(90)];
  const result = evaluateVwapScalperExit('SHORT', 105, bars, bands);
  assert.equal(result.exited, true);
  assert.equal(result.reason, 'STOP');
  assert.equal(result.exitPrice, 105);
});

test('when both target and stop trigger on the SAME bar, STOP wins (the stated conservative assumption)', () => {
  // LONG: vwap=100 (target) and stop=99 — a bar whose range spans both.
  const bars = [bar(1, 101, 98, 100)];
  const bands = [band(100)];
  const result = evaluateVwapScalperExit('LONG', 99, bars, bands);
  assert.equal(result.reason, 'STOP');
});

test('returns not-exited when neither target nor stop is reached within the given bars', () => {
  const bars = [bar(1, 96, 94, 95), bar(2, 97, 95, 96)];
  const bands = [band(110), band(110)];
  const result = evaluateVwapScalperExit('LONG', 80, bars, bands);
  assert.equal(result.exited, false);
  assert.equal(result.reason, null);
  assert.equal(result.exitPrice, null);
  assert.equal(result.exitBarIndex, null);
});

test('a null stopPrice never triggers a STOP exit — only the target matters', () => {
  const bars = [bar(1, 50, 10, 20), bar(2, 105, 100, 102)]; // huge adverse move on bar 1, but stop is disabled
  const bands = [band(200), band(100)];
  const result = evaluateVwapScalperExit('LONG', null, bars, bands);
  assert.equal(result.reason, 'TARGET');
  assert.equal(result.exitBarIndex, 1);
});

test('the target price tracks each bar\'s OWN vwap, not the vwap at entry time', () => {
  // VWAP moves from 100 to 105 across two bars — a LONG target at bar 2
  // should be evaluated against 105, not the original 100.
  const bars = [bar(1, 99, 97, 98), bar(2, 106, 103, 104)];
  const bands = [band(100), band(105)];
  const result = evaluateVwapScalperExit('LONG', null, bars, bands);
  assert.equal(result.exited, true);
  assert.equal(result.exitPrice, 105);
});
