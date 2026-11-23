/**
 * NIFTY ASCENT engine — one coordinated, deterministic state machine for
 * Gap-and-Go → Williams. Pure: it only reacts to the events it is fed
 * (index ticks, option ticks/quotes, clock, controls) in arrival order, so
 * live processing and replay produce identical decisions for identical input.
 *
 * Paper only. There is no order placement anywhere in this module: "orders"
 * are simulated and fill against OBSERVED quotes only.
 *
 * Processing order on each confirmed minute (deterministic):
 *   1. data checks  2. open-position exits  3. Gap-and-Go (opposite band,
 *   then directional band + gap-filled test)  4. handover → Williams
 *   eligibility → Williams trigger on the SAME bar (Q15).
 */
import {
  RESEARCH_RULES_V1, DEFAULT_EXECUTION, STRATEGY_ID, SESSION_FIRST_BAR, SESSION_LAST_BAR,
  barStart, barLabelOf, hhmm, type ResearchRules, type ExecutionSettings,
} from './rules.ts';
import { computeGap, openingRange, williamsLevels, williamsGapEligible, itmStrike, strikeStep, paise, type Gap, type OpeningRange, type WilliamsLevels, type Right } from './levels.ts';
import { MinuteBarBuilder, type Bar } from './bars.ts';
import { buyFees, sellFees, COST_MODEL_VERSION } from './costs.ts';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type State =
  | 'WAITING_FOR_MARKET' | 'COLLECTING_OPENING_RANGE' | 'GAP_GO_ARMED' | 'GAP_GO_SIGNALLED' | 'GAP_GO_STOOD_DOWN'
  | 'WILLIAMS_ELIGIBILITY_CHECK' | 'WILLIAMS_ARMED' | 'WILLIAMS_SIGNALLED' | 'ENTRY_PENDING' | 'POSITION_OPEN'
  | 'EXIT_PENDING' | 'TRADE_CLOSED' | 'NO_TRADE' | 'SESSION_COMPLETE' | 'DATA_ERROR';

export type Bot = 'GAP_AND_GO' | 'WILLIAMS';
export type StandDown = 'opposite_first' | 'filled' | 'no_break';
export type NoTradeReason =
  | 'no_gap' | 'no_break' | 'williams_gap_ineligible' | 'williams_no_trigger' | 'entry_rejected' | 'data_error' | 'killed';
export type ExitReason = 'FIXED_STOP' | 'TRAILING_STOP' | 'TIME_EXIT' | 'KILL_FLATTEN';
export type EngineStatus = 'PAUSED' | 'RUNNING' | 'ENTRIES_STOPPED' | 'KILLED';
export type EventKind = 'TRANSITION' | 'DATA' | 'ORDER' | 'FILL' | 'RISK' | 'CONTROL' | 'SIGNAL' | 'STOP';

export interface Instrument {
  token: number;
  tradingsymbol: string;
  strike: number;
  right: Right;
  expiry: string;
  lotSize: number;
}

export interface PrevSession {
  date: string;
  /** Previous trading day's 1-minute bars (Kite historical). */
  bars: Array<{ label: number; close: number }>;
}

export interface IndexTick { exchTs: number; recvTs: number; price: number }
/** One option update. `traded` = a real trade printed (ltp is a trade price). */
export interface OptionTick {
  token: number; exchTs: number; recvTs: number;
  ltp: number | null; traded: boolean;
  bid: number | null; ask: number | null; volume: number | null;
}

export interface AuditEvent {
  seq: number;
  at: number;
  bar: number | null;
  kind: EventKind;
  bot: Bot | null;
  from?: State;
  to?: State;
  trigger: string;
  reason: string;
  prices?: Record<string, number | null>;
  levels?: Record<string, number | null>;
  configVersion: string;
}

export interface PaperOrder {
  purpose: 'ENTRY' | 'EXIT';
  bot: Bot;
  reason: string;
  token: number;
  createdAt: number;
  signalBar: number | null;
  windowStart: number;
  windowEnd: number;
  status: 'PENDING' | 'FILLED' | 'REJECTED' | 'UNRESOLVED';
  late: boolean;
  skipped: Record<string, number>;
  fill?: { price: number; quoteBid: number; quoteAsk: number; quoteExchTs: number; quoteAgeMs: number; at: number };
  rejectReason?: string;
}

export interface Position {
  bot: Bot;
  right: Right;
  instrument: Instrument;
  qty: number;
  signalBar: number;
  signalClose: number;
  entryAt: number;
  entryBar: number;
  entryPremium: number;
  entryFees: number;
  fixedStop: number;
  trailActivation: number;
  highest: number | null;
  trailActive: boolean;
  trailActivatedBar: number | null;
  trailStop: number | null;
  lastPremium: number | null;
  lastBid: number | null;
  lastAsk: number | null;
  exitSignal: { bar: number | null; reason: ExitReason; at: number; fixed: boolean; trailing: boolean } | null;
}

export interface Trade {
  date: string;
  bot: Bot;
  right: Right;
  tradingsymbol: string;
  strike: number;
  expiry: string;
  lotSize: number;
  qty: number;
  gapPct: number;
  gapDirection: string;
  signalBar: number;
  signalClose: number;
  entryAt: number;
  entryPremium: number;
  exitAt: number;
  exitPremium: number;
  exitReason: ExitReason;
  exitSignalBar: number | null;
  highest: number | null;
  trailActivated: boolean;
  gross: number;
  costs: number;
  net: number;
  returnPct: number;
  strategyVersion: string;
  costModel: string;
}

