/**
 * NIFTY PULSE live paper service.
 *
 * Feeds real NIFTY index ticks from the EXISTING shared Kite stream into the
 * same deterministic PulseEngine the replay uses, once per second. Every fill
 * is a PAPER fill: this file has no broker, order or network code. All I/O is
 * injected (stream, instrument lookup, clock, recorder, store), so the service
 * is fully testable offline.
 *
 * Safety:
 *   • The engine starts OFF every trading day; only an explicit start enables
 *     new paper entries.
 *   • Signals are suspended whenever index data is stale (sampler), and paper
 *     fills need fresh two-sided option quotes (spreads/paperBroker).
 */
import { PRESETS, DEFAULT_PRESET_ID, validateConfig, type PulseConfig } from '../core/config.ts';
import { PulseEngine, istMinute, SESSION_OPEN_MIN, SESSION_CLOSE_MIN, type TimelineEvent, type RiskDecisionRecord } from '../core/engine.ts';
import type { Tick, Sample } from '../core/sampler.ts';
import type { ChainSnapshot } from '../core/chain.ts';
import { atmStrike } from '../core/chain.ts';
import { buildLiveChain, chainToWire, NIFTY_STRIKE_STEP, type ChainMeta, type ChainWire, type InstrumentRow, type StreamQuote } from './liveChain.ts';

export const NIFTY_INDEX_TOKEN = 256265;
/** Strikes either side of ATM kept subscribed (covers 3 OTM + 4 wide, plus drift). */
export const STRIKE_WINDOW_STEPS = 10;
const WANT_EVERY_MS = 30_000;
const WANT_TTL_MS = 120_000;
const INSTRUMENTS_EVERY_MS = 60_000;
/** Re-centre the subscribed strikes when spot drifts this many steps from the centre. */
const RECENTER_STEPS = 3;
/** Start wanting prices a little before the open so the stream is connected at 09:15. */
const WARMUP_MIN = 9 * 60 + 10;
const MAX_PENDING_TICKS = 5_000;

export interface StreamPort {
  want(tokens: number[], ttlMs?: number): void;
  get(token: number): StreamQuote | null;
  onQuote(fn: (q: StreamQuote, exchTs: number | null) => void): () => void;
  isHealthy(): boolean;
  status(): { connected: boolean; subscribed: number; wanted: number; lastMessageAgoMs: number | null; reconnects: number; lastError: string | null };
}

export interface InstrumentPort {
  /** Nearest NIFTY option expiry on/after `todayIst` (or strictly after when `skipToday`). */
  nearestExpiry(todayIst: string, skipToday: boolean): Promise<string | null>;
  strikes(expiry: string, lo: number, hi: number): Promise<InstrumentRow[]>;
}

export interface RecorderPort {
  /** Called for every quote on a token this service watches. Must never throw. */
  record(q: StreamQuote, exchTs: number | null, kind: 'INDEX' | 'OPTION'): void;
  status(): unknown;
}

/** Durable state (Phase 4). All methods are best-effort and must never throw into the engine. */
export interface StorePort {
  loadControl(): Promise<{ configId: string | null; config: PulseConfig | null } | null>;
  saveControl(c: { configId: string; config: PulseConfig; running: boolean; killSwitch: boolean; at: number }): Promise<void>;
  saveTrade(t: unknown): Promise<void>;
  saveEvents(events: TimelineEvent[]): Promise<void>;
  status(): unknown;
}

export interface ServiceDeps {
  stream: StreamPort;
  instruments: InstrumentPort;
  isTradingDay: (dateIst: string) => boolean;
  now?: () => number;
  recorder?: RecorderPort | null;
  store?: StorePort | null;
  log?: (msg: string) => void;
  /** Allow trading the expiry that settles today (default false: roll to the next expiry). */
  allowExpiryDay?: boolean;
}

