import type { ChainSnapshot, OptionQuote, Right } from '../core/chain.ts';
import type { Sample } from '../core/sampler.ts';

export const T0 = Date.parse('2026-11-13T10:00:00+05:30');

/** Hand-built chain: quotes[`${strike}${right}`] = [bid, ask] (null = absent). */
export function fakeChain(o: {
  spot: number; at?: number; lotSize?: number; step?: number; expiry?: string;
  quotes: Record<string, [number | null, number | null] | { bid: number | null; ask: number | null; bidQty?: number; askQty?: number; ts?: number | null; expiry?: string }>;
}): ChainSnapshot {
  const at = o.at ?? T0;
  const lot = o.lotSize ?? 65;
  const expiry = o.expiry ?? '2026-11-17';
  return {
    underlying: 'NIFTY', spot: o.spot, expiry, lotSize: lot, strikeStep: o.step ?? 50, at, source: 'SIMULATION',
    quote(strike: number, right: Right): OptionQuote | undefined {
      const v = o.quotes[`${strike}${right}`];
      if (!v) return undefined;
      const q = Array.isArray(v) ? { bid: v[0], ask: v[1] } : v;
      return {
        token: strike, tradingsymbol: `NIFTY${strike}${right}`, strike, right, expiry: (q as any).expiry ?? expiry, lotSize: lot,
        bid: q.bid, ask: q.ask, bidQty: (q as any).bidQty ?? lot * 10, askQty: (q as any).askQty ?? lot * 10,
        ltp: null, ts: (q as any).ts === undefined ? at - 100 : (q as any).ts,
      };
    },
  };
}

/** Consecutive valid FRESH samples from prices. */
export function samplesFrom(prices: number[], start = T0): Sample[] {
  return prices.map((p, i) => ({ t: start + i * 1000, price: p, status: 'FRESH', valid: true, ticks: 1, ageMs: 100, exchTs: start + i * 1000 - 100 }));
}

/** 61+ samples: flat history, then a tail. */
export function series(tail: number[], base = 25_000, flat = 60): number[] {
  return [...Array.from({ length: flat }, () => base), ...tail];
}