export interface EngineOptions {
  date: string;
  prev: PrevSession;
  instruments: Instrument[];
  rules?: ResearchRules;
  exec?: ExecutionSettings;
  /** Engine starts PAUSED unless told otherwise (replay auto-starts). */
  startRunning?: boolean;
  realizedToday?: number;
}

const TERMINAL: ReadonlySet<State> = new Set(['NO_TRADE', 'TRADE_CLOSED', 'SESSION_COMPLETE', 'DATA_ERROR']);
const r2 = (v: number) => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------ */
/* Engine                                                               */
/* ------------------------------------------------------------------ */

export class AscentEngine {
  readonly date: string;
  readonly rules: ResearchRules;
  readonly exec: ExecutionSettings;
  readonly instruments: Instrument[];
  readonly prev: PrevSession;
  readonly configVersion: string;

  state: State = 'WAITING_FOR_MARKET';
  engineStatus: EngineStatus;
  activeBot: Bot | null = null;
  outcome: { kind: 'TRADE' | 'NO_TRADE' | 'DATA_ERROR' | 'UNRESOLVED_EXIT'; reason: string; detail?: string } | null = null;
  now = 0;

  readonly index: MinuteBarBuilder;
  readonly options = new Map<number, MinuteBarBuilder>();
  readonly lastQuote = new Map<number, OptionTick>();
  readonly events: AuditEvent[] = [];
  private seq = 0;

  // Previous session
  prevClose: number | null = null;
  prevCloseOk = false;
  prevBarsCount = 0;
  // Today
  reference: { price: number; exchTs: number; recvTs: number } | null = null;
  gap: Gap | null = null;
  gapFill: { exchTs: number; price: number } | null = null;
  or: OpeningRange | null = null;
  orCollected = 0;
  williams: WilliamsLevels | null = null;
  williamsEligible: boolean | null = null;
  standDown: { reason: StandDown; bar: number; close: number; at: number } | null = null;
  handover: { bar: number; reason: StandDown; at: number } | null = null;
  williamsStartBar: number | null = null;
  signal: { bot: Bot; right: Right; bar: number; close: number; at: number; level: number } | null = null;
  entryOrder: PaperOrder | null = null;
  exitOrder: PaperOrder | null = null;
  position: Position | null = null;
  trade: Trade | null = null;
  realizedToday: number;
  positionsToday = 0;
  killed = false;
  private sessionClosed = false;

  constructor(o: EngineOptions) {
    this.date = o.date;
    this.rules = o.rules ?? RESEARCH_RULES_V1;
    this.exec = o.exec ?? DEFAULT_EXECUTION;
    this.instruments = o.instruments;
    this.prev = o.prev;
    this.configVersion = `${STRATEGY_ID}:${this.rules.version}/${this.exec.version}`;
    this.engineStatus = o.startRunning ? 'RUNNING' : 'PAUSED';
    this.realizedToday = o.realizedToday ?? 0;
    this.index = new MinuteBarBuilder(o.date, SESSION_FIRST_BAR, SESSION_LAST_BAR, 'MISSING');
    this.loadPrevSession();
  }

  /* ---------------- previous session (Q2, Q5) ---------------- */

  private loadPrevSession() {
    const bars = this.prev.bars.filter((b) => Number.isFinite(b.close) && b.close > 0);
    this.prevBarsCount = bars.length;
    const pc = bars.find((b) => b.label === this.rules.prevCloseBar);
    this.prevClose = pc ? pc.close : null;
    this.prevCloseOk = pc != null && bars.length >= this.exec.minPrevDayBars;
    if (!this.prevCloseOk) {
      this.dataError(null, pc == null
        ? `previous session ${this.prev.date}: the ${hhmm(this.rules.prevCloseBar)} bar is missing from Kite historical data`
        : `previous session ${this.prev.date}: only ${bars.length} valid minute bars (need ${this.exec.minPrevDayBars})`);
    }
  }

  /* ---------------- event log ---------------- */

  private log(e: Omit<AuditEvent, 'seq' | 'configVersion' | 'at'> & { at?: number }) {
    this.events.push({ ...e, at: e.at ?? this.now, seq: ++this.seq, configVersion: this.configVersion });
  }

  private levelsNow(): Record<string, number | null> {
    return {
      previousClose: this.prevClose, todayOpen: this.reference?.price ?? null,
      orHigh: this.or?.high ?? null, orLow: this.or?.low ?? null,
      upsideBand: this.or?.upsideBand ?? null, downsideBand: this.or?.downsideBand ?? null,
      williamsCe: this.williams?.ceLevel ?? null, williamsPe: this.williams?.peLevel ?? null,
    };
  }

