import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRealizedVolatility, computeExpectedRealizedMove, computeIvRvEdge,
  MIN_RETURNS_FOR_RV, type HistoricalClose,
} from '../analytics/realizedVolatility.ts';

/** A synthetic random-walk-ish close series with a KNOWN daily log-return stdev, via a simple deterministic oscillation (not truly random, so the test is exact/reproducible). */
function syntheticCloses(days: number, startPrice: number, dailyMoveFrac: number): HistoricalClose[] {
  const closes: HistoricalClose[] = [];
  let price = startPrice;
  for (let i = 0; i < days; i++) {
    // Alternate up/down by a fixed fraction — gives a precisely known, reproducible daily log-return magnitude.
    price *= 1 + (i % 2 === 0 ? dailyMoveFrac : -dailyMoveFrac);
    const date = new Date(2025, 0, 1 + i).toISOString().slice(0, 10);
    closes.push({ date, close: price });
  }
  return closes;
}

test('computeRealizedVolatility refuses with fewer than MIN_RETURNS_FOR_RV observations', () => {
  const closes = syntheticCloses(10, 25000, 0.01);
  assert.equal(computeRealizedVolatility(closes), null);
});

test('computeRealizedVolatility returns a plausible annualized figure for a known oscillation', () => {
  const closes = syntheticCloses(60, 25000, 0.01); // ~1% daily moves
  const rv = computeRealizedVolatility(closes);
  assert.ok(rv);
  // Annualized vol of a consistent ~1% daily move should land roughly around 1% * sqrt(252) ≈ 15.9%,
  // give or take since alternating +1%/-1% isn't identical to a pure stdev process.
  assert.ok(rv!.annualizedVol > 0.05 && rv!.annualizedVol < 0.30, `unexpected annualized vol: ${rv!.annualizedVol}`);
  assert.equal(rv!.windowDays, 59);
});

test('computeRealizedVolatility uses only the trailing lookbackDays window, not the whole series', () => {
  const flat = syntheticCloses(300, 25000, 0.0001); // near-zero moves early on
  const volatileTail = syntheticCloses(60, 25000, 0.02); // then a genuinely more volatile recent period
  const combined = [...flat.slice(0, 240), ...volatileTail.map((c, i) => ({ date: flat[240 + i]?.date ?? c.date, close: c.close }))];
  const rvShortLookback = computeRealizedVolatility(combined, 59);
  const rvLongLookback = computeRealizedVolatility(combined, 299);
  assert.ok(rvShortLookback && rvLongLookback);
  assert.ok(rvShortLookback!.annualizedVol > rvLongLookback!.annualizedVol, 'a short lookback over the volatile tail should read higher vol than a long lookback diluted by the calm period');
});

test('computeExpectedRealizedMove refuses with too few overlapping windows', () => {
  const closes = syntheticCloses(15, 25000, 0.01);
  assert.equal(computeExpectedRealizedMove(closes, 10, 25000), null);
});

test('computeExpectedRealizedMove converts the median horizon-return to points at the given spot', () => {
  const closes = syntheticCloses(80, 25000, 0.005);
  const result = computeExpectedRealizedMove(closes, 5, 25000);
  assert.ok(result);
  assert.ok(result!.sampleCount >= MIN_RETURNS_FOR_RV);
  assert.ok(result!.points > 0);
  assert.ok(Math.abs(result!.points - 25000 * (result!.pct / 100)) < 1e-6);
});

test('computeExpectedRealizedMove refuses invalid horizon or spot', () => {
  const closes = syntheticCloses(80, 25000, 0.005);
  assert.equal(computeExpectedRealizedMove(closes, 0, 25000), null);
  assert.equal(computeExpectedRealizedMove(closes, 5, 0), null);
});

test('computeIvRvEdge reports a positive edge when implied move exceeds what has typically realized', () => {
  const rv = { annualizedVol: 0.10, windowDays: 100 };
  const erm = { points: 200, pct: 0.8, sampleCount: 50 };
  const edge = computeIvRvEdge(0.15, rv, 1.2, erm); // implied move 1.2% vs typical realized 0.8%
  assert.ok(edge);
  assert.ok(edge!.horizonMatchedRatio > 1);
  assert.ok(edge!.edgePct > 0);
  assert.ok(Math.abs(edge!.annualizedRatio - 1.5) < 1e-9);
});

test('computeIvRvEdge reports a negative edge when implied move is below what has typically realized', () => {
  const rv = { annualizedVol: 0.20, windowDays: 100 };
  const erm = { points: 400, pct: 1.6, sampleCount: 50 };
  const edge = computeIvRvEdge(0.10, rv, 0.8, erm); // implied move UNDER typical realized — a bad sell setup
  assert.ok(edge);
  assert.ok(edge!.horizonMatchedRatio < 1);
  assert.ok(edge!.edgePct < 0);
});

test('computeIvRvEdge refuses when realized vol or expected move is non-positive', () => {
  assert.equal(computeIvRvEdge(0.15, { annualizedVol: 0, windowDays: 100 }, 1.2, { points: 1, pct: 0.8, sampleCount: 50 }), null);
  assert.equal(computeIvRvEdge(0.15, { annualizedVol: 0.1, windowDays: 100 }, 1.2, { points: 0, pct: 0, sampleCount: 50 }), null);
});
