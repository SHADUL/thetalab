import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRollingWindows } from '../analytics/rollingMetrics.ts';

function trade(netPnl: number, date: string) { return { netPnl, exitDate: date }; }

test('computeRollingWindows returns null metrics for an empty history', () => {
  const [w20] = computeRollingWindows([], [20]);
  assert.equal(w20.tradeCount, 0);
  assert.equal(w20.expectancy, null);
});

test('computeRollingWindows uses only the LAST N trades for each window size', () => {
  const trades = Array.from({ length: 40 }, (_, i) => trade(i < 20 ? -100 : 100, `2026-01-${(i % 28) + 1}`));
  const [w20, w30] = computeRollingWindows(trades, [20, 30]);
  assert.equal(w20.tradeCount, 20);
  // last 20 are all +100 -> pure win
  assert.equal(w20.winRate, 1);
  assert.equal(w20.expectancy, 100);
  // last 30 mix 10 losers + 20 winners
  assert.equal(w30.tradeCount, 30);
  assert.ok(w30.winRate! < 1 && w30.winRate! > 0);
});

test('computeRollingWindows: profit factor and avg win/loss are computed correctly', () => {
  const trades = [trade(200, 'd1'), trade(200, 'd2'), trade(-100, 'd3')];
  const [w] = computeRollingWindows(trades, [10]);
  assert.equal(w.tradeCount, 3);
  assert.ok(Math.abs(w.avgWin! - 200) < 1e-9);
  assert.ok(Math.abs(w.avgLoss! - (-100)) < 1e-9);
  assert.ok(Math.abs(w.profitFactor! - 4) < 1e-9); // 400 gross win / 100 gross loss
});
