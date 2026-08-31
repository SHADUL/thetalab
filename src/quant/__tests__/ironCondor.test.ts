import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { buildIronCondor, isIronCondorFailure } from '../strategies/ironCondor.ts';
import type { ContractSpec } from '../types.ts';

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY',
  lotSize: 75,
  pointValue: 1,
  strikeStep: 50,
  currency: 'INR',
  exerciseStyle: 'european',
  pricingBasis: 'futures',
};

const NOW = Date.parse('2026-08-31T09:30:00Z');
const EXPIRY = Date.parse('2026-09-08T10:00:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);

/** A flat-smile settlement-only chain, matching the shape real bhavcopy data
    takes: settle price and OI, no bid/ask, no provider IV or Greeks. */
function bhavcopyLikeChain(vol: number): RawChainPayload {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right,
      strike,
      expiry: EXPIRY,
      asOf: NOW,
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

test('builds a real Iron Condor from settlement-only data with sane, internally consistent numbers', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });

  assert.ok(!isIronCondorFailure(result), (result as { reason: string }).reason);
  if (isIronCondorFailure(result)) return;

  assert.equal(result.legs.length, 4);
  const sides = result.legs.map((l) => `${l.side}:${l.right}`).sort();
  assert.deepEqual(sides, ['BUY:CE', 'BUY:PE', 'SELL:CE', 'SELL:PE']);

  // Short strikes should sit on the correct side of the forward.
  const shortCall = result.legs.find((l) => l.side === 'SELL' && l.right === 'CE')!;
  const shortPut = result.legs.find((l) => l.side === 'SELL' && l.right === 'PE')!;
  assert.ok(shortCall.strike > result.forward);
  assert.ok(shortPut.strike < result.forward);
  // And their delta should be reasonably close to the requested 0.16 target —
  // this is the whole point: strikes chosen by Greek, not by fixed distance.
  assert.ok(Math.abs(Math.abs(shortCall.delta!) - 0.16) < 0.05, `call delta ${shortCall.delta}`);
  assert.ok(Math.abs(Math.abs(shortPut.delta!) - 0.16) < 0.05, `put delta ${shortPut.delta}`);

  // Risk numbers must be internally consistent, not just plausible-looking.
  assert.ok(result.netCredit > 0);
  assert.ok(result.maxProfit > 0 && result.maxLoss > 0);
  assert.ok(Math.abs(result.maxProfit - result.netCredit * 75) < 1e-6);

  // maxLoss is the WORSE side's own width-minus-credit, not the total credit
  // against the total width — the two sides need not carry equal credit even
  // with a flat smile, since delta-equidistant strikes aren't necessarily
  // premium-symmetric around the forward.
  const longCall = result.legs.find((l) => l.side === 'BUY' && l.right === 'CE')!;
  const longPut = result.legs.find((l) => l.side === 'BUY' && l.right === 'PE')!;
  const callCredit = shortCall.price - longCall.price;
  const putCredit = shortPut.price - longPut.price;
  const callWidth = longCall.strike - shortCall.strike;
  const putWidth = shortPut.strike - longPut.strike;
  const expectedMaxLossPerUnit = Math.max(callWidth - callCredit, putWidth - putCredit);
  assert.ok(
    Math.abs(result.maxLoss / 75 - expectedMaxLossPerUnit) < 1e-6,
    `maxLoss/lot=${result.maxLoss / 75} vs ${expectedMaxLossPerUnit}`,
  );
  assert.ok(result.breakevens[0] < shortPut.strike);
  assert.ok(result.breakevens[1] > shortCall.strike);

  // Short options dominate a condor's net Greeks: negative delta-neutral-ish,
  // positive theta (collecting time decay), negative vega (short volatility).
  assert.ok(result.netGreeks.theta! > 0, `theta should be positive, got ${result.netGreeks.theta}`);
  assert.ok(result.netGreeks.vega! < 0, `vega should be negative, got ${result.netGreeks.vega}`);
  assert.ok(Math.abs(result.netGreeks.delta!) < 0.5, `net delta should be roughly neutral, got ${result.netGreeks.delta}`);

  assert.ok(result.pop !== null && result.pop > 0 && result.pop < 1);
});

test('refuses to build a condor when the requested wing has no usable quote', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  // A wing far wider than the strike grid covers.
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 50_000, lotSize: 75 });
  assert.ok(isIronCondorFailure(result));
  assert.match((result as { reason: string }).reason, /no usable quote/i);
});

test('entryPriceOverride swaps in a different tradeable price without touching strike/delta selection', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const base = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });
  assert.ok(!isIronCondorFailure(base), (base as { reason: string }).reason);
  if (isIronCondorFailure(base)) return;

  // A distinct "entry price" per leg — scaled rather than shifted by a flat
  // amount, since a flat offset cancels exactly across a symmetric condor's
  // four legs (short/long on each side sum to zero net offset). Standing in
  // for e.g. a session-open print that differs from the settlement price
  // used to select strikes in the first place.
  const overridden = buildIronCondor(slice, {
    targetShortDelta: 0.16, wingWidth: 500, lotSize: 75,
    entryPriceOverride: (strike, right) => {
      const q = slice.quotes.find((x) => x.quote.strike === strike && x.quote.right === right);
      return q?.markPrice != null ? q.markPrice * 1.1 : null;
    },
  });
  assert.ok(!isIronCondorFailure(overridden), (overridden as { reason: string }).reason);
  if (isIronCondorFailure(overridden)) return;

  // Same strikes chosen either way — the override only swaps price, not selection.
  assert.deepEqual(base.legs.map((l) => `${l.side}:${l.strike}:${l.right}`).sort(),
    overridden.legs.map((l) => `${l.side}:${l.strike}:${l.right}`).sort());
  // But the dollar figures must actually reflect the overridden price, not
  // the settlement price used for selection.
  for (const leg of overridden.legs) assert.ok(leg.price > 1);
  assert.notEqual(overridden.netCredit, base.netCredit);
});

test('entryPriceOverride returning null for a selected strike is refused, not mixed with settlement price', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, {
    targetShortDelta: 0.16, wingWidth: 500, lotSize: 75,
    entryPriceOverride: () => null,
  });
  assert.ok(isIronCondorFailure(result));
  assert.match((result as { reason: string }).reason, /no tradeable entry price/i);
});

test('a sparse chain with no OTM strikes on one side is refused, not guessed at', () => {
  const payload = bhavcopyLikeChain(0.13);
  payload.rows = payload.rows.filter((r) => !(r.right === 'PE' && (r.strike as number) < FORWARD));
  const { chain } = normalise(payload);
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });
  assert.ok(isIronCondorFailure(result));
});
