/**
 * NIFTY ASCENT live market-data integration — Phase 3: OBSERVE ONLY.
 *
 * Feeds the same AscentEngine used by replay from ThetaLab's EXISTING shared
 * Kite stream (observer via onQuote; no new connection) plus Kite historical
 * data for the previous session and the options instrument master.
 * The engine is created PAUSED and this service has no way to start it:
 * signals are computed and recorded, entries are always refused
 * (`entries_disabled`). Live paper execution is Phase 4 and needs approval.
 */
import { AscentEngine, type AuditEvent, type PrevSession } from '../core/engine.ts';
import { validateInstruments, selectContract, type Instrument, type InstrumentReport, type ContractSelection } from '../core/contracts.ts';
import { DEFAULT_EXECUTION, RESEARCH_RULES_V1, istDateOf, type ExecutionSettings } from '../core/rules.ts';
import { QuoteAdapter, NIFTY_INDEX_TOKEN, type StreamQuote } from './adapter.ts';
import { loadPrevSession, type FetchData, type PrevReport } from './history.ts';
import { ObservationRecorder, type StreamStatus } from './observation.ts';

export interface StreamPort {
  want(tokens: number[], ttlMs?: number): void;
  onQuote(fn: (q: StreamQuote, exchTs: number | null) => void): () => void;
  status(): unknown;
}
export interface InstrumentPort {
  /** The next `n` listed NIFTY option expiries on or after `today`. */
  nearestExpiries(today: string, n: number): Promise<string[]>;
  /** NIFTY NFO option rows for one expiry with strike in [lo, hi]. */
  strikes(expiry: string, lo: number, hi: number): Promise<Instrument[]>;
}
export interface LiveDeps {
  stream: StreamPort;
  fetchData: FetchData;
  instruments: InstrumentPort;
  isTradingDay: (date: string) => boolean;
  now?: () => number;
  log?: (msg: string) => void;
  exec?: ExecutionSettings;
  /** Receives the end-of-session observation report (e.g. writes it to disk). */
  saveReport?: (date: string, report: unknown) => void;
}

