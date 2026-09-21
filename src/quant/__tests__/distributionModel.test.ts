import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEmpiricalReturns, empiricalBreachProbability, normalBreachProbability,
  computeIndependentPop, computeIndependentExpectedValue,
} from '../analytics/distributionModel.ts';
import type { HistoricalClose } from '../analytics/realizedVolatility.ts';

/** A uniform daily log-return series — every day moves by exactly `dailyLogReturn` (closed-form, not accumulated multiplication, to keep floating-point drift minimal), so horizon-1 returns are all extremely close to the same known value. */
function uniformCloses(days: number, startPrice: number, dailyLogReturn: number): HistoricalClose[] {
  const closes: HistoricalClose[] = [];
  for (let i = 0; i < days; i++) {
    closes.push({ date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10), close: startPrice * Math.exp(dailyLogReturn * i) });
  }
  return closes;
}

test('buildEmpiricalReturns refuses with fewer than MIN_RETURNS_FOR_RV observations', () => {
  const closes = uniformCloses(10, 25000, 0.01);
  assert.equal(buildEmpiricalReturns(closes, 1), null);
});

test('buildEmpiricalReturns refuses a non-positive horizon', () => {
  const closes = uniformCloses(40, 25000, 0.01);
  assert.equal(buildEmpiricalReturns(closes, 0), null);
});

test('buildEmpiricalReturns produces the exact known log return for a uniform-move series', () => {
  const dailyLogReturn = 0.012;
  const closes = uniformCloses(40, 25000, dailyLogReturn);
  const returns = buildEmpiricalReturns(closes, 1);
  assert.ok(returns);
  assert.equal(returns!.length, 39);
  for (const r of returns!) assert.ok(Math.abs(r - dailyLogReturn) < 1e-9);
});

test('empiricalBreachProbability is 1 when every historical move clears the upper threshold, 0 when the threshold is set higher', () => {
  const dailyLogReturn = 0.012;
  const closes = uniformCloses(40, 25000, dailyLogReturn);
  const returns = buildEmpiricalReturns(closes, 1)!;
  const spot = 25000;
  // A hair below the known return (not exactly at it, to stay clear of
  // floating-point noise in the accumulated closes) — every return should
  // still clear this threshold.
  const justBelow = spot * Math.exp(dailyLogReturn - 1e-6);
  const atThreshold = empiricalBreachProbability(returns, spot, justBelow, 'upper');
  assert.ok(atThreshold);
  assert.equal(atThreshold!.probability, 1);

  const higherStrike = spot * Math.exp(dailyLogReturn + 0.001);
  const aboveThreshold = empiricalBreachProbability(returns, spot, higherStrike, 'upper');
  assert.ok(aboveThreshold);
  assert.equal(aboveThreshold!.probability, 0);
});

test('empiricalBreachProbability lower side is symmetric for a uniform down-move series', () => {
  const dailyLogReturn = -0.012;
  const closes = uniformCloses(40, 25000, dailyLogReturn);
  const returns = buildEmpiricalReturns(closes, 1)!;
  const spot = 25000;
  // A hair above the known (negative) return — every return should still clear this threshold on the downside.
  const justAbove = spot * Math.exp(dailyLogReturn + 1e-6);
  const atThreshold = empiricalBreachProbability(returns, spot, justAbove, 'lower');
  assert.ok(atThreshold);
  assert.equal(atThreshold!.probability, 1);

  const lowerStrike = spot * Math.exp(dailyLogReturn - 0.001);
  const belowThreshold = empiricalBreachProbability(returns, spot, lowerStrike, 'lower');
  assert.ok(belowThreshold);
  assert.equal(belowThreshold!.probability, 0);
});

test('empiricalBreachProbability refuses with too few returns or invalid spot/strike', () => {
  const returns = Array.from({ length: 25 }, () => 0.01);
  assert.equal(empiricalBreachProbability(returns.slice(0, 5), 25000, 25200, 'upper'), null);
  assert.equal(empiricalBreachProbability(returns, 0, 25200, 'upper'), null);
  assert.equal(empiricalBreachProbability(returns, 25000, 0, 'upper'), null);
});

test('normalBreachProbability is exactly 0.5 at the money (strike === spot) on either side', () => {
  const rv = { annualizedVol: 0.15, windowDays: 100 };
  const upper = normalBreachProbability(rv, 20, 25000, 25000, 'upper');
  const lower = normalBreachProbability(rv, 20, 25000, 25000, 'lower');
  assert.ok(upper && lower);
  assert.ok(Math.abs(upper!.probability - 0.5) < 1e-9);
  assert.ok(Math.abs(lower!.probability - 0.5) < 1e-9);
});

test('normalBreachProbability decreases monotonically as the upper strike moves further from spot', () => {
  const rv = { annualizedVol: 0.15, windowDays: 100 };
  const near = normalBreachProbability(rv, 20, 25000, 25200, 'upper')!;
  const mid = normalBreachProbability(rv, 20, 25000, 25500, 'upper')!;
  const far = normalBreachProbability(rv, 20, 25000, 26000, 'upper')!;
  assert.ok(near.probability > mid.probability);
  assert.ok(mid.probability > far.probability);
});

