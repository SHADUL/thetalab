import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { atmIvOf } from '../analytics/atmIv.ts';
import { computeSkew } from '../analytics/skew.ts';
import { classifyBias, selectStrategy, DEFAULT_SKEW_THRESHOLD } from '../strategies/regimeSelect.ts';
import type { ContractSpec } from '../types.ts';
import type { SkewResult } from '../analytics/skew.ts';

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

const fakeSkew = (riskReversal: number): SkewResult => ({
  atmIv: 0.13, putIv: 0.13 - riskReversal / 2, callIv: 0.13 + riskReversal / 2,
  putStrike: 24500, callStrike: 25500, putSkew: -riskReversal / 2, callSkew: riskReversal / 2, riskReversal,
});

/* ---------------- classifyBias ---------------- */

test('classifyBias reads a real call-side bid as bullish, not the ordinary put-skew floor', () => {
  assert.equal(classifyBias(fakeSkew(0.03)).bias, 'bullish');
  assert.equal(classifyBias(fakeSkew(-0.03)).bias, 'bearish');
  assert.equal(classifyBias(fakeSkew(0)).bias, 'neutral');
});

test('classifyBias treats the normal index put-skew baseline as neutral, not bearish', () => {
  // Every index chain sits somewhat put-skewed by default; that alone must
  // not flip this bearish, only a move BEYOND the stated threshold should.
  const ordinaryPutSkew = fakeSkew(-DEFAULT_SKEW_THRESHOLD * 0.5);
  assert.equal(classifyBias(ordinaryPutSkew).bias, 'neutral');
});

test('classifyBias is exactly threshold-bounded', () => {
  assert.equal(classifyBias(fakeSkew(DEFAULT_SKEW_THRESHOLD + 1e-6)).bias, 'bullish');
  assert.equal(classifyBias(fakeSkew(DEFAULT_SKEW_THRESHOLD - 1e-6)).bias, 'neutral');
});

test('classifyBias defaults to neutral without a usable skew reading', () => {
  assert.equal(classifyBias(null).bias, 'neutral');
});

test('every classification carries a reason referencing the actual number, not a canned string', () => {
  const bullish = classifyBias(fakeSkew(0.03));
  assert.match(bullish.reason, /\+3\.00%/);
});

/* ---------------- selectStrategy dispatch ---------------- */

test('a call-skewed session dispatches to a Bull Put Spread', () => {
  // A smile where calls are richer than puts -> positive risk reversal.
  const callRichSmile = (k: number) => 0.13 + Math.max(0, (k - FORWARD) / FORWARD) * 1.5;
  const { chain } = normalise(chainWithSmile(callRichSmile));
  const slice = enrichChain(chain).slices[0];
  const atmIv = atmIvOf(slice);
  const skew = computeSkew(slice, atmIv);
  assert.ok(skew && skew.riskReversal > DEFAULT_SKEW_THRESHOLD, `test smile did not produce a bullish skew: ${skew?.riskReversal}`);

  const out = selectStrategy(slice, skew, { targetShortDelta: 0.2, wingWidth: 500, lotSize: 75 });
  assert.equal(out.bias, 'bullish');
  assert.equal(out.strategyLabel, 'Bull Put Spread');
});

test('a put-skewed-beyond-baseline session dispatches to a Bear Call Spread', () => {
  const putRichSmile = (k: number) => 0.13 + Math.max(0, (FORWARD - k) / FORWARD) * 1.5;
  const { chain } = normalise(chainWithSmile(putRichSmile));
  const slice = enrichChain(chain).slices[0];
  const atmIv = atmIvOf(slice);
  const skew = computeSkew(slice, atmIv);
  assert.ok(skew && skew.riskReversal < -DEFAULT_SKEW_THRESHOLD, `test smile did not produce a bearish skew: ${skew?.riskReversal}`);

  const out = selectStrategy(slice, skew, { targetShortDelta: 0.2, wingWidth: 500, lotSize: 75 });
  assert.equal(out.bias, 'bearish');
  assert.equal(out.strategyLabel, 'Bear Call Spread');
});

test('a flat smile dispatches to an Iron Condor', () => {
  const { chain } = normalise(chainWithSmile(() => 0.13));
  const slice = enrichChain(chain).slices[0];
  const atmIv = atmIvOf(slice);
  const skew = computeSkew(slice, atmIv);
  const out = selectStrategy(slice, skew, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });
  assert.equal(out.bias, 'neutral');
  assert.equal(out.strategyLabel, 'Iron Condor');
});
