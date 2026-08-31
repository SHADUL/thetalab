import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { buildCreditSpread, isCreditSpreadFailure } from '../strategies/creditSpread.ts';
import type { ContractSpec } from '../types.ts';

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const EXPIRY = Date.parse('2026-09-08T10:00:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);

function flatChain(vol = 0.13): RawChainPayload {
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
    source: { providerId: 'test', kind: 'eod', retrievedAt: NOW }, contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: r, dividendYield: 0 },
    rows,
  };
}

test('bull put spread: short strike below forward, positive theta, positive delta (bullish)', () => {
  const { chain } = normalise(flatChain());
  const slice = enrichChain(chain).slices[0];
  const result = buildCreditSpread(slice, { right: 'PE', targetShortDelta: 0.2, wingWidth: 500, lotSize: 75 });
  assert.ok(!isCreditSpreadFailure(result), (result as { reason: string }).reason);
  if (isCreditSpreadFailure(result)) return;

  assert.equal(result.strategy, 'bull-put-spread');
  const short = result.legs.find((l) => l.side === 'SELL')!;
  const long = result.legs.find((l) => l.side === 'BUY')!;
  assert.ok(short.strike < FORWARD);
  assert.ok(long.strike < short.strike); // protection further OTM
  assert.equal(long.strike, short.strike - 500);

  // Selling a put nets long delta — this structure profits if the market
  // rises or stays flat, which is exactly what "bullish" should mean here.
  assert.ok(result.netGreeks.delta! > 0, `net delta should be positive (bullish), got ${result.netGreeks.delta}`);
  assert.ok(result.netGreeks.theta! > 0, `net theta should be positive, got ${result.netGreeks.theta}`);
  assert.ok(result.breakeven < short.strike);
  assert.ok(Math.abs(result.maxProfit - result.netCredit * 75) < 1e-6);
  assert.ok(Math.abs(result.maxLoss / 75 - (500 - result.netCredit)) < 1e-6);
});

test('bear call spread: short strike above forward, negative delta (bearish)', () => {
  const { chain } = normalise(flatChain());
  const slice = enrichChain(chain).slices[0];
  const result = buildCreditSpread(slice, { right: 'CE', targetShortDelta: 0.2, wingWidth: 500, lotSize: 75 });
  assert.ok(!isCreditSpreadFailure(result), (result as { reason: string }).reason);
  if (isCreditSpreadFailure(result)) return;

  assert.equal(result.strategy, 'bear-call-spread');
  const short = result.legs.find((l) => l.side === 'SELL')!;
  const long = result.legs.find((l) => l.side === 'BUY')!;
  assert.ok(short.strike > FORWARD);
  assert.ok(long.strike > short.strike);

  assert.ok(result.netGreeks.delta! < 0, `net delta should be negative (bearish), got ${result.netGreeks.delta}`);
  assert.ok(result.breakeven > short.strike);
});

test('POP formulas point the right way: bull put favours staying up, bear call favours staying down', () => {
  const { chain } = normalise(flatChain());
  const slice = enrichChain(chain).slices[0];
  const bullPut = buildCreditSpread(slice, { right: 'PE', targetShortDelta: 0.15, wingWidth: 500, lotSize: 75 });
  const bearCall = buildCreditSpread(slice, { right: 'CE', targetShortDelta: 0.15, wingWidth: 500, lotSize: 75 });
  assert.ok(!isCreditSpreadFailure(bullPut) && !isCreditSpreadFailure(bearCall));
  if (isCreditSpreadFailure(bullPut) || isCreditSpreadFailure(bearCall)) return;
  // A 15-delta short strike should have a high (roughly 1 - 0.15-ish) POP of
  // finishing on the winning side of a flat, centred smile.
  assert.ok(bullPut.pop! > 0.7, `bull put POP too low: ${bullPut.pop}`);
  assert.ok(bearCall.pop! > 0.7, `bear call POP too low: ${bearCall.pop}`);
});

test('entryPriceOverride returning null for a selected strike is refused', () => {
  const { chain } = normalise(flatChain());
  const slice = enrichChain(chain).slices[0];
  const result = buildCreditSpread(slice, {
    right: 'PE', targetShortDelta: 0.2, wingWidth: 500, lotSize: 75,
    entryPriceOverride: () => null,
  });
  assert.ok(isCreditSpreadFailure(result));
  assert.match((result as { reason: string }).reason, /no tradeable entry price/i);
});

test('refuses when the requested wing has no usable quote', () => {
  const { chain } = normalise(flatChain());
  const slice = enrichChain(chain).slices[0];
  const result = buildCreditSpread(slice, { right: 'PE', targetShortDelta: 0.2, wingWidth: 50_000, lotSize: 75 });
  assert.ok(isCreditSpreadFailure(result));
  assert.match((result as { reason: string }).reason, /no usable quote/i);
});

test('a one-sided sparse chain is refused, not guessed at', () => {
  const payload = flatChain();
  payload.rows = payload.rows.filter((r) => !(r.right === 'PE' && (r.strike as number) < FORWARD));
  const { chain } = normalise(payload);
  const slice = enrichChain(chain).slices[0];
  const result = buildCreditSpread(slice, { right: 'PE', targetShortDelta: 0.2, wingWidth: 500, lotSize: 75 });
  assert.ok(isCreditSpreadFailure(result));
});
