/**
 * NIFTY ASCENT live service on ThetaLab's EXISTING shared Kite stream
 * (observer via onQuote; no new connection), Kite historical data for the
 * previous session and the options instrument master.
 *
 *   OBSERVE  the engine is created PAUSED and cannot be started; signals are
 *            recorded and entries refused (`entries_disabled`).
 *   PAPER    (Phase 4) the same engine with PAPER fills against real Kite
 *            bid/ask quotes — there is no order code anywhere. It still starts
 *            PAUSED every day; it only trades after START, or automatically
 *            when the owner has switched auto-start on. It needs the database
 *            (persistent session, journal, audit) and the single-engine lease;
 *            without either, new entries are blocked and any open paper
 *            position keeps being managed. Restarts resume from the stored
 *            snapshot (unobserved minutes count as missing data).
 */
import { AscentEngine, type AuditEvent, type PrevSession } from '../core/engine.ts';
import { validateInstruments, selectContract, type Instrument, type InstrumentReport, type ContractSelection } from '../core/contracts.ts';
import { DEFAULT_EXECUTION, RESEARCH_RULES_V1, istDateOf, type ExecutionSettings } from '../core/rules.ts';
import { QuoteAdapter, NIFTY_INDEX_TOKEN, type StreamQuote, type TradeMeta } from './adapter.ts';
import { loadPrevSession, type FetchData, type PrevReport } from './history.ts';
import { ObservationRecorder, type StreamStatus } from './observation.ts';
import { planPresubscription } from './presubscribe.ts';
import type { AscentStorePort, AscentControl } from './store.ts';

export interface StreamPort {
  want(tokens: number[], ttlMs?: number): void;
  onQuote(fn: (q: StreamQuote, exchTs: number | null, meta?: TradeMeta | null) => void): () => void;
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
  saveReport?: (date: string, report: unknown) => void | Promise<void>;
  /** Optional raw evidence sink: one row per accepted index/option quote (compact arrays, no credentials). */
  recordTick?: (row: unknown[], exchTs: number) => void;
  /** 'OBSERVE' (default) or 'PAPER'. PAPER requires `store`. */
  mode?: 'OBSERVE' | 'PAPER';
  store?: AscentStorePort;
  /** Unique id of this process for the single-engine lease. */
  holder?: string;
}

export type ControlAction = 'START' | 'STOP_ENTRIES' | 'KILL' | 'RELEASE';
export interface ControlResult { ok: boolean; message: string }
// Tuned for Supabase request volume (each request is logged against the plan's log-ingestion quota).
const LEASE_TTL_MS = 90_000, LEASE_EVERY_MS = 30_000, EVENTS_EVERY_MS = 15_000, SNAPSHOT_EVERY_MS = 300_000;

