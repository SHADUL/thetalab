import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTrend, computeHigherTimeframeTrend, computeVolatilityRegime, computeWhipsaw, classifyMarketRegime,
} from '../analytics/marketRegime.ts';
import type { HistoricalClose } from '../analytics/realizedVolatility.ts';

function closesFromDailyLogReturns(startPrice: number, dailyLogReturns: number[]): HistoricalClose[] {
  const closes: HistoricalClose[] = [];
  let price = startPrice;
  for (let i = 0; i < dailyLogReturns.length; i++) {
    price *= Math.exp(dailyLogReturns[i]);
    closes.push({ date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10), close: price });
  }
  return closes;
}

/** A clean, one-directional drift with small daily noise — for trend tests. */
function trendingCloses(days: number, startPrice: number, dailyDrift: number): HistoricalClose[] {
  const returns = Array.from({ length: days }, (_, i) => dailyDrift + (i % 2 === 0 ? 0.0005 : -0.0005));
  return closesFromDailyLogReturns(startPrice, returns);
}

/** A flat, near-zero-drift, low-noise series — genuinely no trend and low realized vol. */
function flatCloses(days: number, startPrice: number): HistoricalClose[] {
  const returns = Array.from({ length: days }, (_, i) => (i % 2 === 0 ? 0.0002 : -0.0002));
  return closesFromDailyLogReturns(startPrice, returns);
}

test('computeTrend refuses with too little history', () => {
  const closes = trendingCloses(30, 25000, 0.002);
  assert.equal(computeTrend(closes, 25000 * 1.1), null);
});

test('computeTrend refuses a non-positive current spot', () => {
  const closes = trendingCloses(120, 25000, 0.002);
  assert.equal(computeTrend(closes, 0), null);
});

test('computeTrend classifies STRONG_BULLISH for a sustained uptrend with spot well above the slow EMA', () => {
  const closes = trendingCloses(120, 20000, 0.006);
  const currentSpot = closes[closes.length - 1].close * 1.05; // push spot comfortably above trailing EMAs
  const result = computeTrend(closes, currentSpot);
  assert.ok(result);
  assert.equal(result!.state, 'STRONG_BULLISH');
  assert.ok(result!.emaFastVsSlowPct > 0);
  assert.ok(result!.spotVsEmaSlowPct > 2);
});

test('computeTrend classifies STRONG_BEARISH for a sustained downtrend with spot well below the slow EMA', () => {
  const closes = trendingCloses(120, 30000, -0.006);
  const currentSpot = closes[closes.length - 1].close * 0.95;
  const result = computeTrend(closes, currentSpot);
  assert.ok(result);
  assert.equal(result!.state, 'STRONG_BEARISH');
  assert.ok(result!.emaFastVsSlowPct < 0);
  assert.ok(result!.spotVsEmaSlowPct < -2);
});

test('computeTrend classifies NEUTRAL for a perfectly constant series (fast EMA === slow EMA === spot)', () => {
  const closes: HistoricalClose[] = Array.from({ length: 120 }, (_, i) => ({
    date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10), close: 25000,
  }));
  const result = computeTrend(closes, 25000);
  assert.ok(result);
  assert.equal(result!.emaFastVsSlowPct, 0);
  assert.equal(result!.spotVsEmaSlowPct, 0);
  assert.equal(result!.state, 'NEUTRAL');
});

test('computeHigherTimeframeTrend produces a result from a long enough daily series, resampled to weekly', () => {
  const closes = trendingCloses(400, 20000, 0.003);
  const currentSpot = closes[closes.length - 1].close * 1.05;
  const result = computeHigherTimeframeTrend(closes, currentSpot);
  assert.ok(result);
  assert.ok(['STRONG_BULLISH', 'BULLISH'].includes(result!.state));
});

test('computeVolatilityRegime refuses with too little history', () => {
  const closes = flatCloses(20, 25000);
  assert.equal(computeVolatilityRegime(closes), null);
});

