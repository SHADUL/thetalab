/**
 * Observe-only session report for NIFTY ASCENT. Collects what the owner asked
 * to see from a real market session — reference and gap, previous 15:15
 * close, all 31 opening-range closes, bands, gap-fill ticks, stand-downs,
 * Williams eligibility / handover / levels, signals and the contract that
 * WOULD have been selected, plus data quality: per-minute tick counts and
 * exchange→receipt latency, missing minutes, stream health and option quote
 * freshness / spread for any subscribed contract. Pure aggregation, no I/O.
 */
import type { AscentEngine } from '../core/engine.ts';
import type { ContractSelection } from '../core/contracts.ts';
import { hhmm, barLabelOf, RESEARCH_RULES_V1 as R } from '../core/rules.ts';

interface Lag { n: number; sum: number; max: number; min: number }
const lagNew = (): Lag => ({ n: 0, sum: 0, max: -Infinity, min: Infinity });
const lagAdd = (l: Lag, v: number) => { l.n++; l.sum += v; l.max = Math.max(l.max, v); l.min = Math.min(l.min, v); };
const lagOut = (l: Lag) => (l.n ? { n: l.n, avgMs: Math.round(l.sum / l.n), minMs: l.min, maxMs: l.max } : { n: 0 });

export interface StreamStatus { connected?: boolean; subscribed?: number; wanted?: number; lastMessageAgoMs?: number | null; reconnects?: number; lastError?: string | null }

export class ObservationRecorder {
  private readonly date: string;
  private indexLagByMin = new Map<number, Lag>();
  private indexLag = lagNew();
  private optionLag = new Map<number, Lag>();
  private optionSpread = new Map<number, { n: number; sum: number; max: number; oneSided: number }>();
  private optionTrades = new Map<number, number>();
  private streamSamples = 0;
  private streamDown = 0;
  private reconnectsStart: number | null = null;
  private lastStream: StreamStatus | null = null;
  private maxSubscribed = 0;
  constructor(date: string) { this.date = date; }

  onIndexTick(exchTs: number, recvTs: number) {
    const m = barLabelOf(this.date, exchTs);
    if (!this.indexLagByMin.has(m)) this.indexLagByMin.set(m, lagNew());
    lagAdd(this.indexLagByMin.get(m)!, recvTs - exchTs);
    lagAdd(this.indexLag, recvTs - exchTs);
  }

  onOptionQuote(token: number, exchTs: number, recvTs: number, bid: number | null, ask: number | null, traded: boolean) {
    if (!this.optionLag.has(token)) { this.optionLag.set(token, lagNew()); this.optionSpread.set(token, { n: 0, sum: 0, max: 0, oneSided: 0 }); }
    lagAdd(this.optionLag.get(token)!, recvTs - exchTs);
    const sp = this.optionSpread.get(token)!;
    if (bid != null && ask != null && bid > 0 && ask >= bid) { const pct = ((ask - bid) / ((ask + bid) / 2)) * 100; sp.n++; sp.sum += pct; sp.max = Math.max(sp.max, pct); } else sp.oneSided++;
    if (traded) this.optionTrades.set(token, (this.optionTrades.get(token) ?? 0) + 1);
  }

  onStreamStatus(s: StreamStatus) {
    this.streamSamples++;
    if (!s.connected) this.streamDown++;
    if (this.reconnectsStart == null && s.reconnects != null) this.reconnectsStart = s.reconnects;
    this.maxSubscribed = Math.max(this.maxSubscribed, s.subscribed ?? 0);
    this.lastStream = s;
  }

  openingRange(e: AscentEngine) {
    return e.or && {
      closes: e.or.closes.map((c) => [hhmm(c.label), c.close]),
      high: e.or.high, low: e.or.low, width: Math.round(e.or.width * 100) / 100,
      upsideBand: Math.round(e.or.upsideBand * 100) / 100, downsideBand: Math.round(e.or.downsideBand * 100) / 100,
    };
  }

