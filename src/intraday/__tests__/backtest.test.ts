import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeIntradayRoundTripCosts, applySlippage } from '../backtest/costs.ts';
import { simulateIntradayExit } from '../backtest/simulate.ts';
import { computeIntradayMetrics, scoreBucketFor } from '../backtest/metrics.ts';
import type { IntradayBar } from '../types.ts';
import type { SimulatedIntradayTrade } from '../backtest/types.ts';

function istTime(dateStr: string, hh: number, mm: number): number {
  return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).getTime();
}
function bar(hh: number, mm: number, c: number, opts: Partial<IntradayBar> = {}): IntradayBar {
  return { t: istTime('2026-09-15', hh, mm), o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 100_000 };
}

/* ---------------- costs.ts ---------------- */

test('computeIntradayRoundTripCosts: brokerage uses the % rate for a small trade', () => {
  // turnover small enough that 0.03% stays under the ₹20 cap on both legs
  const cost = computeIntradayRoundTripCosts(100, 101, 10, 'LONG');
  assert.ok(cost > 0 && cost < 5); // sanity band, not an exact-match assertion on every fee line
});

test('computeIntradayRoundTripCosts: brokerage is capped at ₹20 per leg on a large trade', () => {
  const costLarge = computeIntradayRoundTripCosts(1000, 1010, 10_000, 'LONG');
  const costHuge = computeIntradayRoundTripCosts(1000, 1010, 100_000, 'LONG');
  // Brokerage is capped, but STT/exchange/stamp duty scale with turnover — so cost
  // grows with size, just sub-linearly past the point brokerage saturates.
  assert.ok(costHuge > costLarge);
  assert.ok(costHuge < costLarge * 10); // nowhere near proportional to the 10x turnover jump
});

test('computeIntradayRoundTripCosts: SHORT direction still charges STT on the sell leg (the entry)', () => {
  const cost = computeIntradayRoundTripCosts(100, 95, 100, 'SHORT');
  assert.ok(cost > 0);
});

test('applySlippage: LONG gets a worse (higher) entry and a worse (lower) exit', () => {
  const entry = applySlippage(100, 'LONG', 'ENTRY');
  const exit = applySlippage(100, 'LONG', 'EXIT');
  assert.ok(entry > 100);
  assert.ok(exit < 100);
});

test('applySlippage: SHORT gets a worse (lower) entry and a worse (higher) exit', () => {
  const entry = applySlippage(100, 'SHORT', 'ENTRY');
  const exit = applySlippage(100, 'SHORT', 'EXIT');
  assert.ok(entry < 100);
  assert.ok(exit > 100);
});

/* ---------------- simulate.ts ---------------- */

test('simulateIntradayExit: LONG stop hit exits at the stop price with reason STOP', () => {
  const bars = [
    bar(10, 0, 100), // entryIdx
    bar(10, 5, 99, { o: 99.8, h: 99.9, l: 98.5 }), // stop=99 gets hit
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 99, 102, 104, vwapSeries, 10);
  assert.equal(exit.exitReason, 'STOP');
  assert.equal(exit.exitPrice, 99);
});

test('simulateIntradayExit: a gap through the stop fills at the bar open, not the stop level', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 96, { o: 97, h: 97.2, l: 95.8 }), // opens already below the stop of 99
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 99, 102, 104, vwapSeries, 10);
  assert.equal(exit.exitReason, 'STOP');
  assert.equal(exit.exitPrice, 97);
});

test('simulateIntradayExit: LONG target2 hit exits at target2 with reason TARGET2', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 104.5, { o: 103, h: 105, l: 102.8 }), // target2=104 gets hit
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 98, 102, 104, vwapSeries, 10);
  assert.equal(exit.exitReason, 'TARGET2');
  assert.equal(exit.exitPrice, 104);
});

test('simulateIntradayExit: a bar crossing both stop and target2 resolves as STOP (conservative)', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 101, { o: 100.5, h: 105, l: 97 }), // wide range bar: both stop(99) and target2(104) are inside it
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 99, 102, 104, vwapSeries, 10);
  assert.equal(exit.exitReason, 'STOP');
});

test('simulateIntradayExit: reaching target1 walks the stop to breakeven, then a later pullback exits as TRAIL not STOP', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 102.5, { o: 101, h: 102.6, l: 100.9 }), // closes at/above target1=102 -> stop trails to 100
    bar(10, 10, 99.8, { o: 102.4, h: 102.5, l: 99.7 }), // falls back through the breakeven stop (100)
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 98, 102, 104, vwapSeries, 10);
  assert.equal(exit.exitReason, 'TRAIL');
  assert.equal(exit.exitPrice, 100);
});

