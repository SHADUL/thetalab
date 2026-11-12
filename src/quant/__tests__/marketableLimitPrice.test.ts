import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketableLimitPrice } from '../execution/liveFill.ts';

test('buy-back crosses the ask with a 5% buffer, rounded up to the tick', () => {
  assert.equal(marketableLimitPrice('BUY', { bid: 499.85, ask: 515.2, lastPrice: 520.15 }), 541);
  assert.equal(marketableLimitPrice('BUY', { bid: 9.9, ask: 10.05, lastPrice: 10 }), 10.6);
});

test('sale crosses the bid with a 5% buffer, rounded down to the tick', () => {
  assert.equal(marketableLimitPrice('SELL', { bid: 476.6, ask: 481.2, lastPrice: 477.7 }), 452.75);
  assert.equal(marketableLimitPrice('SELL', { bid: 0.1, ask: 0.15, lastPrice: 0.1 }), 0.05);
});

test('falls back to last price when that side of the book is empty, never below one tick', () => {
  assert.equal(marketableLimitPrice('BUY', { bid: 0, ask: 0, lastPrice: 20 }), 21);
  assert.equal(marketableLimitPrice('SELL', { bid: 0, ask: 0, lastPrice: 0.05 }), 0.05);
  assert.throws(() => marketableLimitPrice('SELL', { bid: 0, ask: 0, lastPrice: 0 }));
});
