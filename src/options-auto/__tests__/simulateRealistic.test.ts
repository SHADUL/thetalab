import { test } from 'node:test';
import assert from 'node:assert/strict';

import { black76 } from '../../quant/pricing/black76.ts';
import { simulateSymbol, simulateSymbolRealistic } from '../backtest/simulate.ts';
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

const PERMISSIVE_PARAMS = {
  wingWidths: [200, 400, 600],
  qualityThresholds: { noTradeBelow: -1, watchBelow: -1, highConvictionAtOrAbove: -1 },
};

test('simulateSymbol (unchanged) is unaffected by simulateSymbolRealistic existing in the same module', () => {
  const days: HistoricalChainDay[] = [
    dayFixture('2026-01-01', 20, 0.15),
    dayFixture('2026-01-02', 19, 0.09),
    dayFixture('2026-01-05', 16, 0.09),
  ];
  const trades = simulateSymbol(days, 'NIFTY', { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 } });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'PROFIT_TARGET');
});

test('simulateSymbolRealistic: IDEAL nets MORE than REALISTIC, which nets MORE than STRESS, on the identical trade sequence', () => {
  const days: HistoricalChainDay[] = [
    dayFixture('2026-01-01', 20, 0.15),
    dayFixture('2026-01-02', 19, 0.09),
    dayFixture('2026-01-05', 16, 0.09),
  ];
  const params = { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 } };
  const ideal = simulateSymbolRealistic(days, 'NIFTY', { ...params, fillMode: 'IDEAL' as const });
  const realistic = simulateSymbolRealistic(days, 'NIFTY', { ...params, fillMode: 'REALISTIC' as const });
  const stress = simulateSymbolRealistic(days, 'NIFTY', { ...params, fillMode: 'STRESS' as const });

  assert.equal(ideal.length, 1); assert.equal(realistic.length, 1); assert.equal(stress.length, 1);
  assert.ok(ideal[0].netPnl! >= realistic[0].netPnl!, `IDEAL ${ideal[0].netPnl} should be >= REALISTIC ${realistic[0].netPnl}`);
  assert.ok(realistic[0].netPnl! >= stress[0].netPnl!, `REALISTIC ${realistic[0].netPnl} should be >= STRESS ${stress[0].netPnl}`);
  assert.ok(ideal[0].netPnl! > stress[0].netPnl!, 'IDEAL must be materially better than STRESS, not tied');
});

test('simulateSymbolRealistic: every closed trade carries a full cost breakdown and data-quality labels', () => {
  const days: HistoricalChainDay[] = [
    dayFixture('2026-01-01', 20, 0.15),
    dayFixture('2026-01-02', 19, 0.09),
  ];
  const trades = simulateSymbolRealistic(days, 'NIFTY', { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 } });
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.ok(t.costBreakdown);
  assert.equal(t.dataQuality.pricingData, 'EOD_SETTLEMENT');
  assert.equal(t.dataQuality.bidAsk, 'UNAVAILABLE');
  assert.equal(t.dataQuality.margin, 'HISTORICAL_MODEL');
  assert.ok(t.costToCreditPct !== null && t.costToCreditPct >= 0);
});

test('simulateSymbolRealistic: without historicalCloses/ivHistory, premiumEdge/independentEv/ivRank are honestly UNAVAILABLE, never fabricated', () => {
  const days: HistoricalChainDay[] = [dayFixture('2026-01-01', 20, 0.15), dayFixture('2026-01-02', 19, 0.09)];
  const trades = simulateSymbolRealistic(days, 'NIFTY', { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 } });
  assert.equal(trades[0].ivRankAvailable, false);
  assert.equal(trades[0].premiumEdgeAvailable, false);
  assert.equal(trades[0].independentEvAvailable, false);
  assert.equal(trades[0].dataQuality.historicalIv, 'UNAVAILABLE');
});

test('simulateSymbolRealistic: with a real historicalCloses series, premiumEdge/independentEv become available', () => {
  const days: HistoricalChainDay[] = [dayFixture('2026-01-01', 20, 0.15), dayFixture('2026-01-02', 19, 0.09)];
  const historicalCloses = Array.from({ length: 300 }, (_, i) => ({
    date: new Date(Date.parse('2025-01-01') + i * 86_400_000).toISOString().slice(0, 10),
    close: FORWARD + 200 * Math.sin(i / 10),
  }));
  const trades = simulateSymbolRealistic(days, 'NIFTY', { ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 }, historicalCloses });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].premiumEdgeAvailable, true, 'premiumEdge should be available with real history supplied');
  assert.equal(trades[0].independentEvAvailable, true, 'independentEv should be available with real history supplied');
});

test('simulateSymbolRealistic: a starting equity enables real portfolio-aware position sizing and can size to zero (no trade) under a tight risk limit', () => {
  const days: HistoricalChainDay[] = [dayFixture('2026-01-01', 20, 0.15), dayFixture('2026-01-02', 19, 0.09)];
  const tinyEquityTrades = simulateSymbolRealistic(days, 'NIFTY', {
    ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 },
    startingEquity: 1000, // far too small for even 1 lot at the production 2% risk/trade default
  });
  assert.equal(tinyEquityTrades.length, 0, 'a genuinely too-small account must size to zero lots, not silently trade anyway');

  const healthyEquityTrades = simulateSymbolRealistic(days, 'NIFTY', {
    ...PERMISSIVE_PARAMS, exitParams: { profitTargetPct: 1 },
    startingEquity: 5_000_000,
  });
  assert.equal(healthyEquityTrades.length, 1);
  assert.ok(healthyEquityTrades[0].lots >= 1);
});
