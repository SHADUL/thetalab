/**
 * Builds a LIVE ChainSnapshot from the shared Kite stream's in-memory quotes.
 * Pure: the quote getter is injected, so this file has no network access.
 *
 * Quote age is the honest receipt time of the last packet for that contract.
 * Kite only pushes on change, so a quiet leg ages out of `quoteFreshnessMs`
 * and the spread is rejected as stale — deliberately conservative for paper
 * results.
 */
import type { ChainSnapshot, OptionQuote, Right } from '../core/chain.ts';

/** Minimal shape of server/marketStream.ts LiveQuote that the chain needs. */
export interface StreamQuote {
  token: number;
  ltp: number;
  bid: number | null;
  ask: number | null;
  depth: { buy: Array<{ price: number; quantity: number }>; sell: Array<{ price: number; quantity: number }> } | null;
  receivedAt: number;
}

export interface InstrumentRow {
  token: number;
  tradingsymbol: string;
  strike: number;
  right: Right;
  expiry: string;
  lotSize: number;
}

export interface ChainMeta {
  expiry: string;
  lotSize: number;
  strikeStep: number;
  rows: InstrumentRow[];
}

export const NIFTY_STRIKE_STEP = 50;

function topQty(levels: Array<{ price: number; quantity: number }> | undefined, price: number | null): number {
  if (!levels || price == null) return 0;
  return levels.find((l) => l.price === price && l.quantity > 0)?.quantity ?? 0;
}

export function toOptionQuote(row: InstrumentRow, q: StreamQuote | null): OptionQuote {
  return {
    token: row.token,
    tradingsymbol: row.tradingsymbol,
    strike: row.strike,
    right: row.right,
    expiry: row.expiry,
    lotSize: row.lotSize,
    bid: q?.bid ?? null,
    ask: q?.ask ?? null,
    bidQty: topQty(q?.depth?.buy, q?.bid ?? null),
    askQty: topQty(q?.depth?.sell, q?.ask ?? null),
    ltp: q?.ltp ?? null,
    ts: q?.receivedAt ?? null,
  };
}

export function buildLiveChain(meta: ChainMeta, spot: number, at: number, get: (token: number) => StreamQuote | null): ChainSnapshot {
  const quotes = new Map<string, OptionQuote>();
  for (const r of meta.rows) quotes.set(`${r.strike}${r.right}`, toOptionQuote(r, get(r.token)));
  return {
    underlying: 'NIFTY',
    spot,
    expiry: meta.expiry,
    lotSize: meta.lotSize,
    strikeStep: meta.strikeStep,
    at,
    source: 'LIVE',
    quote: (strike: number, right: Right) => quotes.get(`${strike}${right}`),
  };
}

/** Serializable form of a chain for the browser (no functions). */
export interface ChainWire {
  spot: number;
  expiry: string;
  lotSize: number;
  strikeStep: number;
  at: number;
  source: 'LIVE' | 'SIMULATION';
  quotes: OptionQuote[];
}

export function chainToWire(c: ChainSnapshot, rows: InstrumentRow[]): ChainWire {
  const quotes: OptionQuote[] = [];
  for (const r of rows) { const q = c.quote(r.strike, r.right); if (q) quotes.push(q); }
  return { spot: c.spot, expiry: c.expiry, lotSize: c.lotSize, strikeStep: c.strikeStep, at: c.at, source: c.source, quotes };
}

export function chainFromWire(w: ChainWire): ChainSnapshot {
  const m = new Map<string, OptionQuote>();
  for (const q of w.quotes) m.set(`${q.strike}${q.right}`, q);
  return { underlying: 'NIFTY', spot: w.spot, expiry: w.expiry, lotSize: w.lotSize, strikeStep: w.strikeStep, at: w.at, source: w.source, quote: (k: number, r: Right) => m.get(`${k}${r}`) };
}