export const OBSERVE_ONLY = true;
const PREP_FROM_MIN = 8 * 60 + 50;
const ENGINE_DEADLINE_MIN = 9 * 60 + 14;
const STREAM_FROM_MIN = 9 * 60;
const STREAM_TO_MIN = 15 * 60 + 35;
const WANT_EVERY_MS = 30_000, WANT_TTL_MS = 180_000, PREP_RETRY_MS = 60_000;
const STRIKE_BAND = 2_500;
const minuteOf = (t: number) => { const d = new Date(t + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

interface Prep { prev: PrevSession | null; prevReport: PrevReport | null; instruments: Instrument[]; instrumentReport: InstrumentReport | null; errors: string[] }

export class LiveAscentService {
  readonly mode: 'OBSERVE' | 'PAPER';
  private readonly store: AscentStorePort | null;
  private readonly holder: string;
  leaseOk = false;
  private lastLease = 0;
  private leaseBusy = false;
  storeOk = true;
  control_: AscentControl = { autoStart: false, killSwitch: false };
  private creating: Promise<void> | null = null;
  private savedSeq = 0;
  private lastEventsSave = 0;
  private lastSnapSave = 0;
  private snapKey = '';
  private orderKeys = new Map<string, string>();
  private tradeSaved = false;
  private writing: Promise<void> = Promise.resolve();
  private blockedReason: string | null = null;
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
  /** Option contracts currently pre-subscribed (approved plan; max 8). */
  presubscribed: number[] = [];
  private presubKey = '';
  readonly subscriptionLog: Array<{ at: number; tokens: number[]; reason: string }> = [];
  private reported = false;
  private lastHealth = 0;

  constructor(deps: LiveDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.mode = deps.mode ?? 'OBSERVE';
    this.store = deps.store ?? null;
    if (this.mode === 'PAPER' && !this.store) throw new Error('PAPER mode requires the database store');
    this.holder = deps.holder ?? `ascent-${Math.random().toString(36).slice(2, 10)}`;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.off = this.d.stream.onQuote((q, exchTs, meta) => this.onQuote(q, exchTs, meta));
    const loop = () => {
      if (!this.running) return;
      try { this.tick(this.now()); } catch (e) { this.log(`tick failed: ${(e as Error).message}`); }
      this.timer = setTimeout(loop, 1000 - (this.now() % 1000) + 50);
      (this.timer as any).unref?.();
    };
    loop();
  }
  stop() { this.running = false; this.off?.(); if (this.timer) clearTimeout(this.timer); }

  /** Owner controls. OBSERVE mode refuses everything (LIVE PAPER — NOT ENABLED). */
  async control(action: ControlAction): Promise<ControlResult> {
    if (this.mode !== 'PAPER') return { ok: false, message: `LIVE PAPER — NOT ENABLED: the server is in observe mode; "${action}" refused` };
    const e = this.engine;
    if (action === 'KILL') {
      await this.store!.saveControl({ killSwitch: true }).catch(() => {});
      this.control_.killSwitch = true;
      if (e) e.control('KILL', this.now());
      this.persistSoon();
      return { ok: true, message: 'kill switch ON — entries blocked; any open paper position is being closed at the first fresh bid' };
    }
    if (action === 'RELEASE') {
      await this.store!.saveControl({ killSwitch: false });
      this.control_.killSwitch = false;
      if (e) e.control('RELEASE', this.now());
      this.persistSoon();
      return { ok: true, message: 'kill switch released — engine stays stopped until START' };
    }
    if (!e) return { ok: false, message: 'no engine for today yet (created from 08:50 on trading days)' };
    if (action === 'STOP_ENTRIES') { e.control('STOP_ENTRIES', this.now()); this.persistSoon(); return { ok: true, message: 'new entries stopped; an open paper position keeps being managed' }; }
    const why = this.startBlocker();
    if (why) return { ok: false, message: `START refused: ${why}` };
    e.control('START', this.now());
    this.persistSoon();
    return { ok: e.engineStatus === 'RUNNING', message: e.engineStatus === 'RUNNING' ? 'paper engine RUNNING' : `engine is ${e.engineStatus}` };
  }

  /** Owner's approval switch: START the PAUSED engine automatically each trading day. */
  async setAutoStart(enabled: boolean): Promise<ControlResult> {
    if (this.mode !== 'PAPER') return { ok: false, message: 'LIVE PAPER — NOT ENABLED: the server is in observe mode' };
    await this.store!.saveControl({ autoStart: enabled });
    this.control_.autoStart = enabled;
    this.log(`auto-start ${enabled ? 'ON' : 'OFF'}`);
    if (enabled && this.engine && this.engine.engineStatus === 'PAUSED' && !this.startBlocker()) { this.engine.control('START', this.now()); this.persistSoon(); }
    return { ok: true, message: `auto-start ${enabled ? 'ON' : 'OFF'}` };
  }

  private startBlocker(): string | null {
    if (this.mode !== 'PAPER') return 'observe mode';
    if (this.control_.killSwitch) return 'kill switch is on';
    if (!this.leaseOk) return 'this server does not hold the single-engine lease';
    if (!this.storeOk) return `database unavailable (${this.store!.status().lastError ?? 'error'})`;
    return null;
  }

  onQuote(q: StreamQuote, exchTs: number | null, meta?: TradeMeta | null) {
    const e = this.engine;
    if (!e) return;
    const wanted = new Set([...e.wantedTokens(), ...this.presubscribed]);
    const ev = this.adapter.adapt(q, exchTs, (t) => wanted.has(t), meta);
    if (ev.kind === 'INDEX') {
      e.onIndexTick(ev.tick); this.observation?.onIndexTick(ev.tick.exchTs, ev.tick.recvTs);
      this.d.recordTick?.(['I', q.token, ev.tick.exchTs, ev.tick.recvTs, ev.tick.price], ev.tick.exchTs);
    } else if (ev.kind === 'OPTION') {
      e.onOptionTick(ev.tick); this.observation?.onOptionQuote(ev.tick.token, ev.tick.exchTs, ev.tick.recvTs, ev.tick.bid, ev.tick.ask, ev.tick.traded);
      this.d.recordTick?.(['O', q.token, ev.tick.exchTs, ev.tick.recvTs, q.ltp, q.bid, q.ask, q.volume, meta?.lastTradeTs ?? null, meta?.lastTradedQty ?? null, ev.tick.traded ? 1 : 0], ev.tick.exchTs);
    }
    this.flushLog();
  }

  /** One second of the live clock. Public for deterministic tests. */
  tick(now: number) {
    const date = istDateOf(now), minute = minuteOf(now);
    if (date !== this.date) { this.date = date; this.engine = null; this.wouldSelect = null; this.presubscribed = []; this.presubKey = ''; this.observation = new ObservationRecorder(date); this.orLogged = false; this.reported = false; this.lastHealth = 0; this.prep = null; this.preparing = null; this.lastPrepAttempt = 0; this.logged = 0; }
    if (!this.d.isTradingDay(date)) return;
    if (minute < PREP_FROM_MIN) return;

    if (!this.engine && !this.preparing && (!this.prep || this.prep.errors.length) && now - this.lastPrepAttempt >= PREP_RETRY_MS) {
      this.lastPrepAttempt = now;
      this.preparing = this.prepare(date).finally(() => { this.preparing = null; });
    }
    if (this.mode === 'PAPER') this.renewLease(now);
    const ready = this.prep && !this.prep.errors.length;
    // After the 09:14 deadline the engine is created even if preparation failed — but never before
    // the first preparation attempt has finished (a mid-session restart must load the previous session first).
    if (!this.engine && !this.creating && (ready || (minute >= ENGINE_DEADLINE_MIN && this.prep && !this.preparing))) {
      if (this.mode === 'PAPER') this.creating = this.createPaperEngine(date, now).catch((err) => { this.log(`engine creation failed: ${(err as Error).message}`); }).finally(() => { this.creating = null; });
      else this.createEngine(date);
    }

    if (this.engine) this.updatePresubscription(now);
    if (minute >= STREAM_FROM_MIN && minute <= STREAM_TO_MIN && now - this.lastWant >= WANT_EVERY_MS) {
      this.lastWant = now;
      // Index + the engine's own contracts + pre-subscribed options, refreshed every 30 s with a 180 s expiry.
      // Contracts no longer listed are simply not re-requested and the shared stream releases them on expiry.
      this.d.stream.want([NIFTY_INDEX_TOKEN, ...new Set([...(this.engine?.wantedTokens() ?? []), ...this.presubscribed])], WANT_TTL_MS);
    }
    if (this.engine) {
      this.engine.onClock(now); this.flushLog(); this.observe(now, minute);
      if (this.mode === 'PAPER') { this.enforceSafety(); this.persist(now); }
    }
  }

  /* ---------------- PAPER mode: lease, safety, persistence ---------------- */

  private renewLease(now: number) {
    if (this.leaseBusy || now - this.lastLease < LEASE_EVERY_MS) return;
    this.leaseBusy = true; this.lastLease = now;
    this.store!.acquireLease(this.holder, LEASE_TTL_MS, now)
      .then((ok) => { if (ok !== this.leaseOk) this.log(ok ? 'single-engine lease acquired' : 'single-engine lease held by another instance — entries blocked'); this.leaseOk = ok; })
      .catch((err) => { if (this.leaseOk) this.log(`lease renewal failed: ${(err as Error).message}`); this.leaseOk = false; })
      .finally(() => { this.leaseBusy = false; });
  }

  /** No lease or no database ⇒ no new entries (an open position keeps being managed). */
  private enforceSafety() {
    const e = this.engine!;
    const why = !this.leaseOk ? 'single-engine lease not held' : !this.storeOk ? 'database unavailable' : null;
    if (why && e.engineStatus === 'RUNNING') {
      e.control('STOP_ENTRIES', this.now());
      this.log(`RISK new entries stopped: ${why}`);
    }
    this.blockedReason = why;
  }

  private async createPaperEngine(date: string, now: number) {
    try { this.control_ = await this.store!.loadControl(); this.storeOk = true; } catch (err) { this.storeOk = false; this.log(`control load failed: ${(err as Error).message}`); }
    const opts = this.engineOptions(date);
    let snap = null;
    try { snap = await this.store!.loadSession(date); } catch (err) { this.storeOk = false; this.log(`session load failed: ${(err as Error).message}`); }
    if (this.engine || this.date !== date) return;
    if (snap) {
      try {
        this.engine = AscentEngine.restore(opts, snap, now);
        this.savedSeq = snap.seq; this.tradeSaved = !!snap.trade;
        this.log(`engine for ${date} RESTORED from the database in state ${this.engine.state} (${this.engine.engineStatus})`);
      } catch (err) { this.log(`snapshot not restorable (${(err as Error).message}) — fresh PAUSED engine`); }
    }
    if (!this.engine) {
      this.engine = new AscentEngine(opts);
      this.log(`engine for ${date} created PAUSED (live paper mode)${this.engine.state === 'DATA_ERROR' ? ` — ${this.engine.outcome?.detail}` : ''}`);
    }
    if (this.control_.killSwitch) this.engine.control('KILL', now);
    else if (this.control_.autoStart && this.engine.engineStatus === 'PAUSED' && !this.startBlocker()) { this.engine.control('START', now); this.log('auto-start: paper engine RUNNING'); }
    else if (this.control_.autoStart && this.startBlocker()) this.log(`auto-start deferred: ${this.startBlocker()}`);
    this.persistSoon();
  }

  /** Auto-start can be deferred until the lease is first acquired. */
  private autoStartIfDue() {
    const e = this.engine;
    if (e && this.control_.autoStart && e.engineStatus === 'PAUSED' && !this.startBlocker() && !e.outcome && e.positionsToday === 0) { e.control('START', this.now()); this.log('auto-start: paper engine RUNNING'); }
  }

  private persistSoon() { this.lastSnapSave = 0; this.lastEventsSave = 0; }

  private enqueue(label: string, fn: () => Promise<void>) {
    this.writing = this.writing.then(fn).then(() => { if (!this.storeOk) this.log('database writes recovered'); this.storeOk = true; }).catch((err) => {
      if (this.storeOk) this.log(`RISK database write failed (${label}): ${(err as Error).message} — new entries blocked until it recovers`);
      this.storeOk = false;
    });
  }

  private persist(now: number) {
    const e = this.engine!, date = e.date;
    this.autoStartIfDue();
    const newEvents = e.events.filter((x) => x.seq > this.savedSeq);
    if (newEvents.length && now - this.lastEventsSave >= EVENTS_EVERY_MS) {
      this.lastEventsSave = now;
      const last = newEvents[newEvents.length - 1].seq;
      this.enqueue('events', async () => { await this.store!.saveEvents(date, newEvents); this.savedSeq = Math.max(this.savedSeq, last); });
    }
    for (const o of [e.entryOrder, e.exitOrder]) {
      if (!o) continue;
      const k = JSON.stringify([o.status, o.fill?.price ?? null, o.late, o.rejectReason ?? null]);
      if (this.orderKeys.get(o.purpose) === k) continue;
      this.orderKeys.set(o.purpose, k);
      const sym = e.instruments.find((i) => i.token === o.token)?.tradingsymbol ?? null;
      const copy = JSON.parse(JSON.stringify(o));
      this.enqueue(`order ${o.purpose}`, () => this.store!.saveOrder(date, copy, sym));
    }
    if (e.trade && !this.tradeSaved) {
      this.tradeSaved = true;
      const t = JSON.parse(JSON.stringify(e.trade));
      this.enqueue('trade', () => this.store!.saveTrade(t));
    }
    const key = JSON.stringify([e.state, e.engineStatus, e.killed, e.positionsToday, e.position?.highest ?? null, e.position?.trailActive ?? null, e.entryOrder?.status ?? null, e.exitOrder?.status ?? null, e.index.nextLabel]);
    if (key !== this.snapKey || now - this.lastSnapSave >= SNAPSHOT_EVERY_MS) {
      if (key !== this.snapKey || now - this.lastSnapSave >= SNAPSHOT_EVERY_MS) { this.snapKey = key; this.lastSnapSave = now; }
      const snap = e.serialize();
      this.enqueue('session', () => this.store!.saveSession(date, 'LIVE_PAPER', snap));
    }
  }

  /** Waits for queued database writes (tests / shutdown). */
  flushWrites() { return this.writing; }

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
      const report = o.report(e, this.wouldSelect, { ...this.adapter.stats }, {
        totals: { ...this.adapter.detection },
        byContract: [...this.adapter.detectionByToken].map(([tok, d]) => ({ contract: e.instruments.find((i) => i.token === tok)?.tradingsymbol ?? String(tok), ...d })),
      }, this.subscriptionLog.map((x) => ({ at: new Date(x.at).toISOString(), contracts: x.tokens.map((t) => e.instruments.find((i) => i.token === t)?.tradingsymbol ?? String(t)), reason: x.reason })), this.mode === 'PAPER' ? 'LIVE_PAPER' : 'OBSERVE_ONLY');
      this.log(`OBSERVATION report ${JSON.stringify(report)}`);
      Promise.resolve().then(() => this.d.saveReport?.(e.date, report)).catch((err) => this.log(`report save failed: ${(err as Error).message}`));
    }
  }

  /** Recompute the pre-subscription set; log and request immediately when it changes. */
  private updatePresubscription(now: number) {
    const e = this.engine!;
    const f = e.index.formingBar();
    const last = f?.close ?? [...e.index.bars].reverse().find((b) => b.close != null)?.close ?? null;
    const plan = planPresubscription(e, last);
    const tokens = plan.contracts.map((c) => c.token);
    const key = tokens.join(',');
    if (key === this.presubKey) return;
    this.presubKey = key;
    this.presubscribed = tokens;
    this.subscriptionLog.push({ at: now, tokens, reason: plan.reason });
    this.log(`pre-subscription ${tokens.length ? `→ ${plan.reason}` : `released (${plan.reason})`}`);
    if (tokens.length) { this.d.stream.want(tokens, WANT_TTL_MS); this.lastWant = 0; }
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

  private engineOptions(date: string) {
    const prev = this.prep?.prev && this.prep.prev.bars.length ? this.prep.prev : { date: this.prep?.prevReport?.date ?? 'unavailable', bars: [] };
    return { date, prev, instruments: this.prep?.instruments ?? [], rules: RESEARCH_RULES_V1, exec: this.d.exec ?? DEFAULT_EXECUTION, startRunning: false };
  }

  private createEngine(date: string) {
    this.engine = new AscentEngine(this.engineOptions(date)); // OBSERVE: PAUSED and never started
    this.log(`engine for ${date} created PAUSED (observe only)${this.engine.state === 'DATA_ERROR' ? ` — ${this.engine.outcome?.detail}` : ''}`);
  }

  private flushLog() {
    const e = this.engine;
    if (!e) return;
    if (e.signal && !this.wouldSelect) {
      this.wouldSelect = selectContract(e.instruments, e.date, e.signal.right, e.signal.close, e.rules);
      const w = this.wouldSelect;
      if (this.mode === 'PAPER' && e.engineStatus === 'RUNNING') { /* the engine itself selects and logs the contract */ } else
      this.log(`observe-only signal ${e.signal.bot} ${e.signal.right} at close ${e.signal.close}: would select ${w.ok ? `${w.instrument.tradingsymbol} (strike ${w.strike}, ${w.itmPoints} pts ITM, expiry ${w.expiry}${w.expiryRolled ? ', PROVISIONAL expiry-day roll' : ''}, lot ${w.instrument.lotSize})` : `nothing — ${w.code}: ${w.detail}`} — no order, no paper fill`);
    }
    // Missed minutes arrive in a burst after a late start or an outage: log them as one summary line.
    const missing = e.events.slice(this.logged).filter((x) => x.trigger === 'missing_bar');
    if (missing.length > 3) {
      const lab = (b: number | null) => (b == null ? '?' : `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`);
      this.log(`DATA missing_bar: ${missing.length} minutes without a valid NIFTY tick (${lab(missing[0].bar)}–${lab(missing[missing.length - 1].bar)})`);
    }
    for (; this.logged < e.events.length; this.logged++) {
      const ev: AuditEvent = e.events[this.logged];
      if (missing.length > 3 && ev.trigger === 'missing_bar') continue;
      if (ev.kind === 'TRANSITION' || ev.kind === 'RISK' || (ev.kind === 'DATA' && ev.trigger !== 'late_tick') || ev.trigger === 'gap_measured' || ev.trigger === 'gap_filled' || ev.trigger === 'opening_range_final') {
        this.log(`${ev.kind} ${ev.trigger}${ev.to ? ` → ${ev.to}` : ''}: ${ev.reason}`);
      }
    }
  }

  snapshot() {
    const e = this.engine;
    return {
      mode: this.mode, date: this.date,
      paper: this.mode === 'PAPER' ? { leaseOk: this.leaseOk, storeOk: this.storeOk, store: this.store!.status(), autoStart: this.control_.autoStart, killSwitch: this.control_.killSwitch, blockedReason: this.blockedReason } : null,
      prep: this.prep ? { prev: this.prep.prevReport, instruments: this.prep.instrumentReport, errors: this.prep.errors } : null,
      stream: this.d.stream.status(),
      observation: this.engine && this.observation ? this.observation.health(this.engine) : null,
      presubscribed: this.presubscribed.map((t) => this.engine?.instruments.find((i) => i.token === t)?.tradingsymbol ?? t),
      tradeDetection: { ...this.adapter.detection },
      adapter: { ...this.adapter.stats },
      bars: e ? { index: e.index.bars.length, missing: e.index.bars.filter((b) => b.status === 'MISSING').length, ...e.index.stats } : null,
      engine: e ? {
        state: e.state, engineStatus: e.engineStatus, outcome: e.outcome, reference: e.reference, gap: e.gap, gapFill: e.gapFill,
        or: e.or ? { high: e.or.high, low: e.or.low, width: e.or.width, upsideBand: e.or.upsideBand, downsideBand: e.or.downsideBand } : null,
        orCollected: e.orCollected, williams: e.williams, williamsEligible: e.williamsEligible, standDown: e.standDown, handover: e.handover,
        signal: e.signal, wouldSelect: this.wouldSelect, entryOrder: e.entryOrder ? { status: e.entryOrder.status, rejectReason: e.entryOrder.rejectReason } : null, configVersion: e.configVersion,
        positionsToday: e.positionsToday, trade: e.trade,
      } : null,
    };
  }
}
