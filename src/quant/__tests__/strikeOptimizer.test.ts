import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { generateCandidates, wingWidthsFromStep, DEFAULT_DELTA_TARGETS } from '../strategies/strikeOptimizer.ts';
import type { ContractSpec } from '../types.ts';

// Same fixture shape as ironCondor.test.ts/creditSpread.test.ts — a real
// flat-smile chain priced through black76(), not a hand-mocked object.
const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const EXPIRY = Date.parse('2026-09-08T10:00:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);

function bhavcopyLikeChain(vol: number): RawChainPayload {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right, strike, expiry: EXPIRY, asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest: 50_000,
    })),
  );
  return {
    source: { providerId: 'test-bhavcopy', kind: 'eod', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: r, dividendYield: 0 },
    rows,
  };
}

function slice(vol = 0.13) {
  const { chain } = normalise(bhavcopyLikeChain(vol));
  return enrichChain(chain).slices[0];
}

test('generateCandidates builds multiple Iron Condor candidates across the delta/wing grid, ranked by EV per unit of risk', () => {
  const s = slice();
  const { candidates, failures } = generateCandidates(s, {
    strategyLabel: 'Iron Condor', lotSize: 75,
    deltaTargets: DEFAULT_DELTA_TARGETS,
    wingWidths: wingWidthsFromStep(100, [2, 4, 6]),
  });

  assert.ok(candidates.length > 5, `expected several distinct candidates, got ${candidates.length}`);
  assert.equal(failures.length, 0, JSON.stringify(failures));

  for (const c of candidates) {
    // OptimizerCandidate.result is only ever a success — failures land in
    // the separate `failures` array, never in `candidates` — so no failure
    // type guard is needed here.
    assert.equal(c.strategyLabel, 'Iron Condor');
    // expectedValue/evPerUnitRisk must match the stated formula exactly.
    if (c.result.pop !== null) {
      const expected = c.result.pop * c.result.maxProfit - (1 - c.result.pop) * c.result.maxLoss;
      assert.ok(Math.abs(c.expectedValue! - expected) < 1e-6);
      assert.ok(Math.abs(c.evPerUnitRisk! - expected / c.result.maxLoss) < 1e-9);
    }
  }

  // Sorted best-first by evPerUnitRisk.
  for (let i = 1; i < candidates.length; i++) {
    assert.ok((candidates[i - 1].evPerUnitRisk ?? -Infinity) >= (candidates[i].evPerUnitRisk ?? -Infinity));
  }
});

test('de-duplicates candidates whose delta targets resolve to the identical strikes', () => {
  const s = slice();
  // Two delta targets close enough together that closestByAbsDelta likely
  // saturates to the same strike on this chain's 100-point grid.
  const { candidates } = generateCandidates(s, {
    strategyLabel: 'Iron Condor', lotSize: 75,
    deltaTargets: [0.16, 0.161],
    wingWidths: [400],
  });
  assert.equal(candidates.length, 1, 'both delta targets should resolve to the same real trade');
});

test('generates Bull Put Spread and Bear Call Spread candidates through the same entry point', () => {
  const s = slice();
  const bullPut = generateCandidates(s, {
    strategyLabel: 'Bull Put Spread', lotSize: 75, wingWidths: wingWidthsFromStep(100, [4]),
  });
  assert.ok(bullPut.candidates.length > 0);
  for (const c of bullPut.candidates) assert.equal(c.strategyLabel, 'Bull Put Spread');

  const bearCall = generateCandidates(s, {
    strategyLabel: 'Bear Call Spread', lotSize: 75, wingWidths: wingWidthsFromStep(100, [4]),
  });
  assert.ok(bearCall.candidates.length > 0);
  for (const c of bearCall.candidates) assert.equal(c.strategyLabel, 'Bear Call Spread');
});

test('collects per-attempt failures with their exact delta/wing context rather than dropping them silently', () => {
  const s = slice();
  const { candidates, failures } = generateCandidates(s, {
    strategyLabel: 'Iron Condor', lotSize: 75,
    deltaTargets: [0.16],
    wingWidths: [50_000], // far wider than the strike grid covers
  });
  assert.equal(candidates.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].targetShortDelta, 0.16);
  assert.equal(failures[0].wingWidth, 50_000);
  assert.match(failures[0].reason, /no usable quote/i);
});

test('refuses immediately when no wingWidths are supplied, rather than silently returning nothing', () => {
  const s = slice();
  const { candidates, failures } = generateCandidates(s, { strategyLabel: 'Iron Condor', lotSize: 75, wingWidths: [] });
  assert.equal(candidates.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /no wingwidths supplied/i);
});

test('wingWidthsFromStep scales multiples by the given strike step', () => {
  assert.deepEqual(wingWidthsFromStep(50, [2, 4, 6, 8]), [100, 200, 300, 400]);
  assert.deepEqual(wingWidthsFromStep(100), [200, 400, 600, 800]);
});

test('a candidate needing an UNTRADABLE leg (zero OI and zero volume) is rejected into failures, never scored as a candidate', () => {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const vol = 0.13;
  // Every CE strike has zero OI/volume — no Iron Condor can be built
  // without a call leg, so every candidate this generates must be
  // rejected by the hard liquidity gate regardless of which delta/wing
  // combination happens to be tried.
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right, strike, expiry: EXPIRY, asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest: right === 'CE' ? 0 : 50_000,
      volume: right === 'CE' ? 0 : 20_000,
    })),
  );
  const payload: RawChainPayload = {
    source: { providerId: 'test-live', kind: 'live', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: r, dividendYield: 0 },
    rows,
  };
  const { chain } = normalise(payload);
  const s = enrichChain(chain).slices[0];

  const { candidates, failures } = generateCandidates(s, {
    strategyLabel: 'Iron Condor', lotSize: 75,
    deltaTargets: DEFAULT_DELTA_TARGETS,
    wingWidths: wingWidthsFromStep(100, [2, 4, 6]),
  });

  assert.equal(candidates.length, 0, 'every candidate needs a call leg, and every call leg is untradable');
  assert.ok(failures.length > 0);
  assert.ok(failures.every((f) => /Rejected on liquidity/.test(f.reason)), JSON.stringify(failures.map((f) => f.reason)));
  assert.ok(failures.some((f) => /zero open interest and zero volume/.test(f.reason)));
});

test('a healthy chain still returns real candidates, each carrying its own strategy liquidity tier', () => {
  const s = slice();
  const { candidates } = generateCandidates(s, {
    strategyLabel: 'Iron Condor', lotSize: 75,
    deltaTargets: DEFAULT_DELTA_TARGETS,
    wingWidths: wingWidthsFromStep(100, [2, 4, 6]),
  });
  assert.ok(candidates.length > 0);
  for (const c of candidates) {
    assert.ok(['LIQUID', 'ACCEPTABLE', 'POOR'].includes(c.liquidity.tier), `UNTRADABLE candidates must never reach this list, got ${c.liquidity.tier}`);
  }
});
