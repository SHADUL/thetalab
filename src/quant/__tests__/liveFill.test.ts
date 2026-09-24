import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runLiveExecution, type LiveOrderPlacer } from '../execution/liveFill.ts';
import type { PlannedLeg } from '../execution/paperFill.ts';
import type { ValidationResult } from '../execution/preTradeValidation.ts';

const LEGS: PlannedLeg[] = [
  { side: 'SELL', right: 'PE', strike: 24600, tradingsymbol: 'NIFTY26SEP24600PE', quantity: 65, fillPrice: 120 },
  { side: 'BUY', right: 'PE', strike: 24500, tradingsymbol: 'NIFTY26SEP24500PE', quantity: 65, fillPrice: 80 },
];

const IRON_CONDOR_LEGS: PlannedLeg[] = [
  { side: 'SELL', right: 'PE', strike: 24600, tradingsymbol: 'NIFTY26SEP24600PE', quantity: 65, fillPrice: 120 },
  { side: 'BUY', right: 'PE', strike: 24500, tradingsymbol: 'NIFTY26SEP24500PE', quantity: 65, fillPrice: 80 },
  { side: 'SELL', right: 'CE', strike: 25400, tradingsymbol: 'NIFTY26SEP25400CE', quantity: 65, fillPrice: 110 },
  { side: 'BUY', right: 'CE', strike: 25500, tradingsymbol: 'NIFTY26SEP25500CE', quantity: 65, fillPrice: 75 },
];

function passingValidation(): ValidationResult {
  return { passed: true, checks: [{ name: 'marketDataFreshness', passed: true, detail: 'fresh' }] };
}
function failingValidation(): ValidationResult {
  return { passed: false, checks: [{ name: 'riskLimits', passed: false, detail: 'Position size resolved to zero lots.' }] };
}

/** A quote at the leg's own modeled fillPrice — always within the deviation guard. */
function quoteAt(price: number) {
  return { bid: price, ask: price, lastPrice: price };
}

/** Fill outcomes are scripted per tradingsymbol, one outcome consumed per placeOrder call on that symbol (so retries can differ from the first attempt). */
function scriptedPlacer(fillScript: Record<string, Array<{ status: 'COMPLETE' | 'REJECTED' | 'CANCELLED' | 'TIMEOUT'; averagePrice: number | null }>>, quotes?: Record<string, ReturnType<typeof quoteAt> | null>) {
  const calls: string[] = [];
  const orderSymbol = new Map<string, string>();
  const attemptIndex: Record<string, number> = {};
  let orderCounter = 0;

  const placer: LiveOrderPlacer = {
    async getQuote(tradingsymbol) {
      calls.push(`quote:${tradingsymbol}`);
      if (quotes && tradingsymbol in quotes) return quotes[tradingsymbol];
      return quoteAt(100);
    },
    async placeOrder(leg, _exchange, transactionType) {
      calls.push(`place:${transactionType}:${leg.tradingsymbol}`);
      orderCounter++;
      const orderId = `order-${orderCounter}`;
      orderSymbol.set(orderId, leg.tradingsymbol);
      return orderId;
    },
    async awaitFill(orderId) {
      calls.push(`await:${orderId}`);
      const symbol = orderSymbol.get(orderId)!;
      const idx = attemptIndex[symbol] ?? 0;
      attemptIndex[symbol] = idx + 1;
      const script = fillScript[symbol] ?? [];
      return script[idx] ?? script[script.length - 1] ?? { status: 'COMPLETE', averagePrice: 100 };
    },
    async closeLeg(leg) {
      calls.push(`close:${leg.tradingsymbol}`);
      orderCounter++;
      return `close-order-${orderCounter}`;
    },
  };
  return { placer, calls };
}

test('a validation failure never places a single real order', async () => {
  const { placer, calls } = scriptedPlacer({});
  const result = await runLiveExecution(LEGS, failingValidation(), placer, { exchange: 'NFO' });
  assert.equal(result.state, 'FAILED');
  assert.equal(calls.length, 0);
});

test('every BUY leg fills before any SELL leg is ever fired, for a passing validation', async () => {
  const { placer, calls } = scriptedPlacer({
    'NIFTY26SEP24500PE': [{ status: 'COMPLETE', averagePrice: 81 }],
    'NIFTY26SEP24600PE': [{ status: 'COMPLETE', averagePrice: 119 }],
  });
  const result = await runLiveExecution(LEGS, passingValidation(), placer, { exchange: 'NFO' });
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.protection, 'FULL');

  const placeCalls = calls.filter((c) => c.startsWith('place:'));
  assert.deepEqual(placeCalls, ['place:BUY:NIFTY26SEP24500PE', 'place:SELL:NIFTY26SEP24600PE']);

  const buyFill = result.legFills.find((l) => l.side === 'BUY')!;
  assert.equal(buyFill.fillPrice, 81);
  assert.equal(buyFill.orderId, 'order-1');
});

test('a rejected BUY leg means the SELL leg is never attempted at all', async () => {
  const { placer, calls } = scriptedPlacer({
    'NIFTY26SEP24500PE': [
      { status: 'REJECTED', averagePrice: null },
      { status: 'REJECTED', averagePrice: null },
      { status: 'REJECTED', averagePrice: null },
    ],
  });
  const result = await runLiveExecution(LEGS, passingValidation(), placer, { exchange: 'NFO', maxRetries: 2 });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.protection, 'NONE');
  assert.ok(!calls.some((c) => c.includes('NIFTY26SEP24600PE')), 'the SELL leg must never be touched');
});