export const OBSERVE_ONLY = true;
const PREP_FROM_MIN = 8 * 60 + 50;
const ENGINE_DEADLINE_MIN = 9 * 60 + 14;
const STREAM_FROM_MIN = 9 * 60;
const STREAM_TO_MIN = 15 * 60 + 35;
const WANT_EVERY_MS = 30_000, WANT_TTL_MS = 120_000, PREP_RETRY_MS = 60_000;
const STRIKE_BAND = 2_500;
const minuteOf = (t: number) => { const d = new Date(t + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

interface Prep { prev: PrevSession | null; prevReport: PrevReport | null; instruments: Instrument[]; instrumentReport: InstrumentReport | null; errors: string[] }

export class LiveAscentService {
  readonly mode = 'OBSERVE' as const;
  private readonly d: LiveDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  readonly adapter = new QuoteAdapter(NIFTY_INDEX_TOKEN);
  engine: AscentEngine | null = null;
  date: string | null = null;
  prep: Prep | null = null;
  private preparing: Promise<void> | null = null;
  private lastPrepAttempt = 0;
  private lastWant = 0;
  private logged = 0;
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Contract the engine WOULD select for today's signal (observe only — nothing is bought). */
  wouldSelect: ContractSelection | null = null;
  observation: ObservationRecorder | null = null;
  private orLogged = false;
  private reported = false;
  private lastHealth = 0;

  constructor(deps: LiveDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.off = this.d.stream.onQuote((q, exchTs) => this.onQuote(q, exchTs));
    const loop = () => {
      if (!this.running) return;
      try { this.tick(this.now()); } catch (e) { this.log(`tick failed: ${(e as Error).message}`); }
      this.timer = setTimeout(loop, 1000 - (this.now() % 1000) + 50);
      (this.timer as any).unref?.();
    };
    loop();
  }
  stop() { this.running = false; this.off?.(); if (this.timer) clearTimeout(this.timer); }

  /** Phase 3 has no execution path: any attempt to start trading is refused. */
  control(action: string): never {
    throw new Error(`live paper execution is not enabled in Phase 3 (observe only) — "${action}" refused`);
  }

  onQuote(q: StreamQuote, exchTs: number | null) {
    const e = this.engine;
    if (!e) return;
    const wanted = new Set(e.wantedTokens());
    const ev = this.adapter.adapt(q, exchTs, (t) => wanted.has(t));
    if (ev.kind === 'INDEX') { e.onIndexTick(ev.tick); this.observation?.onIndexTick(ev.tick.exchTs, ev.tick.recvTs); }
    else if (ev.kind === 'OPTION') { e.onOptionTick(ev.tick); this.observation?.onOptionQuote(ev.tick.token, ev.tick.exchTs, ev.tick.recvTs, ev.tick.bid, ev.tick.ask, ev.tick.traded); }
    this.flushLog();
  }

  /** One second of the live clock. Public for deterministic tests. */
  tick(now: number) {
    const date = istDateOf(now), minute = minuteOf(now);
    if (date !== this.date) { this.date = date; this.engine = null; this.wouldSelect = null; this.observation = new ObservationRecorder(date); this.orLogged = false; this.reported = false; this.lastHealth = 0; this.prep = null; this.preparing = null; this.lastPrepAttempt = 0; this.logged = 0; }
    if (!this.d.isTradingDay(date)) return;
    if (minute < PREP_FROM_MIN) return;

    if (!this.engine && !this.preparing && (!this.prep || this.prep.errors.length) && now - this.lastPrepAttempt >= PREP_RETRY_MS) {
      this.lastPrepAttempt = now;
      this.preparing = this.prepare(date).finally(() => { this.preparing = null; });
    }
    const ready = this.prep && !this.prep.errors.length;
    if (!this.engine && (ready || minute >= ENGINE_DEADLINE_MIN)) this.createEngine(date);

    if (minute >= STREAM_FROM_MIN && minute <= STREAM_TO_MIN && now - this.lastWant >= WANT_EVERY_MS) {
      this.lastWant = now;
      this.d.stream.want([NIFTY_INDEX_TOKEN, ...(this.engine?.wantedTokens() ?? [])], WANT_TTL_MS);
    }
    if (this.engine) { this.engine.onClock(now); this.flushLog(); this.observe(now, minute); }
  }

  /** Observation logging: OR snapshot once final, health every 15 min, full report after the close. */
  private observe(now: number, minute: number) {
    const e = this.engine!, o = this.observation!;
    if (minute >= STREAM_FROM_MIN && minute <= STREAM_TO_MIN && now - this.lastHealth >= 60_000) {
      o.onStreamStatus(this.d.stream.status() as StreamStatus);
      if (this.lastHealth === 0 || minute % 15 === 0) this.log(`OBSERVATION health ${JSON.stringify(o.health(e))}`);
      this.lastHealth = now;
    }
    if (!this.orLogged && e.or) { this.orLogged = true; this.log(`OBSERVATION opening_range ${JSON.stringify(o.openingRange(e))}`); }
    if (!this.reported && minute >= 15 * 60 + 31) {
      this.reported = true;
      const report = o.report(e, this.wouldSelect, { ...this.adapter.stats });
      this.log(`OBSERVATION report ${JSON.stringify(report)}`);
      try { this.d.saveReport?.(e.date, report); } catch (err) { this.log(`report save failed: ${(err as Error).message}`); }
    }
  }

  /** Previous session + instrument master. Retries every minute until 09:14. */
  async prepare(date: string): Promise<void> {
    const p: Prep = { prev: null, prevReport: null, instruments: [], instrumentReport: null, errors: [] };
    try {
      const { prev, report } = await loadPrevSession(date, this.d.fetchData, this.d.isTradingDay);
      p.prev = prev; p.prevReport = report;
      if (report.error) p.errors.push(report.error);
    } catch (e) { p.errors.push(`previous session: ${(e as Error).message}`); }
    try {
      const expiries = await this.d.instruments.nearestExpiries(date, 3);
      const mid = p.prevReport?.close1515 ?? null;
      if (!expiries.length) p.errors.push('instrument master: no NIFTY expiries on or after today');
      else if (mid == null) p.errors.push('instrument master: waiting for the previous close to centre the strike band');
      else {
        const rows = (await Promise.all(expiries.map((x) => this.d.instruments.strikes(x, mid - STRIKE_BAND, mid + STRIKE_BAND)))).flat();
        const { valid, report } = validateInstruments(rows, date);
        p.instruments = valid; p.instrumentReport = report;
        if (!valid.length) p.errors.push('instrument master: no valid NIFTY option rows');
      }
    } catch (e) { p.errors.push(`instrument master: ${(e as Error).message}`); }
    if (this.date === date && !this.engine) this.prep = p;
    this.log(p.errors.length ? `prepare ${date}: ${p.errors.join('; ')}` : `prepare ${date}: previous session ${p.prevReport!.date} (${p.prevReport!.bars} bars, 15:15 close ${p.prevReport!.close1515}), ${p.instruments.length} contracts`);
  }

  private createEngine(date: string) {
    const prev = this.prep?.prev && this.prep.prev.bars.length ? this.prep.prev : { date: this.prep?.prevReport?.date ?? 'unavailable', bars: [] };
    this.engine = new AscentEngine({
      date, prev, instruments: this.prep?.instruments ?? [], rules: RESEARCH_RULES_V1,
      exec: this.d.exec ?? DEFAULT_EXECUTION,
      startRunning: false, // OBSERVE ONLY — never started in Phase 3
    });
    this.log(`engine for ${date} created PAUSED (observe only)${this.engine.state === 'DATA_ERROR' ? ` — ${this.engine.outcome?.detail}` : ''}`);
  }

  private flushLog() {
    const e = this.engine;
    if (!e) return;
    if (e.signal && !this.wouldSelect) {
      this.wouldSelect = selectContract(e.instruments, e.date, e.signal.right, e.signal.close, e.rules);
      const w = this.wouldSelect;
      this.log(`observe-only signal ${e.signal.bot} ${e.signal.right} at close ${e.signal.close}: would select ${w.ok ? `${w.instrument.tradingsymbol} (strike ${w.strike}, ${w.itmPoints} pts ITM, expiry ${w.expiry}${w.expiryRolled ? ', PROVISIONAL expiry-day roll' : ''}, lot ${w.instrument.lotSize})` : `nothing — ${w.code}: ${w.detail}`} — no order, no paper fill`);
    }
    for (; this.logged < e.events.length; this.logged++) {
      const ev: AuditEvent = e.events[this.logged];
      if (ev.kind === 'TRANSITION' || ev.kind === 'RISK' || (ev.kind === 'DATA' && ev.trigger !== 'late_tick') || ev.trigger === 'gap_measured' || ev.trigger === 'gap_filled' || ev.trigger === 'opening_range_final') {
        this.log(`${ev.kind} ${ev.trigger}${ev.to ? ` → ${ev.to}` : ''}: ${ev.reason}`);
      }
    }
  }

  snapshot() {
    const e = this.engine;
    return {
      mode: this.mode, date: this.date,
      prep: this.prep ? { prev: this.prep.prevReport, instruments: this.prep.instrumentReport, errors: this.prep.errors } : null,
      stream: this.d.stream.status(),
      observation: this.engine && this.observation ? this.observation.health(this.engine) : null,
      adapter: { ...this.adapter.stats },
      bars: e ? { index: e.index.bars.length, missing: e.index.bars.filter((b) => b.status === 'MISSING').length, ...e.index.stats } : null,
      engine: e ? {
        state: e.state, engineStatus: e.engineStatus, outcome: e.outcome, reference: e.reference, gap: e.gap, gapFill: e.gapFill,
        or: e.or ? { high: e.or.high, low: e.or.low, width: e.or.width, upsideBand: e.or.upsideBand, downsideBand: e.or.downsideBand } : null,
        orCollected: e.orCollected, williams: e.williams, williamsEligible: e.williamsEligible, standDown: e.standDown, handover: e.handover,
        signal: e.signal, wouldSelect: this.wouldSelect, entryOrder: e.entryOrder ? { status: e.entryOrder.status, rejectReason: e.entryOrder.rejectReason } : null, configVersion: e.configVersion,
      } : null,
    };
  }
}