test('computeVolatilityRegime reads HIGH_VOLATILITY when the recent window is far more volatile than its own trailing history', () => {
  const calmReturns = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.0005 : -0.0005));
  const volatileReturns = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05));
  const combined = closesFromDailyLogReturns(25000, [...calmReturns, ...volatileReturns]);
  const result = computeVolatilityRegime(combined);
  assert.ok(result);
  assert.equal(result!.label, 'HIGH_VOLATILITY');
  assert.ok(result!.percentile >= 80, `expected percentile >= 80, got ${result!.percentile}`);
});

test('computeVolatilityRegime reads LOW_VOLATILITY when the recent window is far calmer than its own trailing history', () => {
  const volatileReturns = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05));
  const calmReturns = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.0005 : -0.0005));
  const combined = closesFromDailyLogReturns(25000, [...volatileReturns, ...calmReturns]);
  const result = computeVolatilityRegime(combined);
  assert.ok(result);
  assert.equal(result!.label, 'LOW_VOLATILITY');
  assert.ok(result!.percentile <= 20, `expected percentile <= 20, got ${result!.percentile}`);
});

test('computeWhipsaw refuses with too little history', () => {
  assert.equal(computeWhipsaw(flatCloses(10, 25000)), null);
});

test('computeWhipsaw reports a near-1.0 sign-flip ratio for a strictly alternating up/down series', () => {
  const returns = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const closes = closesFromDailyLogReturns(25000, returns);
  const result = computeWhipsaw(closes, 20);
  assert.ok(result);
  assert.ok(result!.signFlipRatio > 0.9, `expected a near-total sign-flip ratio, got ${result!.signFlipRatio}`);
});

test('computeWhipsaw reports a near-0 sign-flip ratio for a one-directional trend', () => {
  const closes = trendingCloses(40, 25000, 0.005);
  const result = computeWhipsaw(closes, 20);
  assert.ok(result);
  assert.ok(result!.signFlipRatio < 0.2, `expected a low sign-flip ratio, got ${result!.signFlipRatio}`);
});

test('classifyMarketRegime returns NO_TRADE with a stated data-gap reason when there is not enough history', () => {
  const closes = flatCloses(20, 25000);
  const result = classifyMarketRegime({ historicalCloses: closes, currentSpot: 25000 });
  assert.equal(result.regime, 'NO_TRADE');
  assert.match(result.reason, /not enough real historical closes/i);
});

test('classifyMarketRegime always lists market breadth and VWAP as unavailable, never fabricated', () => {
  const closes = trendingCloses(120, 25000, 0.002);
  const result = classifyMarketRegime({ historicalCloses: closes, currentSpot: closes[closes.length - 1].close });
  assert.ok(result.unavailable.some((u) => /breadth/i.test(u)));
  assert.ok(result.unavailable.some((u) => /VWAP/i.test(u)));
});

test('classifyMarketRegime lets a whipsaw pattern override the trend read into UNSTABLE', () => {
  const returns = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const closes = closesFromDailyLogReturns(25000, returns);
  const result = classifyMarketRegime({ historicalCloses: closes, currentSpot: closes[closes.length - 1].close });
  assert.equal(result.regime, 'UNSTABLE');
});

test('classifyMarketRegime reports a trend state when volatility is normal and there is no whipsaw', () => {
  const closes = trendingCloses(120, 20000, 0.006);
  const currentSpot = closes[closes.length - 1].close * 1.05;
  const result = classifyMarketRegime({ historicalCloses: closes, currentSpot });
  assert.equal(result.regime, 'STRONG_BULLISH');
});

test('classifyMarketRegime passes through real indiaVix/gapAndRange when supplied, and leaves them null when not', () => {
  const closes = trendingCloses(120, 25000, 0.002);
  const spot = closes[closes.length - 1].close;
  const withExtras = classifyMarketRegime({
    historicalCloses: closes, currentSpot: spot, indiaVix: 13.5,
    gapAndRange: { gapPct: 0.3, intradayRangePct: 0.8 },
  });
  assert.equal(withExtras.indiaVix, 13.5);
  assert.deepEqual(withExtras.gapAndRange, { gapPct: 0.3, intradayRangePct: 0.8 });

  const withoutExtras = classifyMarketRegime({ historicalCloses: closes, currentSpot: spot });
  assert.equal(withoutExtras.indiaVix, null);
  assert.equal(withoutExtras.gapAndRange, null);
});
