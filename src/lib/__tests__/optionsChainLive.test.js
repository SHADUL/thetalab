import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStrikesNearSpot, chunk, kiteQuoteToOptionRow, buildInstrumentKeys, MAX_QUOTE_INSTRUMENTS } from '../optionsChainLive.js';

test('selectStrikesNearSpot keeps only strikes within the width band, de-duplicated and sorted', () => {
  const strikes = [20000, 24000, 24500, 25000, 25500, 26000, 30000, 25000]; // duplicate 25000 on purpose
  const selected = selectStrikesNearSpot(strikes, 25000, 0.08); // band: 23000-27000
  assert.deepEqual(selected, [24000, 24500, 25000, 25500, 26000]);
});

test('selectStrikesNearSpot with a narrower band excludes more', () => {
  const strikes = [24000, 24500, 25000, 25500, 26000];
  const selected = selectStrikesNearSpot(strikes, 25000, 0.02); // band: 24500-25500
  assert.deepEqual(selected, [24500, 25000, 25500]);
});

test('chunk splits into groups no larger than size, preserving order', () => {
  const items = Array.from({ length: 125 }, (_, i) => i);
  const chunks = chunk(items, 50);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 50);
  assert.equal(chunks[1].length, 50);
  assert.equal(chunks[2].length, 25);
  assert.deepEqual(chunks.flat(), items);
});

test('MAX_QUOTE_INSTRUMENTS matches the documented Kite per-call cap', () => {
  assert.equal(MAX_QUOTE_INSTRUMENTS, 50);
});

test('kiteQuoteToOptionRow maps bid/ask/last/oi/volume and leaves settle null for a live quote', () => {
  const row = kiteQuoteToOptionRow({
    strike: 24600, right: 'PE', expiryEpochMs: 1_800_000_000_000, asOfEpochMs: 1_790_000_000_000,
    quote: { last_price: 120.5, depth: { buy: [{ price: 119 }], sell: [{ price: 122 }] }, oi: 45000, volume: 8000 },
  });
  assert.equal(row.right, 'PE');
  assert.equal(row.strike, 24600);
  assert.equal(row.bid, 119);
  assert.equal(row.ask, 122);
  assert.equal(row.last, 120.5);
  assert.equal(row.settle, null);
  assert.equal(row.openInterest, 45000);
  assert.equal(row.volume, 8000);
});

test('kiteQuoteToOptionRow tolerates a quote with no depth (illiquid strike) rather than throwing', () => {
  const row = kiteQuoteToOptionRow({
    strike: 30000, right: 'CE', expiryEpochMs: 1_800_000_000_000, asOfEpochMs: 1_790_000_000_000,
    quote: { last_price: 0.05, oi: 0, volume: 0 },
  });
  assert.equal(row.bid, null);
  assert.equal(row.ask, null);
  assert.equal(row.last, 0.05);
});

test('buildInstrumentKeys produces EXCHANGE:TRADINGSYMBOL keys and a reverse lookup by strike/right', () => {
  const instruments = [
    { strike: 24600, right: 'PE', tradingsymbol: 'NIFTY26SEP24600PE' },
    { strike: 25400, right: 'CE', tradingsymbol: 'NIFTY26SEP25400CE' },
  ];
  const { keys, byKey } = buildInstrumentKeys(instruments, 'NFO');
  assert.deepEqual(keys, ['NFO:NIFTY26SEP24600PE', 'NFO:NIFTY26SEP25400CE']);
  assert.deepEqual(byKey.get('NFO:NIFTY26SEP24600PE'), { strike: 24600, right: 'PE' });
});
