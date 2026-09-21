import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { evaluateExpiries, selectBestExpiry } from '../strategies/expirySelector.ts';
import type { ContractSpec } from '../types.ts';

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);
const DAY_MS = 86_400_000;

/** One flat-smile expiry, priced through black76() — same shape as the other quant test fixtures. */
function expirySlice(dte: number, vol: number, openInterest = 50_000) {
  const expiry = NOW + dte * DAY_MS;
  const T = yearFraction(NOW, expiry);
  const r = 0.065;
  return (['CE', 'PE'] as const).flatMap((right) =>
    STRIKES.map((strike) => ({
      right, strike, expiry, asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest,
    })),
  );
}

function multiExpiryChain(entries: Array<{ dte: number; vol: number }>): RawChainPayload {
  return {
    source: { providerId: 'test-bhavcopy', kind: 'eod', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows: entries.flatMap(({ dte, vol }) => expirySlice(dte, vol)),
  };
}

const BASE_PARAMS = { lotSize: 75, wingWidths: [200, 400, 600] };

test('excludes near-zero DTE and far-dated expiries by default, evaluating only the in-band ones', () => {
  const { chain } = normalise(multiExpiryChain([
    { dte: 1, vol: 0.13 },
    { dte: 10, vol: 0.13 },
    { dte: 30, vol: 0.13 },
    { dte: 70, vol: 0.13 },
  ]));
  const evaluations = evaluateExpiries(enrichChain(chain), BASE_PARAMS);

  assert.equal(evaluations.length, 4);
  const byDte = new Map(evaluations.map((e) => [e.dte, e]));

  assert.equal(byDte.get(1)!.best, null);
  assert.match(byDte.get(1)!.skipReason!, /near-expiry gamma-risk window/);

  assert.equal(byDte.get(70)!.best, null);
  assert.match(byDte.get(70)!.skipReason!, /beyond the configured max/);

  assert.notEqual(byDte.get(10)!.best, null);
  assert.equal(byDte.get(10)!.skipReason, null);
  assert.notEqual(byDte.get(30)!.best, null);
  assert.equal(byDte.get(30)!.skipReason, null);
});

test('each in-band expiry runs its own skew -> strategy -> optimizer -> quality-score pipeline', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 14, vol: 0.13 }]));
  const [evaluation] = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, ivRank: 65 });

  assert.equal(evaluation.dte, 14);
  assert.equal(evaluation.bias, 'neutral'); // flat smile -> neutral skew -> Iron Condor
  assert.equal(evaluation.strategyLabel, 'Iron Condor');
  assert.ok(evaluation.candidateCount > 0);
  assert.ok(evaluation.best !== null);
  assert.equal(evaluation.best!.qualityScore.components.ivRank, 65);
  assert.ok(evaluation.best!.qualityScore.score >= 0 && evaluation.best!.qualityScore.score <= 100);
});

test('selectBestExpiry picks the eligible expiry with the highest expected value per unit of risk', () => {
  // A richer vol at 30 DTE should generally produce a better EV/risk trade
  // than a thin one at 10 DTE, on an otherwise identical flat-smile chain.
  const { chain } = normalise(multiExpiryChain([
    { dte: 10, vol: 0.10 },
    { dte: 30, vol: 0.22 },
  ]));
  const evaluations = evaluateExpiries(enrichChain(chain), BASE_PARAMS);
  const winner = selectBestExpiry(evaluations);

  assert.ok(winner !== null);
  const byDte = new Map(evaluations.map((e) => [e.dte, e]));
  const best10 = byDte.get(10)!.best!.evPerUnitRisk ?? -Infinity;
  const best30 = byDte.get(30)!.best!.evPerUnitRisk ?? -Infinity;
  assert.equal(winner!.dte, best30 >= best10 ? 30 : 10);
});

test('selectBestExpiry returns null when nothing is eligible', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 1, vol: 0.13 }, { dte: 90, vol: 0.13 }]));
  const evaluations = evaluateExpiries(enrichChain(chain), BASE_PARAMS);
  assert.equal(selectBestExpiry(evaluations), null);
});

test('a sparse expiry (nothing priceable) is skipped with a specific reason, not silently dropped', () => {
  const payload = multiExpiryChain([{ dte: 14, vol: 0.13 }]);
  // Strip every OTM put so the Iron Condor / any credit structure has nothing to build on that side.
  payload.rows = payload.rows.filter((r) => !(r.right === 'PE' && (r.strike as number) < FORWARD));
  const { chain } = normalise(payload);
  const [evaluation] = evaluateExpiries(enrichChain(chain), BASE_PARAMS);

  assert.equal(evaluation.best, null);
  assert.match(evaluation.skipReason!, /no candidate priced/i);
});

test('custom minDte/maxDte widen or narrow the eligible band', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 1, vol: 0.13 }]));
  const [allowedZero] = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, minDte: 0 });
  assert.notEqual(allowedZero.best, null);

  const [narrowed] = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, minDte: 5 });
  assert.equal(narrowed.best, null);
});
