/**
 * Shared Kite stream: overlapping interest from several modules, eventual
 * release of expired interest, and the optional trade metadata for
 * observers — with LiveQuote payloads and existing listeners unchanged.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { marketStream, decodePacket, packetExchangeTs, packetTradeMeta, type QuoteMeta } from '../marketStream.ts';

const interest = () => (marketStream as any).interest as Map<number, number>;
const prune = () => (marketStream as any).supervise(async () => null); // no creds → never connects
const T0 = Date.parse('2026-11-22T06:00:00Z'); // a Sunday: the supervisor only prunes, never connects

test('overlapping requests keep the LATER expiry — AUTO, Naked Sell, NIFTY PULSE and NIFTY ASCENT', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    interest().clear();
    const SHARED = 13_000_001, AUTO_ONLY = 13_000_002, PULSE_ONLY = 13_000_003;
    marketStream.want([SHARED, AUTO_ONLY], 180_000);      // AUTO: option chain, 180 s
    mock.timers.tick(10_000);
    marketStream.want([SHARED]);                           // Naked Sell: default 120 s
    marketStream.want([SHARED, PULSE_ONLY], 120_000);     // NIFTY PULSE: 120 s
    assert.equal(interest().get(SHARED), T0 + 180_000, 'shorter later requests never shorten AUTO');
    marketStream.want([SHARED], 180_000);                  // NIFTY ASCENT: 180 s, 10 s later → extends
    assert.equal(interest().get(SHARED), T0 + 10_000 + 180_000);
    assert.equal(interest().get(AUTO_ONLY), T0 + 180_000, 'other tokens untouched');
    assert.equal(interest().get(PULSE_ONLY), T0 + 10_000 + 120_000);

    // Eventual release: nothing re-requests; every entry expires and the supervisor prunes it.
    mock.timers.tick(125_000); await prune();
    assert.ok(!interest().has(PULSE_ONLY), 'PULSE-only interest released at its own expiry');
    assert.ok(interest().has(SHARED) && interest().has(AUTO_ONLY));
    mock.timers.tick(50_000); await prune(); // T0+185 s: AUTO's 180 s passed, ASCENT's T0+190 s not yet
    assert.ok(!interest().has(AUTO_ONLY));
    assert.ok(interest().has(SHARED), 'still covered by the longest request');
    mock.timers.tick(10_000); await prune();
    assert.equal(interest().size, 0, 'all interest released once every module stops asking');
  } finally { mock.timers.reset(); interest().clear(); }
});

test('the instrument cap still applies to new tokens only', () => {
  interest().clear();
  try {
    for (let i = 1; i <= 2_900; i++) interest().set(20_000_000 + i, Date.now() + 60_000);
    marketStream.want([30_000_000], 180_000);
    assert.ok(!interest().has(30_000_000), 'over the cap: not added');
    marketStream.want([20_000_001], 999_000);
    assert.ok(interest().get(20_000_001)! > Date.now() + 900_000, 'existing token can still be extended');
  } finally { interest().clear(); }
});

function fo184(o: { token: number; ltp: number; volume: number; ltt: number; ltq: number; exch: number }) {
  const b = Buffer.alloc(184);
  b.writeUInt32BE(o.token, 0); b.writeInt32BE(Math.round(o.ltp * 100), 4); b.writeInt32BE(o.ltq, 8);
  b.writeInt32BE(o.volume, 16); b.writeInt32BE(o.ltt, 44); b.writeInt32BE(o.exch, 60);
  return b;
}

test('trade metadata: last trade time and quantity from F&O full packets; null for other packet types', () => {
  const p = fo184({ token: 9, ltp: 210.5, volume: 12_000, ltt: 1_795_000_000, ltq: 65, exch: 1_795_000_003 });
  assert.deepEqual(packetTradeMeta(p), { lastTradeTs: 1_795_000_000_000, lastTradedQty: 65 } satisfies QuoteMeta);
  assert.equal(packetExchangeTs(p), 1_795_000_003_000);
  const idx = Buffer.alloc(32); idx.writeUInt32BE(256265, 0); idx.writeInt32BE(2_500_000, 4);
  assert.equal(packetTradeMeta(idx), null);
  assert.equal(packetTradeMeta(Buffer.alloc(44)), null);
  assert.deepEqual(packetTradeMeta(fo184({ token: 9, ltp: 1, volume: 0, ltt: 0, ltq: 0, exch: 1 }))!.lastTradeTs, null);
});

test('LiveQuote payload is unchanged (no new fields) and two-argument listeners keep working', () => {
  const q = decodePacket(fo184({ token: 9, ltp: 210.5, volume: 12_000, ltt: 1_795_000_000, ltq: 65, exch: 1_795_000_003 }), 1)!;
  assert.deepEqual(Object.keys(q).sort(), ['ask', 'bid', 'depth', 'ltp', 'oi', 'receivedAt', 'token', 'volume']);
  const calls: unknown[][] = [];
  const legacy = (a: unknown, b: unknown) => { calls.push([a, b]); };
  const off = marketStream.onQuote(legacy);
  for (const fn of (marketStream as any).listeners) fn(q, 5, { lastTradeTs: 1, lastTradedQty: 2 });
  off();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 5);
});
