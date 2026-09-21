import { test } from 'node:test';
import assert from 'node:assert/strict';

import { black76 } from '../../quant/pricing/black76.ts';
import { simulateSymbol } from '../backtest/simulate.ts';
import type { HistoricalChainDay } from '../backtest/bhavcopy.ts';

const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);
const EXPIRY = '2026-01-21';

function dayFixture(date: string, dte: number, vol: number, spot = FORWARD): HistoricalChainDay {
  const T = dte / 365;
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right, strike, expiry: EXPIRY,
      settle: black76({ forward: spot, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest: 50_000,
      volume: 5_000,
    })),
  );
  return { date, spot, lotSize: 65, rows };
}

// Permissive thresholds throughout: these tests are about walk-forward
// mechanics (does one position open, get correctly re-quoted day by day,
// and close for the right reason at the right time), not about tuning a
// realistic quality score or exit percentage — the same technique
// src/quant/__tests__/decisionGate.test.ts already uses to force a
// deterministic action regardless of the exact score.
const PERMISSIVE_PARAMS = {
  wingWidths: [200, 400, 600],
  qualityThresholds: { noTradeBelow: -1, watchBelow: -1, highConvictionAtOrAbove: -1 },
};

test('opens exactly one position and closes it on a genuine profit-target trigger', () => {
  const days: HistoricalChainDay[] = [
    dayFixture('2026-01-01', 20, 0.15),
    dayFixture('2026-01-02', 19, 0.09), // vol drops sharply -> short structure's value drops -> profit captured
    dayFixture('2026-01-05', 16, 0.09),
  ];
  const trades = simulateSymbol(days, 'NIFTY', { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 } });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryDate, '2026-01-01');
  assert.equal(trades[0].exitDate, '2026-01-02');
  assert.equal(trades[0].exitReason, 'PROFIT_TARGET');
  assert.ok(trades[0].netPnl! > 0, `expected a real profit, got ${trades[0].netPnl}`);
  assert.ok(trades[0].charges! > 0);
});

test('never opens a second position while one is already open, even on a day that would otherwise qualify', () => {
  const days: HistoricalChainDay[] = [
    dayFixture('2026-01-01', 20, 0.15),
    dayFixture('2026-01-02', 19, 0.15), // unchanged — no exit trigger, still holding
    dayFixture('2026-01-05', 16, 0.09), // now the exit triggers
  ];
  const trades = simulateSymbol(days, 'NIFTY', { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 } });
  assert.equal(trades.length, 1); // not two, even though day 2's chain alone would also have qualified for entry
});

test('force-closes as DATA_END when the backtest window ends before any real exit condition triggers', () => {
  const days: HistoricalChainDay[] = [
    dayFixture('2026-01-01', 20, 0.15),
    dayFixture('2026-01-02', 19, 0.15), // identical vol — nothing moves, no exit trigger
  ];
  // Strict (default) exit params — profit target won't trigger on an unchanged chain.
  const trades = simulateSymbol(days, 'NIFTY', PERMISSIVE_PARAMS);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'DATA_END');
  assert.equal(trades[0].exitDate, '2026-01-02');
  // Prices were genuinely available on the last day, so P&L is computed, not null.
  assert.notEqual(trades[0].netPnl, null);
});

test('produces no trades on a chain with no usable spot/rows', () => {
  const days: HistoricalChainDay[] = [{ date: '2026-01-01', spot: null, lotSize: 65, rows: [] }];
  const trades = simulateSymbol(days, 'NIFTY', PERMISSIVE_PARAMS);
  assert.equal(trades.length, 0);
});
