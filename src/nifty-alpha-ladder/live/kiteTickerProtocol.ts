/**
 * Kite Connect WebSocket ticker wire protocol — pure encode/decode, no
 * socket I/O (that lives in kiteDepthSource.ts). Implemented against Kite's
 * publicly documented binary "full" mode tick format (instrument token,
 * OHLC, OI, and 10×12-byte depth entries: 5 bid + 5 ask, each
 * quantity(int32)+price(int32, paisa)+orders(int16)+padding(int16)).
 *
 * HONEST LIMITATION: this parser has NOT been verified against a captured
 * live Kite packet in this session (no live WebSocket connection was made
 * — see the Milestone 3 report). It is tested here only against
 * hand-built buffers matching the documented layout. Verify against a real
 * captured packet before depending on this in a live run.
 */

export interface DepthLevel {
  quantity: number;
  price: number;
  orders: number;
}

export interface FullModeTick {
  instrumentToken: number;
  lastPrice: number;
  lastTradedQuantity: number;
  averageTradedPrice: number;
  volume: number;
  totalBuyQuantity: number;
  totalSellQuantity: number;
  open: number;
  high: number;
  low: number;
  close: number;
  lastTradeTimeEpochSec: number;
  oi: number;
  oiDayHigh: number;
  oiDayLow: number;
  exchangeTimestampEpochSec: number;
  bidDepth: DepthLevel[];
  askDepth: DepthLevel[];
}

const FULL_PACKET_LENGTH = 184;
const DEPTH_ENTRY_LENGTH = 12;
const DEPTH_ENTRIES = 10; // 5 bid + 5 ask

function readPrice(buf: Buffer, offset: number): number {
  return buf.readInt32BE(offset) / 100;
}

/** Parses one 184-byte "full" mode packet (with depth). Throws on any other length — this parser only handles the full+depth shape this strategy needs. */
export function parseFullModePacket(buf: Buffer): FullModeTick {
  if (buf.length !== FULL_PACKET_LENGTH) {
    throw new Error(`parseFullModePacket: expected a ${FULL_PACKET_LENGTH}-byte full-mode packet, got ${buf.length} bytes.`);
  }
  const bidDepth: DepthLevel[] = [];
  const askDepth: DepthLevel[] = [];
  const depthStart = 64;
  for (let i = 0; i < DEPTH_ENTRIES; i++) {
    const off = depthStart + i * DEPTH_ENTRY_LENGTH;
    const level: DepthLevel = {
      quantity: buf.readInt32BE(off),
      price: readPrice(buf, off + 4),
      orders: buf.readInt16BE(off + 8),
    };
    if (i < 5) bidDepth.push(level);
    else askDepth.push(level);
  }
  return {
    instrumentToken: buf.readUInt32BE(0),
    lastPrice: readPrice(buf, 4),
    lastTradedQuantity: buf.readInt32BE(8),
    averageTradedPrice: readPrice(buf, 12),
    volume: buf.readInt32BE(16),
    totalBuyQuantity: buf.readInt32BE(20),
    totalSellQuantity: buf.readInt32BE(24),
    open: readPrice(buf, 28),
    high: readPrice(buf, 32),
    low: readPrice(buf, 36),
    close: readPrice(buf, 40),
    lastTradeTimeEpochSec: buf.readInt32BE(44),
    oi: buf.readInt32BE(48),
    oiDayHigh: buf.readInt32BE(52),
    oiDayLow: buf.readInt32BE(56),
    exchangeTimestampEpochSec: buf.readInt32BE(60),
    bidDepth,
    askDepth,
  };
}

/** Splits a full WebSocket binary frame into its constituent per-instrument packets: 2-byte packet count, then per packet a 2-byte length prefix + payload. */
export function splitPackets(frame: Buffer): Buffer[] {
  if (frame.length < 2) return [];
  const count = frame.readInt16BE(0);
  const packets: Buffer[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > frame.length) break;
    const len = frame.readInt16BE(offset);
    offset += 2;
    if (offset + len > frame.length) break;
    packets.push(frame.subarray(offset, offset + len));
    offset += len;
  }
  return packets;
}

/** Parses a full WebSocket frame into every full-mode tick it contains, skipping any packet that isn't the 184-byte full+depth shape (e.g. a smaller LTP-only packet for an instrument not subscribed in full mode). */
export function parseFrame(frame: Buffer): FullModeTick[] {
  return splitPackets(frame)
    .filter((p) => p.length === FULL_PACKET_LENGTH)
    .map(parseFullModePacket);
}

export function buildSubscribeMessage(instrumentTokens: number[]): string {
  return JSON.stringify({ a: 'subscribe', v: instrumentTokens });
}

export function buildSetModeFullMessage(instrumentTokens: number[]): string {
  return JSON.stringify({ a: 'mode', v: ['full', instrumentTokens] });
}
