import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEquityCurve, computeDrawdown, computeMetrics, runMonteCarlo } from '../backtest/metrics.ts';
import type { SimulatedTrade } from '../backtest/simulate.ts';

function trade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    symbol: 'NIFTY', strategyLabel: 'Iron Condor', entryDate: '2026-01-01', exitDate: '2026-01-10',
    expiry: '2026-01-15', legs: [], qualityScore: 80, entryDte: 14,
    maxProfit: 2000, maxLoss: 5000, exitReason: 'PROFIT_TARGET',
    grossPnl: 1200, charges: 200, netPnl: 1000,
    ...overrides,
  };
}

test('buildEquityCurve accumulates net P&L in exit-date order and excludes DATA_END trades', () => {
  const trades = [
    trade({ exitDate: '2026-01-20', netPnl: 500 }),
    trade({ exitDate: '2026-01-10', netPnl: 1000 }),
    trade({ exitDate: '2026-01-15', netPnl: -300, exitReason: 'STOP_LOSS_CREDIT_MULTIPLE' }),
    trade({ exitDate: '2026-01-25', netPnl: 9999, exitReason: 'DATA_END' }),
  ];
  const curve = buildEquityCurve(trades, 100_000);
  assert.equal(curve.length, 3); // DATA_END excluded
  assert.deepEqual(curve.map((p) => p.date), ['2026-01-10', '2026-01-15', '2026-01-20']);
  assert.equal(curve[0].equity, 101_000);
  assert.equal(curve[1].equity, 100_700);
  assert.equal(curve[2].equity, 101_200);
});

test('computeDrawdown finds the real peak-to-trough, not just the final value', () => {
  const curve = [
    { date: '2026-01-01', equity: 100_000, tradeIndex: 0 },
    { date: '2026-01-02', equity: 120_000, tradeIndex: 1 }, // peak
    { date: '2026-01-03', equity: 90_000, tradeIndex: 2 },  // trough: -30,000 from peak
    { date: '2026-01-04', equity: 110_000, tradeIndex: 3 }, // recovers, but not past the recorded drawdown
  ];
  const dd = computeDrawdown(curve);
  assert.equal(dd.maxDrawdownAmount, 30_000);
  assert.ok(Math.abs(dd.maxDrawdownPct - 25) < 0.01); // 30,000 / 120,000
  assert.equal(dd.peakDate, '2026-01-02');
  assert.equal(dd.troughDate, '2026-01-03');
});

test('computeMetrics computes win rate, profit factor and expectancy correctly on a known set', () => {
  const trades = [
    trade({ exitDate: '2026-01-05', netPnl: 1000, entryDate: '2026-01-01' }),
    trade({ exitDate: '2026-01-10', netPnl: 1000, entryDate: '2026-01-06' }),
    trade({ exitDate: '2026-01-15', netPnl: -500, entryDate: '2026-01-11', exitReason: 'STOP_LOSS_MAX_LOSS' }),
  ];
  const m = computeMetrics(trades, 100_000);
  assert.equal(m.tradeCount, 3);
  assert.ok(Math.abs(m.winRate! - 66.666) < 0.01);
  assert.ok(Math.abs(m.profitFactor! - (2000 / 500)) < 0.01);
  assert.ok(Math.abs(m.expectancy! - (1500 / 3)) < 0.01);
  assert.equal(m.avgWin, 1000);
  assert.equal(m.avgLoss, -500);
  assert.equal(m.totalNetPnl, 1500);
});

test('computeMetrics excludes DATA_END trades from every statistic', () => {
  const trades = [
    trade({ netPnl: 1000, exitDate: '2026-01-05' }),
    trade({ netPnl: 999_999, exitReason: 'DATA_END', exitDate: '2026-01-30' }),
  ];
  const m = computeMetrics(trades, 100_000);
  assert.equal(m.tradeCount, 1);
  assert.equal(m.dataEndCount, 1);
  assert.equal(m.totalNetPnl, 1000);
});

test('computeMetrics returns null Sharpe/Sortino below the minimum sample size, rather than a number built from noise', () => {
  const trades = [trade({ netPnl: 100 }), trade({ netPnl: 200, exitDate: '2026-01-11' })];
  const m = computeMetrics(trades, 100_000);
  assert.equal(m.sharpe, null);
  assert.equal(m.sortino, null);
});

test('runMonteCarlo returns null below the minimum trade count', () => {
  const trades = [trade({ netPnl: 100 })];
  assert.equal(runMonteCarlo(trades, 100_000), null);
});

test('runMonteCarlo produces a sane distribution above the minimum trade count', () => {
  const trades = Array.from({ length: 20 }, (_, i) =>
    trade({ netPnl: i % 3 === 0 ? -800 : 500, exitDate: `2026-${String(1 + (i % 12)).padStart(2, '0')}-01`, entryDate: '2026-01-01' }));
  const mc = runMonteCarlo(trades, 100_000, 500);
  assert.ok(mc);
  assert.equal(mc!.paths, 500);
  assert.ok(mc!.p5FinalEquity <= mc!.medianFinalEquity);
  assert.ok(mc!.medianFinalEquity <= mc!.p95FinalEquity);
  assert.ok(mc!.probabilityOfRuin >= 0 && mc!.probabilityOfRuin <= 1);
  assert.ok(mc!.medianMaxDrawdownPct <= mc!.p95MaxDrawdownPct);
});