test('normalBreachProbability refuses non-positive realized vol, horizon, spot or strike', () => {
  const rv = { annualizedVol: 0, windowDays: 100 };
  assert.equal(normalBreachProbability(rv, 20, 25000, 25200, 'upper'), null);
  const okRv = { annualizedVol: 0.15, windowDays: 100 };
  assert.equal(normalBreachProbability(okRv, 0, 25000, 25200, 'upper'), null);
  assert.equal(normalBreachProbability(okRv, 20, 0, 25200, 'upper'), null);
  assert.equal(normalBreachProbability(okRv, 20, 25000, 0, 'upper'), null);
});

test('computeIndependentPop returns null with no short strikes at all', () => {
  const closes = uniformCloses(40, 25000, 0.001);
  assert.equal(computeIndependentPop(closes, 25000, 20, []), null);
});

test('computeIndependentPop prefers the empirical read and exposes the normal-model read as a comparison', () => {
  // A genuinely low, near-constant daily move keeps both models' strikes far
  // from being breached, so both should read a high probability of staying
  // within — but they need not be numerically identical, which is exactly
  // the disagreement this is meant to expose.
  const closes = uniformCloses(300, 25000, 0.0003);
  const result = computeIndependentPop(closes, 25000, 20, [
    { strike: 26500, side: 'upper' },
    { strike: 23500, side: 'lower' },
  ]);
  assert.ok(result);
  assert.equal(result!.method, 'empirical');
  assert.ok(result!.sampleCount !== null && result!.sampleCount! > 0);
  assert.ok(result!.comparison !== null);
  assert.equal(result!.comparison!.method, 'normal-from-realized-vol');
  assert.ok(result!.disagreementPct !== null);
  assert.ok(result!.probability > 0.8, `expected a high stay-within probability, got ${result!.probability}`);
});

test('computeIndependentPop falls back to the normal model, never to a fabricated number, when history is too short for empirical', () => {
  // Long enough for computeRealizedVolatility's own MIN_RETURNS_FOR_RV
  // (needs lookbackDays+1 closes) but too short for a 20-day-horizon
  // empirical read to gather MIN_RETURNS_FOR_RV overlapping windows.
  const closes = uniformCloses(25, 25000, 0.001);
  const result = computeIndependentPop(closes, 25000, 20, [
    { strike: 26500, side: 'upper' },
    { strike: 23500, side: 'lower' },
  ]);
  assert.ok(result);
  assert.equal(result!.method, 'normal-from-realized-vol');
  assert.equal(result!.sampleCount, null);
  assert.equal(result!.comparison, null);
  assert.equal(result!.disagreementPct, null);
});

test('computeIndependentPop returns null (not fabricated) when there is not enough history for either model', () => {
  const closes = uniformCloses(10, 25000, 0.001);
  const result = computeIndependentPop(closes, 25000, 20, [{ strike: 26500, side: 'upper' }]);
  assert.equal(result, null);
});

test('computeIndependentExpectedValue mirrors the standard two-outcome EV formula using the independent POP', () => {
  const closes = uniformCloses(300, 25000, 0.0003);
  const legs = [
    { side: 'SELL' as const, right: 'PE' as const, strike: 23500 },
    { side: 'BUY' as const, right: 'PE' as const, strike: 23300 },
    { side: 'SELL' as const, right: 'CE' as const, strike: 26500 },
    { side: 'BUY' as const, right: 'CE' as const, strike: 26700 },
  ];
  const maxProfit = 2000;
  const maxLoss = 8000;
  const result = computeIndependentExpectedValue(legs, maxProfit, maxLoss, closes, 25000, 20);
  assert.ok(result);
  const expected = result!.pop.probability * maxProfit - (1 - result!.pop.probability) * maxLoss;
  assert.ok(Math.abs(result!.expectedValue - expected) < 1e-9);
  assert.ok(Math.abs(result!.evPerUnitRisk - expected / maxLoss) < 1e-9);
});

test('computeIndependentExpectedValue only counts the short strike(s) that actually exist (single-sided credit spread)', () => {
  const closes = uniformCloses(300, 25000, 0.0003);
  // Bull Put Spread: only a short PE, no short CE — upper-side risk must not enter the calculation at all.
  const legs = [
    { side: 'SELL' as const, right: 'PE' as const, strike: 23500 },
    { side: 'BUY' as const, right: 'PE' as const, strike: 23300 },
  ];
  const result = computeIndependentExpectedValue(legs, 1500, 3500, closes, 25000, 20);
  assert.ok(result);
  // A one-sided empirical stay-within-lower-strike probability, not a two-sided one.
  const oneSided = computeIndependentPop(closes, 25000, 20, [{ strike: 23500, side: 'lower' }]);
  assert.ok(Math.abs(result!.pop.probability - oneSided!.probability) < 1e-9);
});

test('computeIndependentExpectedValue refuses a non-positive maxLoss', () => {
  const closes = uniformCloses(300, 25000, 0.0003);
  const legs = [{ side: 'SELL' as const, right: 'PE' as const, strike: 23500 }];
  assert.equal(computeIndependentExpectedValue(legs, 1500, 0, closes, 25000, 20), null);
});

test('computeIndependentExpectedValue returns null when the candidate has no short legs at all', () => {
  const closes = uniformCloses(300, 25000, 0.0003);
  const legs = [{ side: 'BUY' as const, right: 'PE' as const, strike: 23500 }];
  assert.equal(computeIndependentExpectedValue(legs, 1500, 3500, closes, 25000, 20), null);
});
