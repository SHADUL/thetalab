/**
 * NIFTY PULSE engine pipeline — one evaluation per second:
 *
 *   ticks → sampler → indicators → signal → (position exits)
 *         → entry gating → spread selection → risk engine → paper broker
 *
 * Pure and deterministic: no clock, no network, no randomness. The caller
 * supplies each second's boundary time, the ticks received during it and a
 * lazy option-chain snapshot. The same inputs + config always produce the
 * same decisions, which is what the replay harness and tests rely on.
 *
 * The browser replay (Phase 2) and the server worker (Phase 3+) drive this
 * same class; only the data source differs.
 *
 * Duplicate-signal prevention: one entry attempt per signal episode. A new
 * attempt needs the signal to drop back to NEUTRAL (or flip) first.
 */
import type { PulseConfig } from './config.ts';
import { configKey } from './config.ts';
import { OneSecondSampler, type Sample, type Tick } from './sampler.ts';
import { computeIndicators, requiredSamples, type Indicators } from './indicators.ts';
import { evaluateSignal, type Direction, type SignalResult } from './signal.ts';
import type { ChainSnapshot } from './chain.ts';
import { buildCandidates, type SpreadCandidate } from './spreads.ts';
import { preTradeChecks, selectApproved, type RiskDecision, type RiskState } from './risk.ts';
import { openPaperPosition, stepPosition, type ExitReason, type PaperPosition } from './paperBroker.ts';

export type DataMode = 'LIVE_PAPER' | 'SIMULATION';

export type TimelineKind = 'SIGNAL' | 'SELECTION' | 'REJECT' | 'ENTRY' | 'EXIT' | 'PENDING' | 'EXPIRED' | 'ENGINE' | 'DATA' | 'RISK';

export interface TimelineEvent {
  seq: number;
  at: number;
  kind: TimelineKind;
  title: string;
  detail?: string;
  direction?: Direction;
  tradeId?: string;
}

export interface RiskDecisionRecord extends RiskDecision {
  at: number;
  candidateId: string | null;
  direction: Direction;
}

export interface SignalEpisode {
  direction: Direction;
  startedAt: number;
  attempted: boolean;
  outcome: 'PENDING' | 'ENTERED' | 'REJECTED' | 'BLOCKED';
  reason: string | null;
}

export interface EngineStats {
  episodes: number;
  bullishEpisodes: number;
  bearishEpisodes: number;
  attempts: number;
  entries: number;
  rejections: number;
  rejectionReasons: Record<string, number>;
  ticksAccepted: number;
  ticksDropped: number;
  staleSeconds: number;
  freshSeconds: number;
  heldSeconds: number;
  feedGaps: number;
}