  private go(to: State, trigger: string, reason: string, bar: number | null, prices?: Record<string, number | null>, bot: Bot | null = this.activeBot) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.log({ kind: 'TRANSITION', bar, bot, from, to, trigger, reason, prices, levels: this.levelsNow() });
  }

  private noTrade(reason: NoTradeReason, detail: string, bar: number | null, prices?: Record<string, number | null>) {
    this.outcome = { kind: 'NO_TRADE', reason, detail };
    this.go('NO_TRADE', reason, detail, bar, prices);
  }

  private dataError(bar: number | null, reason: string) {
    if (this.state === 'DATA_ERROR') return;
    this.log({ kind: 'DATA', bar, bot: this.activeBot, trigger: 'data_error', reason });
    if (this.position) return; // never abandon an open position: it stays managed; only new entries are blocked
    this.outcome = { kind: 'DATA_ERROR', reason: 'data_error', detail: reason };
    this.go('DATA_ERROR', 'data_error', reason, bar);
  }

  /* ---------------- controls (Q12) ---------------- */

  control(action: 'START' | 'STOP_ENTRIES' | 'KILL' | 'RELEASE', at: number) {
    this.now = Math.max(this.now, at);
    if (action === 'START') {
      if (this.killed) { this.log({ kind: 'CONTROL', bar: null, bot: null, trigger: 'start_refused', reason: 'kill switch is on — release it first' }); return; }
      this.engineStatus = 'RUNNING';
    } else if (action === 'STOP_ENTRIES') {
      this.engineStatus = this.killed ? 'KILLED' : 'ENTRIES_STOPPED';
    } else if (action === 'RELEASE') {
      this.killed = false; this.engineStatus = 'ENTRIES_STOPPED';
    } else {
      this.killed = true; this.engineStatus = 'KILLED';
      if (this.entryOrder?.status === 'PENDING') this.rejectEntry('killed', 'kill switch pressed before the entry filled');
      if (this.position && !this.exitOrder) this.beginExit('KILL_FLATTEN', null, false, false);
    }
    this.log({ kind: 'CONTROL', bar: null, bot: null, trigger: action.toLowerCase(), reason: `engine ${this.engineStatus}` });
  }

  get entriesAllowed(): boolean { return this.engineStatus === 'RUNNING' && !this.killed; }

  /** Tokens whose quotes the engine needs (for stream subscription / replay). */
  wantedTokens(): number[] {
    const t = new Set<number>();
    if (this.entryOrder?.status === 'PENDING') t.add(this.entryOrder.token);
    if (this.position) t.add(this.position.instrument.token);
    return [...t];
  }

  /* ---------------- index ticks ---------------- */

  onIndexTick(t: IndexTick) {
    this.now = Math.max(this.now, t.recvTs);
    if (!(t.price > 0)) { this.log({ kind: 'DATA', bar: null, bot: null, trigger: 'bad_tick', reason: 'non-positive index price dropped' }); return; }
    if (t.recvTs - t.exchTs > this.exec.maxIndexLagMs) {
      this.log({ kind: 'DATA', bar: barLabelOf(this.date, t.exchTs), bot: null, trigger: 'stale_tick', reason: `index tick ${t.recvTs - t.exchTs} ms old on receipt — dropped` });
      return;
    }
    const res = this.index.add(t.exchTs, t.recvTs, t.price);
    if (res === 'late') this.log({ kind: 'DATA', bar: barLabelOf(this.date, t.exchTs), bot: null, trigger: 'late_tick', reason: 'tick for an already-confirmed bar — logged, not applied' });
    if (res !== 'ok') return;

    // Q1: today's reference = first valid tick at or after 09:15:00.
    if (!this.reference && t.exchTs >= barStart(this.date, this.rules.orFirstBar)) {
      this.reference = { price: t.price, exchTs: t.exchTs, recvTs: t.recvTs };
      if (this.state === 'WAITING_FOR_MARKET') this.go('COLLECTING_OPENING_RANGE', 'first_tick', `today's reference ${t.price} at ${new Date(t.exchTs).toISOString()}`, this.rules.orFirstBar, { reference: t.price });
      if (this.prevCloseOk && this.prevClose != null) {
        this.gap = computeGap(this.prevClose, t.price);
        this.williams = williamsLevels(t.price, this.prev.bars.map((b) => b.close), this.rules);
        this.williamsEligible = williamsGapEligible(this.gap, this.rules);
        this.log({ kind: 'SIGNAL', bar: this.rules.orFirstBar, bot: null, trigger: 'gap_measured',
          reason: `gap ${this.gap.direction} ${this.gap.points.toFixed(2)} pts (${this.gap.pct.toFixed(4)}%) vs previous ${hhmm(this.rules.prevCloseBar)} close ${this.prevClose}`,
          prices: { reference: t.price, previousClose: this.prevClose }, levels: this.levelsNow() });
        if (this.gap.direction === 'NONE') this.noTrade('no_gap', 'zero gap — no Gap-and-Go direction, no Williams (Q14)', this.rules.orFirstBar);
      }
    }
    // Q3: gap fill on valid ticks, earliest event persisted, never future data.
    if (this.gap && !this.gapFill && this.gap.direction !== 'NONE') {
      const hit = this.gap.direction === 'UP' ? paise(t.price) <= paise(this.gap.previousClose) : paise(t.price) >= paise(this.gap.previousClose);
      if (hit) {
        this.gapFill = { exchTs: t.exchTs, price: t.price };
        this.log({ kind: 'SIGNAL', bar: barLabelOf(this.date, t.exchTs), bot: 'GAP_AND_GO', trigger: 'gap_filled',
          reason: `tick ${t.price} ${this.gap.direction === 'UP' ? '≤' : '≥'} previous close ${this.gap.previousClose} — gap filled`, prices: { tick: t.price } });
      }
    }
  }

  /* ---------------- option ticks ---------------- */

  onOptionTick(q: OptionTick) {
    this.now = Math.max(this.now, q.recvTs);
    this.lastQuote.set(q.token, q);
    if (q.traded && q.ltp != null && q.ltp > 0) this.optionBars(q.token).add(q.exchTs, q.recvTs, q.ltp);
    if (this.position && q.token === this.position.instrument.token) {
      this.position.lastBid = q.bid; this.position.lastAsk = q.ask;
      if (q.traded && q.ltp) this.position.lastPremium = q.ltp;
    }
    this.tryFill(q);
  }

  optionBars(token: number): MinuteBarBuilder {
    let b = this.options.get(token);
    if (!b) {
      b = new MinuteBarBuilder(this.date, SESSION_FIRST_BAR, SESSION_LAST_BAR, 'NO_PRINT');
      // Only bars from now on matter; earlier ones were never observed.
      b.nextLabel = Math.max(SESSION_FIRST_BAR, barLabelOf(this.date, this.now));
      this.options.set(token, b);
    }
    return b;
  }

  /* ---------------- clock ---------------- */

  onClock(nowMs: number) {
    this.now = Math.max(this.now, nowMs);
    const grace = this.exec.barGraceMs;

    // Q11: mandatory time exit initiated at 15:15:00 — before the 15:14 bar is confirmed.
    if (this.position && !this.exitOrder && nowMs >= barStart(this.date, this.rules.timeExitMinute)) {
      this.beginExit('TIME_EXIT', null, false, false);
    }
    // Order windows that ran out.
    if (this.entryOrder?.status === 'PENDING' && nowMs >= this.entryOrder.windowEnd + grace) {
      this.rejectEntry('no_executable_quote', `no fresh executable ask in ${hhmm(barLabelOf(this.date, this.entryOrder.windowStart))}` + skippedText(this.entryOrder));
    }
    if (this.exitOrder?.status === 'PENDING' && !this.exitOrder.late && nowMs >= this.exitOrder.windowEnd + grace) {
      this.exitOrder.late = true;
      this.log({ kind: 'ORDER', bar: null, bot: this.position?.bot ?? null, trigger: 'exit_late', reason: 'no fresh executable bid in the exit minute — still seeking the first fresh bid; no fill is assumed' });
    }

    // Confirm bars (index, then the traded option) and process them in order.
    const idx = this.index.confirmUntil(nowMs, grace);
    const opt = this.position ? this.optionBars(this.position.instrument.token).confirmUntil(nowMs, grace) : [];
    const optByLabel = new Map(opt.map((b) => [b.label, b]));
    for (const bar of idx) {
      const ob = optByLabel.get(bar.label);
      if (ob) { optByLabel.delete(bar.label); this.onPremiumBar(ob); }
      this.onIndexBar(bar);
    }
    for (const ob of optByLabel.values()) this.onPremiumBar(ob);

    // Session end.
    if (!this.sessionClosed && nowMs >= barStart(this.date, SESSION_LAST_BAR + 1)) {
      this.sessionClosed = true;
      if (this.exitOrder?.status === 'PENDING') {
        this.exitOrder.status = 'UNRESOLVED';
        this.outcome = { kind: 'UNRESOLVED_EXIT', reason: 'unresolved_exit', detail: 'no fresh executable bid observed before the session ended — exit NOT assumed' };
        this.log({ kind: 'RISK', bar: SESSION_LAST_BAR, bot: this.position?.bot ?? null, trigger: 'unresolved_exit', reason: this.outcome.detail! });
      } else if (this.entryOrder?.status === 'PENDING') {
        this.rejectEntry('session_end', 'session ended before the entry filled');
      } else if (!TERMINAL.has(this.state) && !this.position) {
        this.noTrade(this.activeBot === 'WILLIAMS' ? 'williams_no_trigger' : 'no_break', 'session ended', SESSION_LAST_BAR);
      }
      if (this.state !== 'DATA_ERROR' && !this.position) this.go('SESSION_COMPLETE', 'session_end', 'market closed', SESSION_LAST_BAR);
    }
  }

  /* ---------------- index bar processing ---------------- */

  private onIndexBar(bar: Bar) {
    const R = this.rules;
    if (bar.status === 'MISSING') {
      this.log({ kind: 'DATA', bar: bar.label, bot: null, trigger: 'missing_bar', reason: `no valid NIFTY tick in ${hhmm(bar.label)}` });
    }
    if (TERMINAL.has(this.state) || this.position || this.entryOrder) return;

    // Opening range collection (Q5: a missing OR bar → DATA_ERROR, no trade).
    if (bar.label >= R.orFirstBar && bar.label <= R.orLastBar) {
      if (bar.status !== 'OK') { this.dataError(bar.label, `opening-range bar ${hhmm(bar.label)} is missing — no trade today (Q5)`); return; }
      this.orCollected++;
      if (bar.label === R.orLastBar) {
        const closes = this.index.bars.filter((b) => b.label >= R.orFirstBar && b.label <= R.orLastBar).map((b) => ({ label: b.label, close: b.close! }));
        this.or = openingRange(closes, R);
        this.log({ kind: 'SIGNAL', bar: bar.label, bot: 'GAP_AND_GO', trigger: 'opening_range_final',
          reason: `31 closes 09:15–09:45: high ${this.or.high}, low ${this.or.low}, width ${r2(this.or.width)}; bands ${this.or.upsideBand.toFixed(2)} / ${this.or.downsideBand.toFixed(2)}`,
          levels: this.levelsNow() });
        if (!this.gap) { this.dataError(bar.label, 'gap could not be measured (no valid 09:15 reference or previous close)'); return; }
        if (this.gap.direction !== 'NONE') {
          this.activeBot = 'GAP_AND_GO';
          this.go('GAP_GO_ARMED', 'opening_range_final', `gap ${this.gap.direction}: watching ${this.gap.direction === 'UP' ? `close > ${this.or.upsideBand.toFixed(2)} (CE)` : `close < ${this.or.downsideBand.toFixed(2)} (PE)`} from 09:46 to 12:00`, bar.label);
        }
      }
      return;
    }

    if (this.state === 'GAP_GO_ARMED' && bar.label >= R.gapGoFirstBar && bar.label <= R.gapGoLastBar) {
      if (bar.status !== 'OK') { this.dataError(bar.label, `Gap-and-Go bar ${hhmm(bar.label)} is missing — the first breakout cannot be determined`); return; }
      this.gapAndGo(bar);
      if (this.state === 'GAP_GO_ARMED' && bar.label === R.gapGoLastBar) {
        this.standDown = { reason: 'no_break', bar: bar.label, close: bar.close!, at: this.now };
        this.go('GAP_GO_STOOD_DOWN', 'no_break', 'no qualifying breakout by 12:00', bar.label, { close: bar.close });
        this.noTrade('no_break', '`no_break` never activates Williams (Q4)', bar.label, { close: bar.close });
      }
      return;
    }

    if (this.state === 'WILLIAMS_ARMED') this.williamsBar(bar);
  }

  private gapAndGo(bar: Bar) {
    const c = bar.close!, or = this.or!, up = this.gap!.direction === 'UP';
    const prices = { close: c };
    // 3a. opposite band first
    const opposite = up ? c < or.downsideBand : c > or.upsideBand;
    if (opposite) { this.handoverFrom('opposite_first', bar, `close ${c} ${up ? '<' : '>'} ${up ? 'downside' : 'upside'} band ${(up ? or.downsideBand : or.upsideBand).toFixed(2)} before any ${up ? 'upside' : 'downside'} breakout`); return; }
    // 3b. directional breakout (strict)
    const directional = up ? c > or.upsideBand : c < or.downsideBand;
    if (!directional) return;
    // Gap-filled test (Q3): a fill tick strictly at or before this bar's confirming close tick — never later data.
    if (this.gapFill && bar.lastExchTs != null && this.gapFill.exchTs <= bar.lastExchTs) {
      this.handoverFrom('filled', bar, `breakout close ${c} ${up ? '>' : '<'} band, but the gap had already filled at ${new Date(this.gapFill.exchTs).toISOString()} (tick ${this.gapFill.price})`);
      return;
    }
    const right: Right = up ? 'CE' : 'PE';
    this.signal = { bot: 'GAP_AND_GO', right, bar: bar.label, close: c, at: this.now, level: up ? or.upsideBand : or.downsideBand };
    this.go('GAP_GO_SIGNALLED', 'breakout', `close ${c} ${up ? '>' : '<'} ${(up ? or.upsideBand : or.downsideBand).toFixed(2)} at ${hhmm(bar.label)} → BUY ${right}`, bar.label, prices);
    this.placeEntry(bar);
  }

  private handoverFrom(reason: 'opposite_first' | 'filled', bar: Bar, detail: string) {
    this.standDown = { reason, bar: bar.label, close: bar.close!, at: this.now };
    this.go('GAP_GO_STOOD_DOWN', reason, detail, bar.label, { close: bar.close });
    this.go('WILLIAMS_ELIGIBILITY_CHECK', reason, `qualifying stand-down \`${reason}\` — checking gap size ${this.gap!.pct.toFixed(4)}%`, bar.label);
    if (!this.williamsEligible) {
      this.noTrade('williams_gap_ineligible', `gap ${this.gap!.pct.toFixed(4)}% is in [0.2%, 0.5%) — Williams forbidden`, bar.label);
      return;
    }
    this.handover = { bar: bar.label, reason, at: this.now };
    this.williamsStartBar = bar.label; // Q15: the handover bar itself is evaluated
    this.activeBot = 'WILLIAMS';
    this.go('WILLIAMS_ARMED', 'handover', `Williams armed from ${hhmm(bar.label)} until 14:29: CE > ${this.williams!.ceLevel.toFixed(2)} · PE < ${this.williams!.peLevel.toFixed(2)}`, bar.label, undefined, 'WILLIAMS');
    this.williamsBar(bar);
  }

  private williamsBar(bar: Bar) {
    const R = this.rules;
    if (this.williamsStartBar == null || bar.label < this.williamsStartBar) return;
    if (bar.label > R.williamsLastBar) return;
    if (bar.status !== 'OK') { this.dataError(bar.label, `Williams bar ${hhmm(bar.label)} is missing — the first trigger cannot be determined`); return; }
    const c = bar.close!, w = this.williams!;
    const right: Right | null = c > w.ceLevel ? 'CE' : c < w.peLevel ? 'PE' : null;
    if (right) {
      this.signal = { bot: 'WILLIAMS', right, bar: bar.label, close: c, at: this.now, level: right === 'CE' ? w.ceLevel : w.peLevel };
      this.go('WILLIAMS_SIGNALLED', 'williams_trigger', `close ${c} ${right === 'CE' ? '>' : '<'} ${(right === 'CE' ? w.ceLevel : w.peLevel).toFixed(2)} at ${hhmm(bar.label)} → BUY ${right}`, bar.label, { close: c });
      this.placeEntry(bar);
      return;
    }
    if (bar.label === R.williamsLastBar) this.noTrade('williams_no_trigger', 'neither Williams level broke by 14:29', bar.label, { close: c });
  }

  /* ---------------- entries ---------------- */

  private placeEntry(bar: Bar) {
    const sig = this.signal!;
    const bot = sig.bot;
    if (this.positionsToday >= this.rules.maxPositionsPerDay) { this.rejectSignal('daily_limit', 'one position per day already used'); return; }
    if (!this.entriesAllowed) { this.rejectSignal('entries_disabled', `engine is ${this.engineStatus} — signal recorded, no entry`); return; }
    if (this.realizedToday <= -Math.abs(this.exec.dailyLossCutoff)) { this.rejectSignal('daily_loss_cutoff', `daily realized loss cutoff ₹${this.exec.dailyLossCutoff} reached`); return; }

    // Contract (Q7, Q8, Q9) from the instrument master — never invented.
    const expiries = [...new Set(this.instruments.map((i) => i.expiry))].filter((e) => e >= this.date).sort();
    let expiry = expiries[0];
    if (expiry === this.date && this.rules.expiryDayUsesNextExpiry) expiry = expiries[1];
    if (!expiry) { this.rejectSignal('expiry_missing', 'no listed NIFTY expiry available'); return; }
    const chain = this.instruments.filter((i) => i.expiry === expiry && i.right === sig.right);
    const step = strikeStep(chain.map((i) => i.strike), sig.close);
    if (step == null) { this.rejectSignal('contract_missing', `no listed ${sig.right} strikes near ${sig.close} for ${expiry}`); return; }
    const strike = itmStrike(sig.close, sig.right, this.rules.itmPoints, step);
    const inst = chain.find((i) => paise(i.strike) === paise(strike));
    if (!inst) { this.rejectSignal('contract_missing', `${sig.right} ${strike} (${expiry}) is not in the instrument master`); return; }
    if (!(inst.lotSize > 0)) { this.rejectSignal('contract_missing', `${inst.tradingsymbol} has no valid lot size`); return; }

    const ws = barStart(this.date, bar.label + 1);
    this.entryOrder = {
      purpose: 'ENTRY', bot, reason: `${bot} ${sig.right} signal ${hhmm(bar.label)}`, token: inst.token, createdAt: this.now,
      signalBar: bar.label, windowStart: ws, windowEnd: ws + 60_000, status: 'PENDING', late: false, skipped: {},
    };
    this.pendingInstrument = inst;
    this.go('ENTRY_PENDING', 'order_created', `BUY ${this.exec.lots} lot ${inst.tradingsymbol} (strike ${strike}, ${(sig.right === 'CE' ? sig.close - strike : strike - sig.close).toFixed(2)} pts ITM, expiry ${expiry}) at the first fresh ask in ${hhmm(bar.label + 1)}`, bar.label);
    this.log({ kind: 'ORDER', bar: bar.label, bot, trigger: 'entry_order', reason: `paper BUY ${inst.tradingsymbol} × ${inst.lotSize * this.exec.lots}`, prices: { signalClose: sig.close, strike } });
    // A quote already observed may fill only if it is inside the window and fresh now.
    const q = this.lastQuote.get(inst.token);
    if (q) this.tryFill(q);
  }
  private pendingInstrument: Instrument | null = null;

  private rejectSignal(code: string, detail: string) {
    this.log({ kind: 'RISK', bar: this.signal?.bar ?? null, bot: this.signal?.bot ?? null, trigger: code, reason: detail });
    this.outcome = { kind: 'NO_TRADE', reason: 'entry_rejected', detail: `${code}: ${detail}` };
    this.go('NO_TRADE', code, `entry rejected — ${detail}`, this.signal?.bar ?? null);
  }

  private rejectEntry(code: string, detail: string) {
    const o = this.entryOrder!;
    o.status = 'REJECTED'; o.rejectReason = code;
    this.log({ kind: 'ORDER', bar: null, bot: o.bot, trigger: `entry_${code}`, reason: detail });
    this.outcome = { kind: 'NO_TRADE', reason: code === 'killed' ? 'killed' : 'entry_rejected', detail: `${code}: ${detail}` };
    this.go('NO_TRADE', code, `entry rejected — ${detail}`, null);
  }

  /** Fills only against observed quotes: entry at a fresh ask, exit at a fresh bid. */
  private tryFill(q: OptionTick) {
    const age = this.now - q.exchTs;
    const e = this.entryOrder;
    if (e?.status === 'PENDING' && q.token === e.token) {
      if (q.exchTs < e.windowStart || q.exchTs >= e.windowEnd) return;
      const skip = (k: string) => { e.skipped[k] = (e.skipped[k] ?? 0) + 1; };
      if (age > this.exec.maxQuoteAgeMs) return skip('stale_quote');
      if (q.ask == null || q.bid == null || !(q.ask > 0) || !(q.bid > 0) || q.ask < q.bid) return skip('no_two_sided_quote');
      const mid = (q.ask + q.bid) / 2;
      if (((q.ask - q.bid) / mid) * 100 > this.exec.maxSpreadPct) return skip('spread_too_wide');
      if ((q.volume ?? 0) < this.exec.minDailyVolume) return skip('low_volume');
      const inst = this.pendingInstrument!;
      const qty = inst.lotSize * this.exec.lots;
      const price = r2(q.ask * (1 + this.exec.slippage));
      const fees = buyFees(price, qty);
      const outlay = price * qty + fees;
      const worstLoss = outlay + sellFees(0, qty);
      if (outlay > this.exec.maxPremiumOutlay) { this.rejectEntry('budget', `one lot costs ₹${Math.round(outlay).toLocaleString('en-IN')} incl. fees > ₹${this.exec.maxPremiumOutlay.toLocaleString('en-IN')} max premium outlay — strike and quantity are not changed to force a trade`); return; }
      if (worstLoss > this.exec.maxTheoreticalLoss) { this.rejectEntry('max_loss', `theoretical loss ₹${Math.round(worstLoss)} > ₹${this.exec.maxTheoreticalLoss}`); return; }
      e.status = 'FILLED';
      e.fill = { price, quoteBid: q.bid, quoteAsk: q.ask, quoteExchTs: q.exchTs, quoteAgeMs: age, at: this.now };
      this.openPosition(inst, qty, price, fees);
      return;
    }
    const x = this.exitOrder;
    const p = this.position;
    if (x?.status === 'PENDING' && p && q.token === x.token) {
      if (q.exchTs < x.windowStart) return;
      if (age > this.exec.maxQuoteAgeMs) { x.skipped.stale_quote = (x.skipped.stale_quote ?? 0) + 1; return; }
      if (q.bid == null || !(q.bid > 0)) { x.skipped.no_bid = (x.skipped.no_bid ?? 0) + 1; return; }
      const price = r2(q.bid * (1 - this.exec.slippage));
      x.status = 'FILLED';
      x.fill = { price, quoteBid: q.bid, quoteAsk: q.ask ?? 0, quoteExchTs: q.exchTs, quoteAgeMs: age, at: this.now };
      this.closePosition(price);
    }
  }

  private openPosition(inst: Instrument, qty: number, price: number, fees: number) {
    if (this.positionsToday >= this.rules.maxPositionsPerDay || this.position) return; // belt and braces
    const sig = this.signal!;
    const R = this.rules;
    this.positionsToday++;
    this.position = {
      bot: sig.bot, right: sig.right, instrument: inst, qty, signalBar: sig.bar, signalClose: sig.close,
      entryAt: this.now, entryBar: barLabelOf(this.date, this.entryOrder!.fill!.quoteExchTs), entryPremium: price, entryFees: fees,
      fixedStop: price * R.fixedStopFactor, trailActivation: price * R.trailActivationFactor,
      highest: null, trailActive: false, trailActivatedBar: null, trailStop: null,
      lastPremium: null, lastBid: this.entryOrder!.fill!.quoteBid, lastAsk: this.entryOrder!.fill!.quoteAsk, exitSignal: null,
    };
    // Premium bars for this contract start with the fill minute (Q6).
    const ob = this.optionBars(inst.token);
    ob.nextLabel = Math.max(ob.nextLabel, this.position.entryBar);
    this.log({ kind: 'FILL', bar: this.position.entryBar, bot: sig.bot, trigger: 'entry_fill',
      reason: `BUY ${inst.tradingsymbol} × ${qty} @ ₹${price} (ask ${this.entryOrder!.fill!.quoteAsk} + ${(this.exec.slippage * 100).toFixed(2)}% slippage, quote age ${this.entryOrder!.fill!.quoteAgeMs} ms)`,
      prices: { fill: price, ask: this.entryOrder!.fill!.quoteAsk, bid: this.entryOrder!.fill!.quoteBid } });
    this.go('POSITION_OPEN', 'entry_fill', `fixed stop ≤ ₹${(price * R.fixedStopFactor).toFixed(2)} · trail activates > ₹${(price * R.trailActivationFactor).toFixed(2)}`, this.position.entryBar, { entry: price });
  }

  /* ---------------- position management (Q6, Q10, Q11) ---------------- */

  private onPremiumBar(b: Bar) {
    const p = this.position;
    if (!p || b.label < p.entryBar) return;
    if (b.status !== 'OK') { this.log({ kind: 'DATA', bar: b.label, bot: p.bot, trigger: 'no_print', reason: `no ${p.instrument.tradingsymbol} trade in ${hhmm(b.label)} — NO_PRINT, no stop decision` }); return; }
    const c = b.close!;
    p.highest = p.highest == null ? c : Math.max(p.highest, c);
    // Integer paise comparisons: exactly 105% never activates, exactly 70% / 80% always trigger.
    const cP = paise(c), eP = paise(p.entryPremium);
    if (!p.trailActive && cP * 100 > eP * Math.round(this.rules.trailActivationFactor * 100)) {
      p.trailActive = true; p.trailActivatedBar = b.label;
      this.log({ kind: 'STOP', bar: b.label, bot: p.bot, trigger: 'trail_activated', reason: `premium close ₹${c} > ₹${p.trailActivation.toFixed(2)} (105% of entry) — trailing stop active`, prices: { close: c } });
    }
    if (p.trailActive) p.trailStop = p.highest * this.rules.trailStopFactor;
    if (this.exitOrder) return; // an exit is already in progress (time exit / kill / earlier stop)
    const fixed = cP * 100 <= eP * Math.round(this.rules.fixedStopFactor * 100);
    const trailing = p.trailActive && cP * 100 <= paise(p.highest) * Math.round(this.rules.trailStopFactor * 100);
    if (fixed || trailing) {
      // Both on one close: FIXED_STOP label, both recorded (only possible when c ≤ 70% of entry).
      this.beginExit(fixed ? 'FIXED_STOP' : 'TRAILING_STOP', b, fixed, trailing);
    }
  }

  private beginExit(reason: ExitReason, bar: Bar | null, fixed: boolean, trailing: boolean) {
    const p = this.position!;
    // Stops: the next minute (Q10). Time exit: at or after 15:15:00 (Q11). Kill: from now.
    const ws = bar ? barStart(this.date, bar.label + 1) : reason === 'TIME_EXIT' ? barStart(this.date, this.rules.timeExitMinute) : this.now;
    p.exitSignal = { bar: bar?.label ?? null, reason, at: this.now, fixed, trailing };
    this.exitOrder = {
      purpose: 'EXIT', bot: p.bot, reason, token: p.instrument.token, createdAt: this.now, signalBar: bar?.label ?? null,
      windowStart: ws, windowEnd: ws + 60_000, status: 'PENDING', late: false, skipped: {},
    };
    const what = reason === 'TIME_EXIT' ? 'mandatory 15:15 time exit — first fresh bid at or after 15:15:00'
      : reason === 'KILL_FLATTEN' ? 'kill / flatten — first fresh bid from now'
      : `${reason === 'FIXED_STOP' ? `premium close ₹${bar!.close} ≤ ₹${p.fixedStop.toFixed(2)}` : `premium close ₹${bar!.close} ≤ trail ₹${p.trailStop!.toFixed(2)}`}${fixed && trailing ? ' (fixed and trailing both triggered)' : ''} — first fresh bid in ${hhmm(bar!.label + 1)}`;
    this.log({ kind: 'STOP', bar: bar?.label ?? null, bot: p.bot, trigger: reason.toLowerCase(), reason: what, prices: { close: bar?.close ?? null } });
    this.go('EXIT_PENDING', reason.toLowerCase(), what, bar?.label ?? null);
    const q = this.lastQuote.get(p.instrument.token);
    if (q) this.tryFill(q);
  }

  private closePosition(exitPrice: number) {
    const p = this.position!;
    const exitFees = sellFees(exitPrice, p.qty);
    const gross = r2((exitPrice - p.entryPremium) * p.qty);
    const costs = r2(p.entryFees + exitFees);
    const net = r2(gross - costs);
    this.realizedToday += net;
    const xs = p.exitSignal!;
    this.trade = {
      date: this.date, bot: p.bot, right: p.right, tradingsymbol: p.instrument.tradingsymbol, strike: p.instrument.strike,
      expiry: p.instrument.expiry, lotSize: p.instrument.lotSize, qty: p.qty,
      gapPct: this.gap?.pct ?? 0, gapDirection: this.gap?.direction ?? 'NONE',
      signalBar: p.signalBar, signalClose: p.signalClose, entryAt: p.entryAt, entryPremium: p.entryPremium,
      exitAt: this.now, exitPremium: exitPrice, exitReason: xs.reason, exitSignalBar: xs.bar,
      highest: p.highest, trailActivated: p.trailActive, gross, costs, net,
      returnPct: r2((net / (p.entryPremium * p.qty)) * 100), strategyVersion: this.configVersion, costModel: COST_MODEL_VERSION,
    };
    this.log({ kind: 'FILL', bar: barLabelOf(this.date, this.exitOrder!.fill!.quoteExchTs), bot: p.bot, trigger: 'exit_fill',
      reason: `SELL ${p.instrument.tradingsymbol} × ${p.qty} @ ₹${exitPrice} (bid ${this.exitOrder!.fill!.quoteBid} − slippage) · gross ₹${gross} · costs ₹${costs} · net ₹${net}`,
      prices: { fill: exitPrice, bid: this.exitOrder!.fill!.quoteBid } });
    this.position = null;
    this.outcome = { kind: 'TRADE', reason: xs.reason };
    this.go('TRADE_CLOSED', 'exit_fill', `${xs.reason} · net ₹${net}`, null, { exit: exitPrice }, p.bot);
  }

  /* ---------------- read model ---------------- */

  /** Bars that are confirmed (for charts and tables). */
  premiumBars(): Bar[] {
    const tok = this.position?.instrument.token ?? (this.trade ? this.instruments.find((i) => i.tradingsymbol === this.trade!.tradingsymbol)?.token : undefined);
    return tok != null ? (this.options.get(tok)?.bars ?? []) : [];
  }
}

function skippedText(o: PaperOrder): string {
  const k = Object.entries(o.skipped);
  return k.length ? ` (quotes skipped: ${k.map(([a, n]) => `${a} ×${n}`).join(', ')})` : '';
}
