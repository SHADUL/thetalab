import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, decodeFrame } from '../marketStream.ts';

function fullPacket(token: number, ltp: number, bid: number, ask: number): Buffer {
  const b = Buffer.alloc(184);
  b.writeUInt32BE(token, 0);
  b.writeInt32BE(Math.round(ltp * 100), 4);
  b.writeInt32BE(12345, 16); // volume
  b.writeInt32BE(500, 48); // oi
  // depth: 5 bids then 5 asks, 12 bytes each from offset 64
  b.writeInt32BE(75, 64); b.writeInt32BE(Math.round(bid * 100), 68);
  b.writeInt32BE(75, 64 + 60); b.writeInt32BE(Math.round(ask * 100), 64 + 64);
  return b;
}

function frame(packets: Buffer[]): Buffer {
  const parts = [Buffer.alloc(2)];
  parts[0].writeInt16BE(packets.length, 0);
  for (const p of packets) { const l = Buffer.alloc(2); l.writeInt16BE(p.length, 0); parts.push(l, p); }
  return Buffer.concat(parts);
}

test('decodePacket reads full F&O packets with best bid/ask', () => {
  const q = decodePacket(fullPacket(12345678, 94.4, 94.3, 94.55), 1)!;
  const { depth, ...rest } = q;
  assert.deepEqual(rest, { token: 12345678, ltp: 94.4, bid: 94.3, ask: 94.55, volume: 12345, oi: 500, receivedAt: 1 });
  assert.equal(depth!.buy.length, 5);
  assert.deepEqual(depth!.buy[0], { quantity: 75, price: 94.3, orders: 0 });
  assert.equal(depth!.sell[0].price, 94.55);
});

test('decodePacket reads index packets (last price only)', () => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(256265, 0);
  b.writeInt32BE(2524115, 4);
  const q = decodePacket(b, 1)!;
  assert.equal(q.token, 256265);
  assert.equal(q.ltp, 25241.15);
  assert.equal(q.bid, null);
});

test('decodePacket: empty depth side becomes null, not 0', () => {
  const p = fullPacket(1, 10, 0, 10.5);
  assert.equal(decodePacket(p, 1)!.bid, null);
});

test('decodeFrame splits multi-packet frames and ignores heartbeats', () => {
  const idx = Buffer.alloc(8); idx.writeUInt32BE(265, 0); idx.writeInt32BE(8180744, 4);
  const qs = decodeFrame(frame([fullPacket(1, 10, 9.9, 10.1), idx]), 5);
  assert.equal(qs.length, 2);
  assert.equal(qs[1].ltp, 81807.44);
  assert.equal(decodeFrame(Buffer.alloc(1), 5).length, 0);
});

test('toRestQuote mirrors Kite REST quote shape', async () => {
  const { toRestQuote } = await import('../marketStream.ts');
  const r = toRestQuote(decodePacket(fullPacket(1, 10, 9.9, 10.1), 1)!);
  assert.equal(r.last_price, 10);
  assert.equal(r.depth!.buy[0].price, 9.9);
  assert.equal(r.depth!.sell[0].price, 10.1);
  const idx = Buffer.alloc(8); idx.writeUInt32BE(265, 0); idx.writeInt32BE(100, 4);
  assert.deepEqual(toRestQuote(decodePacket(idx, 1)!), { last_price: 1 });
});