test('simulateIntradayExit: VWAP Pullback setup exits on MOMENTUM_FAILURE when price closes the wrong side of VWAP before target1', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 99, { o: 100, h: 100.1, l: 98.9 }), // closes below VWAP(100), direction LONG, before target1
  ];
  const vwapSeries = [100, 100];
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'VWAP_PULLBACK', 100, 95, 105, 110, vwapSeries, 10);
  assert.equal(exit.exitReason, 'MOMENTUM_FAILURE');
});

test('simulateIntradayExit: ORB setup does NOT get a momentum-failure exit (only VWAP/EMA setups do)', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 99, { o: 100, h: 100.1, l: 98.9 }), // same "wrong side of vwap" bar as above
  ];
  const vwapSeries = [100, 100];
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 95, 105, 110, vwapSeries, 10);
  assert.notEqual(exit.exitReason, 'MOMENTUM_FAILURE');
});

test('simulateIntradayExit: neither stop nor target hit by square-off exits EOD_SQUAREOFF at that bar\'s close', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 100.5, { o: 100.1, h: 100.6, l: 99.9 }),
    bar(10, 10, 100.8, { o: 100.5, h: 100.9, l: 100.3 }), // squareOffBarIdx=2 stops the walk here
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'LONG', 'ORB', 100, 95, 110, 120, vwapSeries, 2);
  assert.equal(exit.exitReason, 'EOD_SQUAREOFF');
  assert.equal(exit.exitIdx, 2);
  assert.equal(exit.exitPrice, 100.8);
});

test('simulateIntradayExit: SHORT direction mirrors LONG for stop/target', () => {
  const bars = [
    bar(10, 0, 100),
    bar(10, 5, 96, { o: 98, h: 98.5, l: 95.5 }), // target2=96 hit for a SHORT
  ];
  const vwapSeries = bars.map(() => 100);
  const exit = simulateIntradayExit(bars, 0, 'SHORT', 'ORB', 100, 104, 98, 96, vwapSeries, 10);
  assert.equal(exit.exitReason, 'TARGET2');
  assert.equal(exit.exitPrice, 96);
});

/* ---------------- metrics.ts ---------------- */

function trade(overrides: Partial<SimulatedIntradayTrade> = {}): SimulatedIntradayTrade {
  return {
    symbol: 'TEST', sector: 'IT', date: '2026-09-15', direction: 'LONG', setupType: 'ORB',
    score: 75, confidence: 'B', regime: 'BULLISH' as never, entryTime: 0, entryPrice: 100,
    stop: 98, target1: 102, target2: 104, shares: 100, exitTime: 0, exitPrice: 102,
    exitReason: 'TARGET2', riskPerShare: 2, rMultipleGross: 1, rMultipleNet: 0.9,
    pnlGross: 200, pnlNet: 180, costs: 20,
    ...overrides,
  };
}

test('computeIntradayMetrics: empty trade list returns nulls, not NaN/Infinity', () => {
  const m = computeIntradayMetrics([]);
  assert.equal(m.count, 0);
  assert.equal(m.winRateNet, null);
  assert.equal(m.profitFactorNet, null);
});

test('computeIntradayMetrics: mixed win/loss computes win rate and expectancy correctly', () => {
  const trades = [
    trade({ rMultipleGross: 2, rMultipleNet: 1.8 }),
    trade({ rMultipleGross: -1, rMultipleNet: -1.1, exitReason: 'STOP' }),
  ];
  const m = computeIntradayMetrics(trades);
  assert.equal(m.count, 2);
  assert.equal(m.winRateNet, 0.5);
  assert.ok(Math.abs((m.expectancyRNet ?? 0) - 0.35) < 1e-9); // (1.8 + -1.1)/2
});

test('computeIntradayMetrics: all-wins reports profitFactor as null (no losses to divide by), not Infinity', () => {
  const trades = [trade(), trade()];
  const m = computeIntradayMetrics(trades);
  assert.equal(m.profitFactorNet, null);
});

test('scoreBucketFor: bands', () => {
  assert.equal(scoreBucketFor(55), '<60');
  assert.equal(scoreBucketFor(65), '60-70');
  assert.equal(scoreBucketFor(95), '90+');
});