  health(e: AscentEngine | null) {
    const bars = e?.index.bars ?? [];
    return {
      bars: bars.length, missing: bars.filter((b) => b.status === 'MISSING').map((b) => hhmm(b.label)),
      indexLag: lagOut(this.indexLag), tickStats: e ? { ...e.index.stats } : null,
      stream: this.lastStream, streamDownSamples: this.streamDown, streamSamples: this.streamSamples,
      reconnectsToday: this.lastStream?.reconnects != null && this.reconnectsStart != null ? this.lastStream.reconnects - this.reconnectsStart : null,
      maxSubscribed: this.maxSubscribed, state: e?.state ?? null,
    };
  }

  report(e: AscentEngine, wouldSelect: ContractSelection | null, adapterStats: unknown) {
    const perMinute = e.index.bars.map((b) => {
      const l = this.indexLagByMin.get(b.label);
      return [hhmm(b.label), b.close, b.ticks, b.status, l?.n ? Math.round(l.sum / l.n) : null, l?.n ? l.max : null];
    });
    const options = [...this.optionLag].map(([tok, l]) => {
      const sp = this.optionSpread.get(tok)!;
      const sym = e.instruments.find((i) => i.token === tok)?.tradingsymbol ?? String(tok);
      return { contract: sym, quotes: l.n, freshness: lagOut(l), spreadPct: sp.n ? { avg: Math.round((sp.sum / sp.n) * 1000) / 1000, max: Math.round(sp.max * 1000) / 1000 } : null, oneSidedQuotes: sp.oneSided, tradesByVolume: this.optionTrades.get(tok) ?? 0 };
    });
    const w = wouldSelect;
    return {
      kind: 'NIFTY_ASCENT_OBSERVATION', mode: 'OBSERVE_ONLY', date: e.date, configVersion: e.configVersion,
      previousSession: { date: e.prev.date, close1515: e.prevClose, bars: e.prevBarsCount },
      reference: e.reference && { price: e.reference.price, exchTs: new Date(e.reference.exchTs).toISOString(), recvLagMs: e.reference.recvTs - e.reference.exchTs },
      gap: e.gap && { points: e.gap.points, pct: Math.round(e.gap.pct * 10_000) / 10_000, direction: e.gap.direction },
      openingRange: this.openingRange(e),
      gapFill: e.gapFill && { exchTs: new Date(e.gapFill.exchTs).toISOString(), price: e.gapFill.price },
      gapAndGo: { signal: e.signal?.bot === 'GAP_AND_GO' ? { right: e.signal.right, bar: hhmm(e.signal.bar), close: e.signal.close, level: e.signal.level } : null, standDown: e.standDown && { reason: e.standDown.reason, bar: hhmm(e.standDown.bar), close: e.standDown.close } },
      williams: {
        levels: e.williams && { prevHighClose: e.williams.prevHighClose, prevLowClose: e.williams.prevLowClose, range: e.williams.range, ce: e.williams.ceLevel, pe: e.williams.peLevel },
        gapEligible: e.williamsEligible,
        handover: e.handover && { reason: e.handover.reason, bar: hhmm(e.handover.bar) },
        signal: e.signal?.bot === 'WILLIAMS' ? { right: e.signal.right, bar: hhmm(e.signal.bar), close: e.signal.close, level: e.signal.level } : null,
        windowEnds: hhmm(R.williamsLastBar),
      },
      wouldSelect: w ? (w.ok ? { tradingsymbol: w.instrument.tradingsymbol, strike: w.strike, expiry: w.expiry, itmPoints: w.itmPoints, lotSize: w.instrument.lotSize, expiryRolledProvisional: w.expiryRolled } : { rejected: w.code, detail: w.detail }) : null,
      outcome: e.outcome, finalState: e.state,
      dataQuality: { ...this.health(e), adapter: adapterStats, options },
      transitions: e.events.filter((x) => x.kind === 'TRANSITION').map((x) => [x.bar != null ? hhmm(x.bar) : null, x.from, x.to, x.trigger]),
      perMinute: { columns: ['bar', 'close', 'ticks', 'status', 'avgLagMs', 'maxLagMs'], rows: perMinute },
    };
  }
}
