import { test } from 'node:test';
import assert from 'node:assert/strict';

import { simulateTrade } from '../backtest/simulate.ts';
import { classifyRegimeSeries } from '../backtest/regime.ts';
import { computeMetrics, scoreBucketFor, groupBy } from '../backtest/metrics.ts';
import type { Bar } from '../indicators/types.ts';
import type { SimulatedTrade } from '../backtest/types.ts';

function bar(t: string, c: number, opts: Partial<Bar> = {}): Bar {
  return { t, o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 1_000_000 };
}

/* ---------------- simulateTrade ---------------- */

test('simulateTrade: target hit before stop', () => {
  const bars = [
    bar('d0', 100),
    bar('d1', 103, { h: 104, l: 101 }),
    bar('d2', 111, { o: 108, h: 112, l: 108 }), // opens under target, intrades through it
  ];
  const result = simulateTrade(bars, 0, 90, 110, 20)!;
  assert.equal(result.exitReason, 'TARGET');
  assert.equal(result.exitIdx, 2);
  assert.equal(result.exitPrice, 110);
  assert.equal(result.holdingDays, 2);
});

test('simulateTrade: stop hit before target', () => {
  const bars = [
    bar('d0', 100),
    bar('d1', 97, { h: 101, l: 96 }),
    bar('d2', 89, { o: 92, h: 98, l: 88 }), // opens above stop, intrades through it
  ];
  const result = simulateTrade(bars, 0, 90, 110, 20)!;
  assert.equal(result.exitReason, 'STOP');
  assert.equal(result.exitIdx, 2);
  assert.equal(result.exitPrice, 90);
});

test('simulateTrade: both stop and target crossed same day — STOP wins (conservative)', () => {
  const bars = [
    bar('d0', 100),
    bar('d1', 105, { h: 115, l: 85 }), // huge range day, both 90 and 110 crossed
  ];
  const result = simulateTrade(bars, 0, 90, 110, 20)!;
  assert.equal(result.exitReason, 'STOP');
});

test('simulateTrade: gap-down through stop fills at the open, not the stop price', () => {
  const bars = [
    bar('d0', 100),
    bar('d1', 82, { o: 83, h: 84, l: 80 }), // opened below the stop of 90
  ];
  const result = simulateTrade(bars, 0, 90, 110, 20)!;
  assert.equal(result.exitReason, 'STOP');
  assert.equal(result.exitPrice, 83);
});

test('simulateTrade: gap-up through target fills at the open, not the target price', () => {
  const bars = [
    bar('d0', 100),
    bar('d1', 118, { o: 115, h: 120, l: 114 }), // opened above the target of 110
  ];
  const result = simulateTrade(bars, 0, 90, 110, 20)!;
  assert.equal(result.exitReason, 'TARGET');
  assert.equal(result.exitPrice, 115);
});

test('simulateTrade: neither hit within the holding window — TIMEOUT at window close', () => {
  const bars = [bar('d0', 100), ...Array.from({ length: 5 }, (_, i) => bar(`d${i + 1}`, 100 + i, { h: 102 + i, l: 95 }))];
  const result = simulateTrade(bars, 0, 90, 110, 3)!;
  assert.equal(result.exitReason, 'TIMEOUT');
  assert.equal(result.exitIdx, 3); // entryIdx(0) + maxHoldingDays(3)
});

test('simulateTrade: runs out of real data before the window ends — DATA_END, not TIMEOUT', () => {
  const bars = [bar('d0', 100), bar('d1', 101, { h: 102, l: 99 })]; // only 1 day of future data
  const result = simulateTrade(bars, 0, 90, 110, 20)!;
  assert.equal(result.exitReason, 'DATA_END');
  assert.equal(result.exitIdx, 1);
});

test('simulateTrade: no-look-ahead — appending bars after the exit day does not change the result', () => {
  const barsShort = [bar('d0', 100), bar('d1', 103, { h: 104, l: 101 }), bar('d2', 111, { o: 108, h: 112, l: 108 })];
  const barsLong = [...barsShort, bar('d3', 200, { h: 250, l: 190 }), bar('d4', 50, { h: 60, l: 40 })];
  const short = simulateTrade(barsShort, 0, 90, 110, 20)!;
  const long = simulateTrade(barsLong, 0, 90, 110, 20)!;
  assert.deepEqual(short, long);
});