/** IST minute-of-day for an epoch ms. */
export function istMinute(ms: number): number {
  const d = new Date(ms + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
/** No new entries after this (leaves room for the 120 s hold). */
export const ENTRY_CUTOFF_MIN = 15 * 60 + 25;
/** Open paper positions are force-closed from here. */
export const SESSION_EXIT_MIN = 15 * 60 + 28;

const MAX_TIMELINE = 6_000;
const MAX_DECISIONS = 500;

export class PulseEngine {
  config: PulseConfig;
  readonly dataMode: DataMode;
  running: boolean;
  killSwitch = false;
  /** Every 1-second sample this session (chart + replay). */
  readonly samples: Sample[] = [];
  indicators: Indicators | null = null;
  signal: SignalResult | null = null;
  episode: SignalEpisode | null = null;
  position: PaperPosition | null = null;
  readonly trades: PaperPosition[] = [];
  readonly timeline: TimelineEvent[] = [];
  readonly decisions: RiskDecisionRecord[] = [];
  lastCandidates: SpreadCandidate[] = [];
  lastCandidatesAt: number | null = null;
  lastRejection: { at: number; reason: string } | null = null;
  lastExitAt: number | null = null;
  realizedToday = 0;
  validRun = 0;
  now = 0;
  /** Recent tick latencies (recv − exch), ms. */
  readonly latencies: number[] = [];
  readonly stats: EngineStats = {
    episodes: 0, bullishEpisodes: 0, bearishEpisodes: 0, attempts: 0, entries: 0, rejections: 0, rejectionReasons: {},
    ticksAccepted: 0, ticksDropped: 0, staleSeconds: 0, freshSeconds: 0, heldSeconds: 0, feedGaps: 0,
  };
  private sampler: OneSecondSampler;
  private seq = 0;
  private forcedExit: ExitReason | null = null;
  private tradeNo = 0;

  constructor(config: PulseConfig, opts: { dataMode: DataMode; running?: boolean }) {
    if (config.paperOnly !== true) throw new Error('NIFTY PULSE only runs paper-only configs');
    this.config = config;
    this.dataMode = opts.dataMode;
    this.running = opts.running ?? false; // OFF by default
    this.sampler = new OneSecondSampler(config.tickFreshnessMs);
  }

  // ── Controls ────────────────────────────────────────────────────────
  start(at: number) {
    if (this.running) return;
    this.running = true;
    this.log(at, 'ENGINE', 'Engine started', 'New paper entries enabled');
  }
  /** Blocks new entries immediately. Open positions stay under exit management. */
  stop(at: number) {
    if (!this.running) return;
    this.running = false;
    this.log(at, 'ENGINE', 'Engine stopped', this.position ? 'New entries blocked · open paper position still monitored with protective exits' : 'New entries blocked');
  }
  setKillSwitch(on: boolean, at: number) {
    if (this.killSwitch === on) return;
    this.killSwitch = on;
    if (on) {
      this.running = false;
      if (this.position) this.forcedExit = 'KILL_SWITCH';
    }
    this.log(at, 'RISK', on ? 'Kill switch engaged' : 'Kill switch released', on ? 'Engine stopped · open paper position will be flattened' : 'Engine remains stopped until started');
  }
  /** Explicit paper flatten of the open position at the next valid prices. */
  flatten(at: number) {
    if (!this.position) return;
    this.forcedExit = 'MANUAL_FLATTEN';
    this.log(at, 'ENGINE', 'Paper flatten requested', `${this.position.id} will close at the next valid bid/ask`);
  }
  /** Config can only change while flat, so every trade has exactly one config. */
  setConfig(c: PulseConfig, at: number): boolean {
    if (this.position) return false;
    if (c.paperOnly !== true) throw new Error('NIFTY PULSE only runs paper-only configs');
    this.config = c;
    this.sampler.setFreshness(c.tickFreshnessMs);
    this.log(at, 'ENGINE', `Configuration → ${c.name}`, configKey(c));
    return true;
  }

  // ── One evaluation ──────────────────────────────────────────────────
  step(boundaryMs: number, ticks: readonly Tick[], getChain: () => ChainSnapshot | null): void {
    const c = this.config;
    this.now = boundaryMs;
    for (const t of ticks) {
      if (this.sampler.onTick(t)) {
        this.stats.ticksAccepted++;
        if (t.exchTs != null) { this.latencies.push(t.recvTs - t.exchTs); if (this.latencies.length > 120) this.latencies.shift(); }
      } else this.stats.ticksDropped++;
    }
    const prev = this.samples[this.samples.length - 1];
    const sample = this.sampler.sample(boundaryMs);
    this.samples.push(sample);
    if (sample.status === 'FRESH') this.stats.freshSeconds++;
    else if (sample.status === 'HELD') this.stats.heldSeconds++;
    else this.stats.staleSeconds++;
    this.validRun = sample.valid ? this.validRun + 1 : 0;
    if (prev?.valid && !sample.valid) {
      this.stats.feedGaps++;
      this.log(boundaryMs, 'DATA', 'Market data stale — signals suspended', `No tick for ${((sample.ageMs ?? 0) / 1000).toFixed(1)}s (limit ${(c.tickFreshnessMs / 1000).toFixed(1)}s)`);
    } else if (prev && !prev.valid && sample.valid) {
      this.log(boundaryMs, 'DATA', 'Market data recovered', `Rebuilding ${requiredSamples(c)}s buffer before signals resume`);
    }

    const needed = requiredSamples(c);
    this.indicators = computeIndicators(this.samples.length > needed ? this.samples.slice(-needed) : this.samples, c);
    if (!this.indicators.ready) this.indicators = { ...this.indicators, validRun: this.validRun };
    else this.indicators = { ...this.indicators, validRun: this.validRun };
    this.signal = evaluateSignal(this.indicators, c);

    let chain: ChainSnapshot | null | undefined;
    const chainOnce = () => (chain === undefined ? (chain = getChain()) : chain);

    // 1. Manage the open position first (exits never wait for signals).
    const minute = istMinute(boundaryMs);
    if (this.position) {
      const forced = this.forcedExit ?? (minute >= SESSION_EXIT_MIN ? 'SESSION_END' : null);
      const ch = chainOnce();
      if (ch) {
        const before = this.position;
        const after = stepPosition(before, ch, c, forced);
        if (after.status === 'PENDING_EXIT' && before.status !== 'PENDING_EXIT') {
          this.log(boundaryMs, 'PENDING', `Exit pending — ${after.pendingExit!.reason.replace('_', ' ').toLowerCase()}`, after.events[after.events.length - 1].detail, after.direction, after.id);
        }
        this.position = after;
        if (after.status === 'CLOSED') {
          this.forcedExit = null;
          this.position = null;
          this.trades.push(after);
          this.lastExitAt = boundaryMs;
          this.realizedToday = Math.round((this.realizedToday + (after.realizedNet ?? 0)) * 100) / 100;
          this.log(boundaryMs, 'EXIT', `Paper exit · ${after.exitReason!.replace('_', ' ').toLowerCase()} · ${(after.realizedNet ?? 0) >= 0 ? '+' : '−'}₹${Math.abs(after.realizedNet ?? 0).toFixed(0)}`,
            `${after.id} held ${after.holdSec}s · closing debit ${after.closingDebitPts?.toFixed(2)} vs credit ${after.creditPts.toFixed(2)}`, after.direction, after.id);
        }
      }
    }

    // 2. Signal episodes.
    const dir = this.signal.direction;
    if (!this.episode || this.episode.direction !== dir) {
      if (this.episode && this.episode.direction !== 'NEUTRAL' && this.episode.outcome !== 'ENTERED') {
        this.log(boundaryMs, 'EXPIRED', 'Signal expired without trade', this.episode.reason ?? undefined, this.episode.direction);
      }
      this.episode = { direction: dir, startedAt: boundaryMs, attempted: false, outcome: 'PENDING', reason: null };
      if (dir !== 'NEUTRAL') {
        this.stats.episodes++;
        if (dir === 'BULLISH') this.stats.bullishEpisodes++; else this.stats.bearishEpisodes++;
        const ind = this.indicators.ready ? this.indicators : null;
        this.log(boundaryMs, 'SIGNAL', `${dir === 'BULLISH' ? 'Bullish' : 'Bearish'} momentum detected`,
          ind ? `R5 ${ind.r5 >= 0 ? '+' : ''}${ind.r5.toFixed(4)}% · R15 ${ind.r15 >= 0 ? '+' : ''}${ind.r15.toFixed(4)}% · ${ind.maDistance >= 0 ? '+' : ''}${ind.maDistance.toFixed(2)} vs MA${c.maWindowSec} · ${ind.ups}↑/${ind.downs}↓ of last ${c.confirmLookback}` : undefined, dir);
      }
    }

    // 3. One entry attempt per episode.
    if (dir !== 'NEUTRAL' && this.episode && !this.episode.attempted) {
      this.episode.attempted = true;
      this.stats.attempts++;
      const riskState = this.riskState(boundaryMs, sample.valid);
      const blocked = preTradeChecks(riskState, c).find((k) => !k.pass);
      if (blocked) {
        this.reject(boundaryMs, dir, blocked.detail, null, 'BLOCKED');
      } else {
        const ch = chainOnce();
        if (!ch) {
          this.reject(boundaryMs, dir, 'Option spread unavailable — no option chain', null, 'REJECTED');
        } else {
          const cands = buildCandidates(ch, dir, c);
          this.lastCandidates = cands;
          this.lastCandidatesAt = boundaryMs;
          this.log(boundaryMs, 'SELECTION', 'Spread selection started', `${cands.length} ${dir === 'BULLISH' ? 'bull put' : 'bear call'} candidates · ${cands.filter((x) => x.eligible).length} pass liquidity & pricing`, dir);
          const sel = selectApproved(cands, riskState, c);
          if (sel.decision) this.recordDecision(boundaryMs, dir, sel.chosen?.id ?? cands.find((x) => x.eligible)?.id ?? null, sel.decision);
          if (sel.chosen) {
            const ind = this.indicators.ready ? this.indicators : null;
            this.tradeNo++;
            const pos = openPaperPosition({
              cand: sel.chosen, direction: dir, config: c, at: boundaryMs, tradeNo: this.tradeNo, dataMode: this.dataMode,
              entryReason: this.signal.reason,
              signal: ind ? { price: ind.price, r5: ind.r5, r15: ind.r15, ma60: ind.ma60, ups: ind.ups, downs: ind.downs } : { price: sample.price ?? 0, r5: 0, r15: 0, ma60: 0, ups: 0, downs: 0 },
            });
            this.position = pos;
            this.episode.outcome = 'ENTERED';
            this.stats.entries++;
            this.log(boundaryMs, 'ENTRY', `Paper entry · ${pos.kind === 'BULL_PUT' ? 'Bull put' : 'Bear call'} ${pos.short.strike}/${pos.long.strike}`,
              `${pos.id} · credit ${pos.creditPts.toFixed(2)} × ${pos.qty} = ₹${pos.grossCredit.toFixed(0)} · max loss ₹${pos.maxLoss.toFixed(0)} · PAPER FILL`, dir, pos.id);
          } else {
            this.reject(boundaryMs, dir, sel.reason ?? 'Rejected', sel.decision, 'REJECTED');
          }
        }
      }
    }
  }

  riskState(now: number, feedHealthy: boolean): RiskState {
    const minute = istMinute(now);
    return {
      nowMs: now, engineRunning: this.running, killSwitch: this.killSwitch,
      openPositions: this.position ? 1 : 0, tradesToday: this.trades.length + (this.position ? 1 : 0),
      realizedToday: this.realizedToday, lastExitAt: this.lastExitAt,
      marketOpen: minute >= SESSION_OPEN_MIN && minute < ENTRY_CUTOFF_MIN, feedHealthy,
    };
  }

  cooldownLeftSec(now = this.now): number {
    if (this.lastExitAt == null) return 0;
    return Math.max(0, Math.ceil((this.config.cooldownSec * 1000 - (now - this.lastExitAt)) / 1000));
  }

  /** Why no trade is happening right now — the signal panel's status line. */
  statusReason(): string {
    if (this.position) return this.position.status === 'PENDING_EXIT' ? 'Exit pending — waiting for valid option prices' : 'Position open — managing exits';
    if (!this.indicators || !this.indicators.ready) return this.indicators?.reason ?? 'Waiting for market data';
    if (!this.running) return this.killSwitch ? 'Kill switch engaged' : 'Engine stopped — new entries blocked';
    const cd = this.cooldownLeftSec();
    if (cd > 0 && this.signal?.direction === 'NEUTRAL') return `Cooldown active — ${cd}s left`;
    if (this.episode && this.episode.direction !== 'NEUTRAL' && this.episode.reason) return this.episode.reason;
    return this.signal?.reason ?? 'Waiting';
  }

  private reject(at: number, dir: Direction, reason: string, decision: RiskDecision | null, outcome: 'REJECTED' | 'BLOCKED') {
    this.stats.rejections++;
    const bucket = reason.split(' — ')[0].replace(/\s*\(.*\)$/, '').trim();
    this.stats.rejectionReasons[bucket] = (this.stats.rejectionReasons[bucket] ?? 0) + 1;
    this.lastRejection = { at, reason };
    if (this.episode) { this.episode.outcome = outcome; this.episode.reason = reason; }
    if (decision && !this.decisions.some((d) => d.at === at)) this.recordDecision(at, dir, null, decision);
    this.log(at, 'REJECT', outcome === 'BLOCKED' ? 'Entry blocked' : 'Candidate rejected', reason, dir);
  }

  private recordDecision(at: number, direction: Direction, candidateId: string | null, d: RiskDecision) {
    this.decisions.push({ ...d, at, candidateId, direction });
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
  }

  private log(at: number, kind: TimelineKind, title: string, detail?: string, direction?: Direction, tradeId?: string) {
    this.timeline.push({ seq: ++this.seq, at, kind, title, detail, direction, tradeId });
    if (this.timeline.length > MAX_TIMELINE) this.timeline.shift();
  }
}