export function istDate(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

export type ControlAction = 'start' | 'stop' | 'kill' | 'release' | 'flatten';

const STATUS_CODE: Record<Sample['status'], number> = { FRESH: 0, HELD: 1, STALE: 2, NO_DATA: 3 };
/** [t, price, statusCode, ticks, ageMs, exchTs] */
export type SampleWire = [number, number | null, number, number, number | null, number | null];

export function sampleToWire(s: Sample): SampleWire {
  return [s.t, s.price, STATUS_CODE[s.status], s.ticks, s.ageMs, s.exchTs];
}

export interface SnapshotCursor {
  /** Last sample boundary the client has (ms). */
  s?: number;
  /** Last timeline seq the client has. */
  e?: number;
  /** Last decision time the client has. */
  d?: number;
  /** Number of closed trades the client has. */
  tc?: number;
  /** lastCandidatesAt the client has. */
  c?: number;
  /** Engine session id the client has (a new day resets everything). */
  sid?: string;
}

export class LivePulseService {
  readonly deps: ServiceDeps;
  engine: PulseEngine;
  sessionDay: string;
  sessionId: string;
  private configId: string;
  private pending: Tick[] = [];
  private meta: ChainMeta | null = null;
  private centre: number | null = null;
  private watched = new Set<number>();
  private lastWantAt = 0;
  private lastInstrumentsAt = 0;
  private instrumentsBusy = false;
  private instrumentsError: string | null = null;
  private lastChain: ChainSnapshot | null = null;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stepping = false;
  private savedTrades = 0;
  private savedSeq = 0;
  private lastStepAt: number | null = null;
  private stepErrors = 0;
  private lastStepError: string | null = null;
  private restored = false;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.configId = DEFAULT_PRESET_ID;
    const now = this.now();
    this.sessionDay = istDate(now);
    this.sessionId = `${this.sessionDay}#${now}`;
    this.engine = this.newEngine(PRESETS[0]);
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  private newEngine(config: PulseConfig): PulseEngine {
    return new PulseEngine(config, { dataMode: 'LIVE_PAPER', running: false });
  }

  /** Attach to the stream and run the 1-second loop. Idempotent. */
  start(): void {
    if (this.unsub) return;
    this.unsub = this.deps.stream.onQuote((q, exchTs) => this.onQuote(q, exchTs));
    void this.restore();
    const loop = () => {
      const now = this.now();
      this.timer = setTimeout(() => {
        const at = this.now();
        this.tick(Math.floor(at / 1000) * 1000).finally(loop);
      }, 1000 - (now % 1000) + 25);
      (this.timer as { unref?: () => void }).unref?.();
    };
    loop();
  }

  stopService(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async restore() {
    if (this.restored || !this.deps.store) return;
    this.restored = true;
    try {
      const c = await this.deps.store.loadControl();
      if (c?.config && c.config.paperOnly === true && !validateConfig(c.config).length && !this.engine.position) {
        this.configId = c.configId ?? c.config.id;
        this.engine.setConfig(c.config, this.now());
      }
    } catch (e) { this.deps.log?.(`restore failed: ${(e as Error).message}`); }
  }

  onQuote(q: StreamQuote, exchTs: number | null): void {
    if (q.token === NIFTY_INDEX_TOKEN) {
      if (this.pending.length < MAX_PENDING_TICKS) this.pending.push({ price: q.ltp, exchTs, recvTs: q.receivedAt });
      this.deps.recorder?.record(q, exchTs, 'INDEX');
    } else if (this.watched.has(q.token)) {
      this.deps.recorder?.record(q, exchTs, 'OPTION');
    }
  }

  /** One second of work. Public for tests (drive time explicitly). */
  async tick(boundaryMs: number): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const day = istDate(boundaryMs);
      if (day !== this.sessionDay) this.rollDay(day, boundaryMs);
      const minute = istMinute(boundaryMs);
      const tradingDay = this.deps.isTradingDay(day);
      const inWarmup = tradingDay && minute >= WARMUP_MIN && minute < SESSION_CLOSE_MIN + 1;
      if (inWarmup) {
        await this.maintainInstruments(boundaryMs);
        if (boundaryMs - this.lastWantAt >= WANT_EVERY_MS) {
          this.deps.stream.want([NIFTY_INDEX_TOKEN, ...this.watched], WANT_TTL_MS);
          this.lastWantAt = boundaryMs;
        }
      }
      const inSession = tradingDay && minute >= SESSION_OPEN_MIN && minute < SESSION_CLOSE_MIN;
      if (!inSession) { this.pending.length = 0; return; }

      const ticks: Tick[] = [];
      const keep: Tick[] = [];
      for (const t of this.pending) (t.recvTs < boundaryMs ? ticks : keep).push(t);
      this.pending = keep;
      ticks.sort((a, b) => (a.exchTs ?? a.recvTs) - (b.exchTs ?? b.recvTs) || a.recvTs - b.recvTs);
      this.lastChain = null;
      this.engine.step(boundaryMs, ticks, () => this.chainAt(boundaryMs));
      this.lastStepAt = boundaryMs;
      this.persistNew(boundaryMs);
    } catch (e) {
      this.stepErrors++;
      this.lastStepError = (e as Error).message;
      this.deps.log?.(`step failed: ${this.lastStepError}`);
    } finally {
      this.stepping = false;
    }
  }

  private rollDay(day: string, at: number) {
    const cfg = this.engine.config;
    this.sessionDay = day;
    this.sessionId = `${day}#${at}`;
    this.engine = this.newEngine(cfg); // OFF by default every day
    this.pending.length = 0;
    this.savedTrades = 0;
    this.savedSeq = 0;
    this.lastChain = null;
  }

  private spot(): number | null {
    const s = this.engine.samples;
    for (let i = s.length - 1; i >= 0 && i >= s.length - 5; i--) if (s[i].valid && s[i].price != null) return s[i].price;
    const q = this.deps.stream.get(NIFTY_INDEX_TOKEN);
    return q?.ltp ?? null;
  }

  private chainAt(at: number): ChainSnapshot | null {
    if (this.lastChain?.at === at) return this.lastChain;
    const spot = this.spot();
    if (!this.meta || !this.meta.rows.length || spot == null) return null;
    this.lastChain = buildLiveChain(this.meta, spot, at, (t) => this.deps.stream.get(t));
    return this.lastChain;
  }

  /** Current chain for display (null before instruments/prices are known). */
  chain(): ChainSnapshot | null {
    return this.chainAt(this.lastStepAt ?? Math.floor(this.now() / 1000) * 1000);
  }

  private async maintainInstruments(at: number) {
    if (this.instrumentsBusy) return;
    const spot = this.spot();
    const drift = spot != null && this.centre != null ? Math.abs(spot - this.centre) / NIFTY_STRIKE_STEP : 0;
    const due = this.centre == null || at - this.lastInstrumentsAt >= INSTRUMENTS_EVERY_MS || drift >= RECENTER_STEPS;
    // Strikes are centred on spot, so wait for the first index price (the index token is wanted regardless).
    if (!due || spot == null) return;
    if (this.centre == null && at - this.lastInstrumentsAt < 5_000) return; // retry pace while unresolved
    this.instrumentsBusy = true;
    this.lastInstrumentsAt = at;
    // Fire and forget: the 1-second loop never waits on the database.
    void (async () => {
      try {
        const expiry = await this.deps.instruments.nearestExpiry(istDate(at), !this.deps.allowExpiryDay);
        if (!expiry) { this.instrumentsError = 'No NIFTY option expiry found in options_instruments'; return; }
        const centre = atmStrike(spot, NIFTY_STRIKE_STEP);
        const span = STRIKE_WINDOW_STEPS * NIFTY_STRIKE_STEP;
        const rows = (await this.deps.instruments.strikes(expiry, centre - span, centre + span)).filter((r) => r.strike % NIFTY_STRIKE_STEP === 0);
        if (!rows.length) { this.instrumentsError = `No NIFTY ${expiry} strikes near ${centre}`; return; }
        const lotSize = rows.find((r) => r.lotSize > 0)?.lotSize ?? 0;
        if (!(lotSize > 0)) { this.instrumentsError = 'Lot size missing in options_instruments'; return; }
        // An open position's legs stay subscribed even when spot moves away from them.
        const pos = this.engine.position;
        const keep = new Set(pos ? [pos.short.tradingsymbol, pos.long.tradingsymbol] : []);
        const prev = this.meta?.rows ?? [];
        const merged = [...rows, ...prev.filter((r) => keep.has(r.tradingsymbol) && !rows.some((x) => x.token === r.token))];
        this.meta = { expiry, lotSize, strikeStep: NIFTY_STRIKE_STEP, rows: merged };
        this.centre = centre;
        const next = new Set(merged.map((r) => r.token));
        const added = [...next].filter((t) => !this.watched.has(t));
        this.watched = next;
        if (added.length) this.deps.stream.want([NIFTY_INDEX_TOKEN, ...added], WANT_TTL_MS);
        this.instrumentsError = null;
      } catch (e) {
        this.instrumentsError = (e as Error).message;
      } finally {
        this.instrumentsBusy = false;
      }
    })();
  }

  /** Durable writes run on their own queue so a slow database never delays the 1-second loop. */
  private storeQueue: Promise<void> = Promise.resolve();
  private enqueue(fn: () => Promise<void>) {
    this.storeQueue = this.storeQueue.then(fn).catch((e) => { this.deps.log?.(`store write failed: ${(e as Error).message}`); });
  }

  private persistNew(at: number) {
    const store = this.deps.store;
    if (!store) return;
    const trades = this.engine.trades;
    const day = this.sessionDay;
    while (this.savedTrades < trades.length) {
      const t = trades[this.savedTrades++];
      this.enqueue(() => store.saveTrade({ ...t, sessionDay: day }));
    }
    // Timeline events are batched every 10 s (the per-second samples are never stored).
    if (at % 10_000 === 0) {
      const fresh = this.engine.timeline.filter((e) => e.seq > this.savedSeq);
      if (fresh.length) {
        this.savedSeq = fresh[fresh.length - 1].seq;
        this.enqueue(() => store.saveEvents(fresh.map((e) => ({ ...e, sessionDay: day }) as TimelineEvent)));
      }
    }
  }

  /** Resolves when queued durable writes have finished (tests, shutdown). */
  flushStore(): Promise<void> { return this.storeQueue; }

  // ── Controls ─────────────────────────────────────────────────────────
  control(action: ControlAction): { ok: boolean; message?: string } {
    const at = this.now();
    const e = this.engine;
    if (action === 'start') {
      if (e.killSwitch) return { ok: false, message: 'Release the kill switch first.' };
      e.start(at);
    } else if (action === 'stop') e.stop(at);
    else if (action === 'kill') e.setKillSwitch(true, at);
    else if (action === 'release') e.setKillSwitch(false, at);
    else if (action === 'flatten') { if (!e.position) return { ok: false, message: 'No open paper position.' }; e.flatten(at); }
    else return { ok: false, message: 'Unknown action.' };
    this.saveControl(at);
    return { ok: true };
  }

  /** Switch the active config. Only while flat, so every trade runs under one config. */
  setConfig(input: { configId?: string; config?: unknown }): { ok: boolean; message?: string } {
    let cfg: PulseConfig | undefined;
    if (input.config && typeof input.config === 'object') {
      const c = input.config as PulseConfig;
      const errs = validateConfig(c);
      if (c.paperOnly !== true) return { ok: false, message: 'Only paper-only configurations are accepted.' };
      if (errs.length) return { ok: false, message: errs.join('; ') };
      const root = PRESETS.find((p) => p.id === (c.parentId ?? c.id));
      if (!root) return { ok: false, message: 'Configuration must derive from a built-in preset.' };
      if (c.immutable && !PRESETS.some((p) => p.id === c.id && p.version === c.version)) return { ok: false, message: 'Unknown preset version.' };
      cfg = Object.freeze({ ...c, paperOnly: true as const, strategy: root.strategy });
    } else if (input.configId) {
      cfg = PRESETS.find((p) => p.id === input.configId);
      if (!cfg) return { ok: false, message: 'Unknown preset.' };
    }
    if (!cfg) return { ok: false, message: 'No configuration given.' };
    const at = this.now();
    if (!this.engine.setConfig(cfg, at)) return { ok: false, message: 'Close the open paper position before switching configuration.' };
    this.configId = cfg.immutable ? cfg.id : `${cfg.id}@${cfg.version}`;
    this.saveControl(at);
    return { ok: true };
  }

  private saveControl(at: number) {
    const store = this.deps.store;
    if (!store) return;
    const c = { configId: this.configId, config: this.engine.config, running: this.engine.running, killSwitch: this.engine.killSwitch, at };
    this.enqueue(() => store.saveControl(c));
  }

  // ── Snapshot for the browser ─────────────────────────────────────────
  snapshot(cur: SnapshotCursor = {}) {
    const e = this.engine;
    const now = this.now();
    const sameSession = cur.sid === this.sessionId;
    const sinceS = sameSession ? cur.s ?? -1 : -1;
    const sinceE = sameSession ? cur.e ?? 0 : 0;
    const sinceD = sameSession ? cur.d ?? -1 : -1;
    const samples: SampleWire[] = [];
    for (let i = e.samples.length - 1; i >= 0 && e.samples[i].t > sinceS; i--) samples.push(sampleToWire(e.samples[i]));
    samples.reverse();
    const timeline: TimelineEvent[] = [];
    for (let i = e.timeline.length - 1; i >= 0 && e.timeline[i].seq > sinceE; i--) timeline.push(e.timeline[i]);
    timeline.reverse();
    const decisions: RiskDecisionRecord[] = e.decisions.filter((d) => d.at > sinceD);
    const chain = this.chain();
    const day = istDate(now);
    const minute = istMinute(now);
    const tradingDay = this.deps.isTradingDay(day);
    return {
      mode: 'LIVE_PAPER' as const,
      sid: this.sessionId,
      reset: !sameSession,
      serverNow: now,
      sessionDay: this.sessionDay,
      market: { tradingDay, open: tradingDay && minute >= SESSION_OPEN_MIN && minute < SESSION_CLOSE_MIN, minute },
      feed: { ...this.deps.stream.status(), indexQuote: this.deps.stream.get(NIFTY_INDEX_TOKEN) ? true : false },
      instruments: { expiry: this.meta?.expiry ?? null, lotSize: this.meta?.lotSize ?? null, strikes: this.meta?.rows.length ?? 0, centre: this.centre, error: this.instrumentsError },
      loop: { lastStepAt: this.lastStepAt, stepErrors: this.stepErrors, lastStepError: this.lastStepError },
      recorder: this.deps.recorder?.status() ?? { enabled: false },
      store: this.deps.store?.status() ?? { enabled: false },
      configId: this.configId,
      engine: {
        config: e.config,
        running: e.running,
        killSwitch: e.killSwitch,
        now: e.now,
        indicators: e.indicators,
        signal: e.signal,
        episode: e.episode,
        position: e.position,
        trades: sameSession && cur.tc === e.trades.length ? null : e.trades,
        lastCandidates: sameSession && cur.c === e.lastCandidatesAt ? null : e.lastCandidates,
        lastCandidatesAt: e.lastCandidatesAt,
        lastRejection: e.lastRejection,
        lastExitAt: e.lastExitAt,
        realizedToday: e.realizedToday,
        validRun: e.validRun,
        latencies: e.latencies.slice(-60),
        stats: e.stats,
        samples,
        timeline,
        decisions,
      },
      chain: chain && this.meta ? (chainToWire(chain, this.meta.rows) as ChainWire) : null,
    };
  }
}
