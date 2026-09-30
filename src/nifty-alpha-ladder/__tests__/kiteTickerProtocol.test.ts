import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFullModePacket, splitPackets, parseFrame, buildSubscribeMessage, buildSetModeFullMessage } from '../live/kiteTickerProtocol.ts';

/** Builds a hand-constructed 184-byte full-mode packet matching the documented layout, for deterministic parser testing (no real captured packet was available this session — see the module's own header). */
function buildFullPacket(fields: {
  instrumentToken: number; lastPrice: number; lastTradedQuantity: number; averageTradedPrice: number;
  volume: number; totalBuyQuantity: number; totalSellQuantity: number; open: number; high: number; low: number; close: number;
  lastTradeTimeEpochSec: number; oi: number; oiDayHigh: number; oiDayLow: number; exchangeTimestampEpochSec: number;
  bidDepth: Array<{ quantity: number; price: number; orders: number }>;
  askDepth: Array<{ quantity: number; price: number; orders: number }>;
}): Buffer {
  const buf = Buffer.alloc(184);
  buf.writeUInt32BE(fields.instrumentToken, 0);
  buf.writeInt32BE(Math.round(fields.lastPrice * 100), 4);
  buf.writeInt32BE(fields.lastTradedQuantity, 8);
  buf.writeInt32BE(Math.round(fields.averageTradedPrice * 100), 12);
  buf.writeInt32BE(fields.volume, 16);
  buf.writeInt32BE(fields.totalBuyQuantity, 20);
  buf.writeInt32BE(fields.totalSellQuantity, 24);
  buf.writeInt32BE(Math.round(fields.open * 100), 28);
  buf.writeInt32BE(Math.round(fields.high * 100), 32);
  buf.writeInt32BE(Math.round(fields.low * 100), 36);
  buf.writeInt32BE(Math.round(fields.close * 100), 40);
  buf.writeInt32BE(fields.lastTradeTimeEpochSec, 44);
  buf.writeInt32BE(fields.oi, 48);
  buf.writeInt32BE(fields.oiDayHigh, 52);
  buf.writeInt32BE(fields.oiDayLow, 56);
  buf.writeInt32BE(fields.exchangeTimestampEpochSec, 60);
  const allLevels = [...fields.bidDepth, ...fields.askDepth];
  allLevels.forEach((level, i) => {
    const off = 64 + i * 12;
    buf.writeInt32BE(level.quantity, off);
    buf.writeInt32BE(Math.round(level.price * 100), off + 4);
    buf.writeInt16BE(level.orders, off + 8);
    buf.writeInt16BE(0, off + 10); // padding
  });
  return buf;
}

const sampleFields = {
  instrumentToken: 12468226, lastPrice: 22822, lastTradedQuantity: 65, averageTradedPrice: 22800,
  volume: 100000, totalBuyQuantity: 5000, totalSellQuantity: 4800, open: 22700, high: 22900, low: 22650, close: 22750,
  lastTradeTimeEpochSec: 1790763600, oi: 0, oiDayHigh: 0, oiDayLow: 0, exchangeTimestampEpochSec: 1790763600,
  bidDepth: [
    { quantity: 260, price: 22815.6, orders: 2 }, { quantity: 65, price: 22815, orders: 1 },
    { quantity: 130, price: 22814.5, orders: 1 }, { quantity: 65, price: 22814, orders: 1 }, { quantity: 65, price: 22813.5, orders: 1 },
  ],
  askDepth: [
    { quantity: 65, price: 22820, orders: 1 }, { quantity: 130, price: 22820.5, orders: 2 },
    { quantity: 65, price: 22821, orders: 1 }, { quantity: 65, price: 22821.5, orders: 1 }, { quantity: 65, price: 22822, orders: 1 },
  ],
};

test('parseFullModePacket: round-trips every field of a hand-built packet exactly', () => {
  const packet = buildFullPacket(sampleFields);
  const parsed = parseFullModePacket(packet);
  assert.equal(parsed.instrumentToken, sampleFields.instrumentToken);
  assert.equal(parsed.lastPrice, sampleFields.lastPrice);
  assert.equal(parsed.volume, sampleFields.volume);
  assert.equal(parsed.exchangeTimestampEpochSec, sampleFields.exchangeTimestampEpochSec);
  assert.deepEqual(parsed.bidDepth, sampleFields.bidDepth);
  assert.deepEqual(parsed.askDepth, sampleFields.askDepth);
});

test('parseFullModePacket: rejects a packet of the wrong length rather than mis-parsing it', () => {
  assert.throws(() => parseFullModePacket(Buffer.alloc(100)));
});

test('splitPackets: extracts N length-prefixed packets from one frame', () => {
  const p1 = buildFullPacket(sampleFields);
  const p2 = buildFullPacket({ ...sampleFields, instrumentToken: 999 });
  const frame = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(2, 0); return b; })(),
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(p1.length, 0); return b; })(), p1,
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(p2.length, 0); return b; })(), p2,
  ]);
  const packets = splitPackets(frame);
  assert.equal(packets.length, 2);
  assert.equal(packets[0].length, 184);
  assert.equal(packets[1].length, 184);
});

test('parseFrame: end-to-end frame -> ticks, skipping non-184-byte packets', () => {
  const p1 = buildFullPacket(sampleFields);
  const shortPacket = Buffer.alloc(8); // an LTP-only packet shape, not full mode — must be skipped, not mis-parsed
  const frame = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(2, 0); return b; })(),
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(p1.length, 0); return b; })(), p1,
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(shortPacket.length, 0); return b; })(), shortPacket,
  ]);
  const ticks = parseFrame(frame);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].instrumentToken, sampleFields.instrumentToken);
});

test('message builders produce the documented subscribe/mode JSON shapes', () => {
  assert.equal(buildSubscribeMessage([123, 456]), JSON.stringify({ a: 'subscribe', v: [123, 456] }));
  assert.equal(buildSetModeFullMessage([123]), JSON.stringify({ a: 'mode', v: ['full', [123]] }));
});
