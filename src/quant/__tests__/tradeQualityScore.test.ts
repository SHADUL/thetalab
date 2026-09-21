import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { buildIronCondor, isIronCondorFailure, type IronCondorResult } from '../strategies/ironCondor.ts';
import { scoreTradeQuality, DEFAULT_TRADE_QUALITY_WEIGHTS } from '../strategies/tradeQualityScore.ts';
import type { ContractSpec, EnrichedSlice } from '../types.ts';

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const EXPIRY = Date.parse('2026-09-08T10:00:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);

function bhavcopyLikeChain(vol: number, openInterest = 50_000): RawChainPayload {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right, strike, expiry: EXPIRY, asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest,
    })),
  );
  return {
    source: { providerId: 'test-bhavcopy', kind: 'eod', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: r, dividendYield: 0 },
    rows,
  };
}

function slice(vol = 0.13, openInterest = 50_000): EnrichedSlice {
  const { chain } = normalise(bhavcopyLikeChain(vol, openInterest));
  return enrichChain(chain).slices[0];
}

function condor(s: EnrichedSlice): IronCondorResult {
  const result = buildIronCondor(s, { targetShortDelta: 0.16, wingWidth: 400, lotSize: 75 });
  assert.ok(!isIronCondorFailure(result), (result as { reason: string }).reason);
  return result as IronCondorResult;
}

test('scores a well-formed candidate with every component present and a sensible weighted score', () => {
  const s = slice();
  const c = condor(s);
  const { score, components, missingComponents } = scoreTradeQuality(c, s, { ivRank: 72, marginRequired: c.maxProfit / 0.1 });

  assert.deepEqual(missingComponents, []);
  assert.ok(score >= 0 && score <= 100);
  assert.ok(components.riskReward !== null && components.riskReward >= 0 && components.riskReward <= 100);
  assert.ok(components.pop !== null);
  assert.equal(components.ivRank, 72);
  assert.ok(components.strikeSafety !== null && components.strikeSafety > 0, 'delta-0.16 short strikes should sit a meaningful distance from the forward');
  assert.ok(components.dte > 0);
  assert.ok(components.liquidity !== null && components.liquidity > 50, 'ample OI/volume in the fixture should not trigger the liquidity gate');
  assert.ok(components.marginEfficiency !== null);
});

test('a missing IV rank and no margin figure are excluded, not treated as zero — the remaining weights renormalize', () => {
  const s = slice();
  const c = condor(s);
  const { score, components, missingComponents } = scoreTradeQuality(c, s, { ivRank: null });

  assert.deepEqual(missingComponents.sort(), ['ivRank', 'marginEfficiency'].sort());
  assert.equal(components.ivRank, null);
  assert.equal(components.marginEfficiency, null);
  // Score must still come purely from the present components, not get
  // dragged toward zero just because two components are unavailable.
  assert.ok(score > 30, `score collapsed toward zero on missing data: ${score}`);
});

test('a candidate with thin open interest triggers the liquidity gate (halved score), not a silent pass', () => {
  const thin = slice(0.13, 100); // below config.ts's default minOpenInterest of 500
  const ample = slice(0.13, 50_000);
  const cThin = condor(thin);
  const cAmple = condor(ample);

  const scoredThin = scoreTradeQuality(cThin, thin, { ivRank: 50 });
  const scoredAmple = scoreTradeQuality(cAmple, ample, { ivRank: 50 });

  assert.ok(scoredThin.components.liquidity !== null && scoredAmple.components.liquidity !== null);
  assert.ok(scoredThin.components.liquidity! < scoredAmple.components.liquidity!,
    `thin OI (${scoredThin.components.liquidity}) should score below ample OI (${scoredAmple.components.liquidity})`);
});

test('DEFAULT_TRADE_QUALITY_WEIGHTS sums to 100 (every component present, full-weight case)', () => {
  const total = Object.values(DEFAULT_TRADE_QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test('custom weights are honored over the defaults', () => {
  const s = slice();
  const c = condor(s);
  const heavyOnIvRank = { ...DEFAULT_TRADE_QUALITY_WEIGHTS, ivRank: 1000, riskReward: 0, pop: 0, strikeSafety: 0, dte: 0, liquidity: 0, marginEfficiency: 0 };
  const { score } = scoreTradeQuality(c, s, { ivRank: 90 }, heavyOnIvRank);
  // With every other weight zeroed, the score should track ivRank almost exactly.
  assert.ok(Math.abs(score - 90) < 1, `score ${score} should track the single non-zero weighted component`);
});
