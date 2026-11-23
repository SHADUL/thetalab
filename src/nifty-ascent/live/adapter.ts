/**
 * Converts quotes observed on ThetaLab's shared Kite stream into NIFTY
 * ASCENT engine events. Pure (no I/O) so it is fully testable.
 *
 * Data policy:
 *  - Every event needs the EXCHANGE timestamp Kite puts in full-mode
 *    packets (index 32 B, F&O 184 B). A quote without one is dropped and
 *    counted — bars are never built from receipt time.
 *  - An option print is a TRADE only when the cumulative day volume rose
 *    since the previous packet for that token. The first packet after a
 *    subscription is therefore never a trade (its LTP may be hours old), and
 *    a volume decrease (feed reset) is treated as no trade and re-baselined.
 *  - Duplicate / out-of-order / late handling happens in the bar builder.
 */
import type { IndexTick, OptionTick } from '../core/engine.ts';

export const NIFTY_INDEX_TOKEN = 256265;

/** The subset of the shared stream's LiveQuote that ASCENT reads. */
export interface StreamQuote {
  token: number;
  ltp: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  receivedAt: number;
}

export type AdaptedEvent =
  | { kind: 'INDEX'; tick: IndexTick }
  | { kind: 'OPTION'; tick: OptionTick }
  | { kind: 'DROP'; reason: 'no_exchange_ts' | 'bad_price' | 'not_tracked' };

export interface AdapterStats {
  indexQuotes: number;
  optionQuotes: number;
  optionTrades: number;
  noExchangeTs: number;
  badPrice: number;
  volumeResets: number;
  ignored: number;
  lastIndexExchTs: number | null;
  lastIndexRecvTs: number | null;
}

export class QuoteAdapter {
  readonly stats: AdapterStats = { indexQuotes: 0, optionQuotes: 0, optionTrades: 0, noExchangeTs: 0, badPrice: 0, volumeResets: 0, ignored: 0, lastIndexExchTs: null, lastIndexRecvTs: null };
  private lastVolume = new Map<number, number>();
  private readonly indexToken: number;
  constructor(indexToken = NIFTY_INDEX_TOKEN) { this.indexToken = indexToken; }

  /** `isTracked(token)` limits option events to contracts the engine asked for. */
  adapt(q: StreamQuote, exchTs: number | null, isTracked: (token: number) => boolean): AdaptedEvent {
    if (q.token !== this.indexToken && !isTracked(q.token)) { this.stats.ignored++; return { kind: 'DROP', reason: 'not_tracked' }; }
    if (exchTs == null || !(exchTs > 0)) { this.stats.noExchangeTs++; return { kind: 'DROP', reason: 'no_exchange_ts' }; }
    if (!(q.ltp > 0) || !Number.isFinite(q.ltp)) { this.stats.badPrice++; return { kind: 'DROP', reason: 'bad_price' }; }
    if (q.token === this.indexToken) {
      this.stats.indexQuotes++;
      this.stats.lastIndexExchTs = exchTs; this.stats.lastIndexRecvTs = q.receivedAt;
      return { kind: 'INDEX', tick: { exchTs, recvTs: q.receivedAt, price: q.ltp } };
    }
    this.stats.optionQuotes++;
    const prev = this.lastVolume.get(q.token);
    let traded = false;
    if (q.volume != null) {
      if (prev != null && q.volume > prev) traded = true;
      if (prev != null && q.volume < prev) this.stats.volumeResets++;
      this.lastVolume.set(q.token, q.volume);
    }
    if (traded) this.stats.optionTrades++;
    return {
      kind: 'OPTION',
      tick: { token: q.token, exchTs, recvTs: q.receivedAt, ltp: traded ? q.ltp : null, traded, bid: q.bid, ask: q.ask, volume: q.volume },
    };
  }
}