test('an iron condor: a naked short after a later BUY leg fails gets unwound, never leaving the SELL open unhedged', async () => {
  const { placer, calls } = scriptedPlacer({
    'NIFTY26SEP24500PE': [{ status: 'COMPLETE', averagePrice: 80 }], // first BUY leg fills fine
    'NIFTY26SEP25500CE': [
      { status: 'REJECTED', averagePrice: null },
      { status: 'REJECTED', averagePrice: null },
      { status: 'REJECTED', averagePrice: null },
    ], // second BUY leg never fills
  });
  const result = await runLiveExecution(IRON_CONDOR_LEGS, passingValidation(), placer, { exchange: 'NFO', maxRetries: 2 });
  assert.equal(result.state, 'FAILED');
  // Neither SELL leg was ever fired — both are still naked shorts protection-wise, so they must never be touched.
  assert.ok(!calls.some((c) => c.includes('place:SELL')), 'no SELL leg may ever be fired when a BUY leg never completed');
  // The one BUY leg that DID fill must be unwound.
  assert.ok(calls.includes('close:NIFTY26SEP24500PE'), 'the filled BUY leg must be unwound rather than left open');
});

test('all BUY legs fill but a SELL leg never does: every filled leg is unwound after retries are exhausted', async () => {
  const { placer, calls } = scriptedPlacer({
    'NIFTY26SEP24500PE': [{ status: 'COMPLETE', averagePrice: 80 }],
    'NIFTY26SEP25500CE': [{ status: 'COMPLETE', averagePrice: 76 }],
    'NIFTY26SEP24600PE': [{ status: 'COMPLETE', averagePrice: 119 }], // first SELL fills
    'NIFTY26SEP25400CE': [
      { status: 'REJECTED', averagePrice: null },
      { status: 'REJECTED', averagePrice: null },
      { status: 'REJECTED', averagePrice: null },
    ], // second SELL never fills
  });
  const result = await runLiveExecution(IRON_CONDOR_LEGS, passingValidation(), placer, { exchange: 'NFO', maxRetries: 2 });
  assert.equal(result.state, 'FAILED');
  assert.ok(calls.includes('close:NIFTY26SEP24500PE'));
  assert.ok(calls.includes('close:NIFTY26SEP25500CE'));
  assert.ok(calls.includes('close:NIFTY26SEP24600PE'));
  assert.ok(!calls.includes('close:NIFTY26SEP25400CE'), 'the leg that never filled has nothing to unwind');
});

test('a genuinely partial fill (some legs already filled) is retried for just the unfilled legs and can still succeed', async () => {
  // Real legFailureHandler.ts semantics (already tested independently):
  // a retry is only offered when the attempt is genuinely PARTIAL — at
  // least one leg already filled. Both BUY legs fill on the first pass;
  // one SELL leg fails on its first try (a real partial state) and is
  // retried; the other SELL leg was never even attempted in pass 1
  // (blocked by its sibling's failure) and fires for the first time once
  // the retry succeeds.
  const { placer, calls } = scriptedPlacer({
    'NIFTY26SEP24500PE': [{ status: 'COMPLETE', averagePrice: 80 }],
    'NIFTY26SEP25500CE': [{ status: 'COMPLETE', averagePrice: 76 }],
    'NIFTY26SEP24600PE': [
      { status: 'REJECTED', averagePrice: null }, // attempt 1 fails
      { status: 'COMPLETE', averagePrice: 119 }, // attempt 2 succeeds
    ],
    'NIFTY26SEP25400CE': [{ status: 'COMPLETE', averagePrice: 111 }],
  });
  const result = await runLiveExecution(IRON_CONDOR_LEGS, passingValidation(), placer, { exchange: 'NFO', maxRetries: 2 });
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.protection, 'FULL');
  const retriedSellCalls = calls.filter((c) => c === 'place:SELL:NIFTY26SEP24600PE');
  assert.equal(retriedSellCalls.length, 2, 'the failed SELL leg should be retried exactly once more');
  const siblingSellCalls = calls.filter((c) => c === 'place:SELL:NIFTY26SEP25400CE');
  assert.equal(siblingSellCalls.length, 1, 'its sibling SELL leg fires exactly once, only once the retry succeeded');
});

test('a live quote wildly off the modeled price is treated as a bad tick and never fired', async () => {
  const { placer, calls } = scriptedPlacer(
    { 'NIFTY26SEP24500PE': [{ status: 'COMPLETE', averagePrice: 80 }] },
    { 'NIFTY26SEP24500PE': quoteAt(500) }, // fillPrice modeled at 80 — 500 is >6x off
  );
  const result = await runLiveExecution(LEGS, passingValidation(), placer, { exchange: 'NFO' });
  assert.equal(result.state, 'FAILED');
  assert.ok(!calls.some((c) => c.startsWith('place:')), 'a bad quote must block the order before it is ever placed');
  assert.ok(result.log.some((l) => l.includes('bad/stale tick')));
});

test('a missing quote (getQuote returns null) blocks that leg without throwing', async () => {
  const { placer } = scriptedPlacer({}, { 'NIFTY26SEP24500PE': null });
  const result = await runLiveExecution(LEGS, passingValidation(), placer, { exchange: 'NFO' });
  assert.equal(result.state, 'FAILED');
  assert.ok(result.log.some((l) => l.includes('no live quote available')));
});