test('simulateTrade: unknown entry index returns null', () => {
  assert.equal(simulateTrade([bar('d0', 100)], 5, 90, 110, 20), null);
});

/* ---------------- classifyRegimeSeries ---------------- */

test('classifyRegimeSeries: sustained uptrend classifies as BULLISH once SMA200 exists', () => {
  const n = 260;
  const dates = Array.from({ length: n }, (_, i) => `d${i}`);
  const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.5); // steady rise
  const regimes = classifyRegimeSeries(dates, closes);
  assert.equal(regimes.get('d259'), 'BULLISH');
});

test('classifyRegimeSeries: sustained downtrend classifies as BEARISH', () => {
  const n = 260;
  const dates = Array.from({ length: n }, (_, i) => `d${i}`);
  const closes = Array.from({ length: n }, (_, i) => 300 - i * 0.5);
  const regimes = classifyRegimeSeries(dates, closes);
  assert.equal(regimes.get('d259'), 'BEARISH');
});

test('classifyRegimeSeries: too little history yet — no entry rather than a guessed label', () => {
  const dates = ['d0', 'd1', 'd2'];
  const closes = [100, 101, 102];
  const regimes = classifyRegimeSeries(dates, closes);
  assert.equal(regimes.size, 0);
});

/* ---------------- computeMetrics ---------------- */

function trade(returnPct: number, exitReason: SimulatedTrade['exitReason'], holdingDays = 5): SimulatedTrade {
  return {
    entryIdx: 0, entryDate: 'd0', entryPrice: 100, stop: 90, target: 110,
    exitIdx: holdingDays, exitDate: `d${holdingDays}`, exitPrice: 100 * (1 + returnPct / 100),
    exitReason, holdingDays, returnPct,
  };
}

test('computeMetrics: hand-computed small example', () => {
  const trades = [trade(10, 'TARGET'), trade(-5, 'STOP'), trade(10, 'TARGET'), trade(-2, 'TIMEOUT')];
  const m = computeMetrics(trades);
  assert.equal(m.count, 4);
  assert.equal(m.targetHitRate, 0.5);
  assert.equal(m.positiveReturnRate, 0.5);
  assert.ok(Math.abs(m.expectancyPct! - (10 - 5 + 10 - 2) / 4) < 1e-9);
  assert.ok(Math.abs(m.profitFactor! - 20 / 7) < 1e-9);
});

test('computeMetrics: DATA_END trades are excluded from every stat', () => {
  const trades = [trade(10, 'TARGET'), trade(0, 'DATA_END', 0)];
  const m = computeMetrics(trades);
  assert.equal(m.count, 1);
  assert.equal(m.targetHitRate, 1);
});

test('computeMetrics: no trades returns all-null rather than dividing by zero', () => {
  const m = computeMetrics([]);
  assert.equal(m.count, 0);
  assert.equal(m.expectancyPct, null);
  assert.equal(m.profitFactor, null);
});

test('computeMetrics: no losing trades — profit factor is null (undefined), not Infinity', () => {
  const m = computeMetrics([trade(10, 'TARGET'), trade(5, 'TARGET')]);
  assert.equal(m.profitFactor, null);
});

/* ---------------- scoreBucketFor / groupBy ---------------- */

test('scoreBucketFor: boundaries', () => {
  assert.equal(scoreBucketFor(0), '<60');
  assert.equal(scoreBucketFor(59), '<60');
  assert.equal(scoreBucketFor(60), '60-70');
  assert.equal(scoreBucketFor(89), '80-90');
  assert.equal(scoreBucketFor(90), '90+');
  assert.equal(scoreBucketFor(100), '90+');
});

test('groupBy: groups items by the key function', () => {
  const groups = groupBy([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? 'even' : 'odd'));
  assert.deepEqual(groups.get('odd'), [1, 3, 5]);
  assert.deepEqual(groups.get('even'), [2, 4]);
});
