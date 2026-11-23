/**
 * Converts quotes observed on ThetaLab's shared Kite stream into NIFTY
 * ASCENT engine events. Pure (no I/O) so it is fully testable.
 *
 * Data policy:
 *  - Every event needs the EXCHANGE timestamp Kite puts in full-mode
 *    packets (index 32 B, F&O 184 B). A quote without one is dropped and
 *    counted — bars are never built from receipt time.
 *  - An option print is a TRADE only with evidence of a new trade since the
 *    previous packet for that token: Kite's last-trade timestamp advanced
 *    and/or the cumulative day volume rose. A quote-only update (neither) is
 *    never a trade, even if the LTP field changed. The first packet after a
 *    subscription is a baseline, never a trade (its LTP may be hours old).
 *    Every combination is COUNTED (see TradeDetection) so disagreements
 *    between the two methods are reported, not silently resolved.
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

/** Optional Kite trade metadata from F&O full packets (shared stream's QuoteMeta). */
export interface TradeMeta { lastTradeTs: number | null; lastTradedQty: number | null }

/** How each option packet was classified — the evidence for validating trade detection. */
export interface TradeDetection {
  packets: number;
  baselines: number;
  /** Neither last-trade time nor volume advanced: quote-only update. */
  quoteOnly: number;
  /** Both advanced: unambiguous trade. */
  both: number;
  /** Last-trade time advanced but volume did not — disagreement. */
  lttOnly: number;
  /** Volume rose but last-trade time did not (e.g. two trades in one second) — disagreement. */
  volumeOnly: number;
  /** No last-trade timestamp on the packet: volume alone decided. */
  noLtt: number;
  /** LTP field changed on a quote-only update (NOT treated as a trade). */
  ltpChangedWithoutTrade: number;
  lttBackwards: number;
  volumeResets: number;
  /** Sum of last-traded quantities on trade packets, vs the volume increase. */
  ltqSum: number;
  volumeDeltaSum: number;
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
  ignored: number;
  lastIndexExchTs: number | null;
  lastIndexRecvTs: number | null;
}

export class QuoteAdapter {
  readonly stats: AdapterStats = { indexQuotes: 0, optionQuotes: 0, optionTrades: 0, noExchangeTs: 0, badPrice: 0, ignored: 0, lastIndexExchTs: null, lastIndexRecvTs: null };
  readonly detection: TradeDetection = { packets: 0, baselines: 0, quoteOnly: 0, both: 0, lttOnly: 0, volumeOnly: 0, noLtt: 0, ltpChangedWithoutTrade: 0, lttBackwards: 0, volumeResets: 0, ltqSum: 0, volumeDeltaSum: 0 };
  /** Per-token detection counts (for the observation report). */
  readonly detectionByToken = new Map<number, TradeDetection>();
  private last = new Map<number, { volume: number | null; ltt: number | null; ltp: number }>();
  private readonly indexToken: number;
  constructor(indexToken = NIFTY_INDEX_TOKEN) { this.indexToken = indexToken; }

  /** `isTracked(token)` limits option events to contracts the engine asked for. */
  adapt(q: StreamQuote, exchTs: number | null, isTracked: (token: number) => boolean, meta?: TradeMeta | null): AdaptedEvent {
    if (q.token !== this.indexToken && !isTracked(q.token)) { this.stats.ignored++; return { kind: 'DROP', reason: 'not_tracked' }; }
    if (exchTs == null || !(exchTs > 0)) { this.stats.noExchangeTs++; return { kind: 'DROP', reason: 'no_exchange_ts' }; }
    if (!(q.ltp > 0) || !Number.isFinite(q.ltp)) { this.stats.badPrice++; return { kind: 'DROP', reason: 'bad_price' }; }
    if (q.token === this.indexToken) {
      this.stats.indexQuotes++;
      this.stats.lastIndexExchTs = exchTs; this.stats.lastIndexRecvTs = q.receivedAt;
      return { kind: 'INDEX', tick: { exchTs, recvTs: q.receivedAt, price: q.ltp } };
    }
    this.stats.optionQuotes++;
    const traded = this.classify(q, meta ?? null);
    if (traded) this.stats.optionTrades++;
    return {
      kind: 'OPTION',
      tick: { token: q.token, exchTs, recvTs: q.receivedAt, ltp: traded ? q.ltp : null, traded, bid: q.bid, ask: q.ask, volume: q.volume },
    };
  }

  private classify(q: StreamQuote, meta: TradeMeta | null): boolean {
    const ltt = meta?.lastTradeTs ?? null;
    const prev = this.last.get(q.token);
    this.last.set(q.token, { volume: q.volume ?? prev?.volume ?? null, ltt: ltt ?? prev?.ltt ?? null, ltp: q.ltp });
    let d = this.detectionByToken.get(q.token);
    if (!d) { d = { packets: 0, baselines: 0, quoteOnly: 0, both: 0, lttOnly: 0, volumeOnly: 0, noLtt: 0, ltpChangedWithoutTrade: 0, lttBackwards: 0, volumeResets: 0, ltqSum: 0, volumeDeltaSum: 0 }; this.detectionByToken.set(q.token, d); }
    const bump = (k: keyof TradeDetection, n = 1) => { this.detection[k] += n; d![k] += n; };
    bump('packets');
    if (!prev) { bump('baselines'); return false; }
    let volUp = false;
    if (q.volume != null && prev.volume != null) {
      if (q.volume > prev.volume) { volUp = true; bump('volumeDeltaSum', q.volume - prev.volume); }
      else if (q.volume < prev.volume) { bump('volumeResets'); }
    }
    let lttUp = false;
    if (ltt != null && prev.ltt != null) {
      if (ltt > prev.ltt) lttUp = true;
      else if (ltt < prev.ltt) bump('lttBackwards');
    }
    if (ltt == null) bump('noLtt');
    const traded = lttUp || volUp;
    if (lttUp && volUp) bump('both');
    else if (lttUp) bump('lttOnly');
    else if (volUp) bump('volumeOnly');
    else { bump('quoteOnly'); if (q.ltp !== prev.ltp) bump('ltpChangedWithoutTrade'); }
    if (traded && meta?.lastTradedQty != null) bump('ltqSum', meta.lastTradedQty);
    return traded;
  }
}
