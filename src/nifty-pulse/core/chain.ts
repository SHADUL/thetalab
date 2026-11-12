/**
 * Option-chain snapshot shape shared by live market data and the replay
 * simulator. Spread construction only ever sees this interface, so the same
 * code prices live and simulated spreads.
 */
export type Right = 'CE' | 'PE';

export interface OptionQuote {
  token: number;
  tradingsymbol: string;
  strike: number;
  right: Right;
  expiry: string;
  lotSize: number;
  bid: number | null;
  ask: number | null;
  bidQty: number;
  askQty: number;
  ltp: number | null;
  /** Receipt time of this quote, epoch ms (null = never received). */
  ts: number | null;
}

export interface ChainSnapshot {
  underlying: 'NIFTY';
  spot: number;
  expiry: string;
  lotSize: number;
  strikeStep: number;
  /** Snapshot time, epoch ms. */
  at: number;
  /** Source label — 'SIMULATION' quotes must never be reported as market data. */
  source: 'LIVE' | 'SIMULATION';
  quote(strike: number, right: Right): OptionQuote | undefined;
}

export function atmStrike(spot: number, step: number): number {
  return Math.round(spot / step) * step;
}

export function mid(q: OptionQuote): number | null {
  return q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
}
