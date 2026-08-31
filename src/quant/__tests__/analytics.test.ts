import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expectedMove } from '../analytics/expectedMove.ts';
import { ivRankAndPercentile, MIN_WINDOW_DAYS } from '../analytics/ivRank.ts';
import { computeSkew } from '../analytics/skew.ts';
import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import type { ContractSpec } from '../types.ts';

/* ---------------- expected move ---------------- */

test('expected move matches the textbook formula and brackets symmetrically', () => {
  const em = expectedMove(25000, 0.13, 7 / 365);
  assert.ok(em);
  const expectedPts = 25000 * 0.13 * Math.sqrt(7 / 365);
  assert.ok(Math.abs(em!.points - expectedPts) < 1e-9);
  assert.ok(Math.abs(em!.oneSigma.upper - (25000 + expectedPts)) < 1e-9);
  assert.ok(Math.abs(em!.oneSigma.lower - (25000 - expectedPts)) < 1e-9);
  assert.ok(Math.abs(em!.twoSigma.upper - (25000 + 2 * expectedPts)) < 1e-9);
  assert.equal(em!.oneSigma.upper - 25000, 25000 - em!.oneSigma.lower);
});

test('expected move refuses non-positive inputs rather than returning garbage', () => {
  assert.equal(expectedMove(0, 0.13, 0.1), null);
  assert.equal(expectedMove(25000, 0, 0.1), null);
  assert.equal(expectedMove(25000, 0.13, -0.1), null);
  assert.equal(expectedMove(-25000, 0.13, 0.1), null);
});

/* ---------------- IV rank / percentile ---------------- */

function histOf(ivs: number[]): { date: string; atmIv: number | null }[] {
  return ivs.map((iv, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, atmIv: iv }));
}

test('IV rank is 100 at the window max, 0 at the window min', () => {
  const hist = histOf(Array.from({ length: 30 }, (_, i) => 0.1 + i * 0.01)); // 0.10..0.39
  const atMax = ivRankAndPercentile(hist, 0.39);
  const atMin = ivRankAndPercentile(hist, 0.10);
  assert.ok(atMax && Math.abs(atMax.rank - 100) < 1e-9);
  assert.ok(atMin && Math.abs(atMin.rank - 0) < 1e-9);
});

test('IV percentile counts strictly-below days, robust to one outlier spike', () => {
  const hist = histOf([...Array(29).fill(0.12), 0.90]); // one huge spike
  const r = ivRankAndPercentile(hist, 0.13);
  assert.ok(r);
  // 29/30 days were below 0.13 -> percentile ~96.7%, even though rank would
  // read low because of how close 0.13 sits to the 0.12 floor vs the 0.90 spike.
  assert.ok(r!.percentile > 95);
  assert.ok(r!.rank < 5, `rank should read low near the spike-dominated range, got ${r!.rank}`);
});

test('IV rank refuses with too little history rather than reading noise', () => {
  const hist = histOf(Array.from({ length: MIN_WINDOW_DAYS - 1 }, () => 0.13));
  assert.equal(ivRankAndPercentile(hist, 0.13), null);
});

test('IV rank ignores null points and respects the lookback window', () => {
  const hist = [...histOf([0.5]), ...histOf(Array(25).fill(0.1))].map((p, i) => ({ ...p, date: `2026-02-${String(i + 1).padStart(2, '0')}` }));
  hist[0].atmIv = null; // an unsolved (e.g. 0-DTE) session shouldn't count
  const r = ivRankAndPercentile(hist, 0.1, 25);
  assert.ok(r);
  assert.equal(r!.windowDays, 25);
});

/* ---------------- skew ---------------- */

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const EXPIRY = Date.parse('2026-09-08T10:00:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);

function chainWithSmile(smile: (k: number) => number): RawChainPayload {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right, strike, expiry: EXPIRY, asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol: smile(strike), rate: r, right }).price,
      openInterest: 50_000,
    })),
  );
  return {
    source: { providerId: 'test', kind: 'eod', retrievedAt: NOW }, contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: r, dividendYield: 0 },
    rows,
  };
}

test('a put-skewed smile reads as a negative risk reversal and positive put skew', () => {
  const putSkewedSmile = (k: number) => 0.13 + Math.max(0, (FORWARD - k) / FORWARD) * 0.5;
  const { chain } = normalise(chainWithSmile(putSkewedSmile));
  const slice = enrichChain(chain).slices[0];
  const atmQuote = slice.quotes.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'CE');
  const skew = computeSkew(slice, atmQuote?.iv ?? null);
  assert.ok(skew);
  assert.ok(skew!.putSkew > 0, `put skew should be positive, got ${skew!.putSkew}`);
  assert.ok(skew!.riskReversal < 0, `risk reversal should be negative for a put-skewed smile, got ${skew!.riskReversal}`);
});

test('a flat smile reads as roughly zero skew in both directions', () => {
  const { chain } = normalise(chainWithSmile(() => 0.13));
  const slice = enrichChain(chain).slices[0];
  const atmQuote = slice.quotes.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'CE');
  const skew = computeSkew(slice, atmQuote?.iv ?? null);
  assert.ok(skew);
  assert.ok(Math.abs(skew!.riskReversal) < 1e-3, `flat smile risk reversal should be ~0, got ${skew!.riskReversal}`);
});

test('skew refuses without a usable ATM IV', () => {
  const { chain } = normalise(chainWithSmile(() => 0.13));
  const slice = enrichChain(chain).slices[0];
  assert.equal(computeSkew(slice, null), null);
});
