/**
 * Nifty Alpha Edge (hedged131) engine — one call per minute (cron). Manages
 * open positions first (mark-to-market, monitor target, scheduled/safety
 * exits, short-first unwinds), then opens this week's position for each
 * enabled mode if the shared weekly signal fired today.
 *
 * All I/O is injected (store, market data, broker), so every rule here is
 * testable without a broker session or real money.
 *
 * Invariants (spec §15.6), enforced here:
 *  - entry: the protective BUY wing must be FILLED before the ATM SELL is
 *    released (AUTO reuses the audited hedge-first sequencer, liveFill.ts);
 *  - exit: the short is closed before the wing is sold; if the short cannot
 *    be closed the wing is left open on purpose;
 *  - one position per week per mode (DB unique key), claimed BEFORE any
 *    order so overlapping cron ticks cannot double-enter;
 *  - one exit executor per position (conditional ACTIVE→EXITING update);
 *  - direction is never re-evaluated after the position is published;
 *  - an unknown broker state stops and alerts — it is never guessed.
 */
import { runLiveExecution, type LiveOrderPlacer } from '../quant/execution/liveFill.ts';
import type { PlannedLeg } from '../quant/execution/paperFill.ts';
import { selectExpiry } from '../nifty-alpha-ladder/calendar/expirySelection.ts';
import { deriveStrikeStep, selectATM } from '../nifty-alpha-ladder/instruments/strikeResolver.ts';
import { computeUnitModeUnits } from '../nifty-alpha-ladder/sizing/unitSizing.ts';
import type { Direction } from '../nifty-alpha-ladder/types.ts';
import { decideDirection, type EdgeDecision, type SharedSignal, type VixBar } from './decision.ts';
import { resolveCreditSpread, spreadRisk, structureLabel } from './structure.ts';
import {
  entryBlock, exitCheck, istClock, shadowFill, specLimit, totalPnl, creditPoints, midPrice, intrinsic,
  type Clock, type EdgeMode, type ExitReason, type PositionStatus, type Quote,
} from './lifecycle.ts';
import { AUTO_FILL_TIMEOUT_MS, INTER_LEG_SPACING_MS, STRATEGY_VERSION, UNIT_BUDGET_RUPEES, WING_STEPS } from './parameters.ts';

// ------------------------------------------------------------------ types

export interface EdgeSettings {
  shadowEnabled: boolean;
  autoEnabled: boolean;
  killSwitch: boolean;
  shadowCapital: number;
  autoCapital: number;
  activeBroker: 'KITE' | 'GROWW';
  unitBudget: number;
}

export interface EdgeLeg {
  id?: number;
  legIndex: number;
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
  kiteSymbol: string;
  brokerSymbol: string;
  quantity: number;
  entryLimit: number | null;
  entryFill: number | null;
  entryOrderId: string | null;
  exitLimit: number | null;
  exitFill: number | null;
  exitOrderId: string | null;
  lastPrice: number | null;
}

export interface EdgePosition {
  id: number;
  mode: EdgeMode;
  weekKey: string;
  signalId: number;
  direction: Direction;
  structure: string;
  expiry: string;
  atm: number;
  quantity: number;
  creditPoints: number | null;
  f0: number;
  futureSymbol: string;
  status: PositionStatus;
  exitReason: string | null;
  exitAttempts: number;
  broker: 'KITE' | 'GROWW' | null;
  legs: EdgeLeg[];
}

export interface NewPosition {
  mode: EdgeMode;
  weekKey: string;
  signalId: number;
  signalDate: string;
  decision: EdgeDecision;
  structure: string;
  expiry: string;
  atm: number;
  strikeStep: number;
  wingPoints: number;
  units: number;
  lotSize: number;
  quantity: number;
  creditPoints: number | null;
  maxGain: number | null;
  maxLoss: number | null;
  breakeven: number | null;
  futureSymbol: string;
  f0: number;
  status: PositionStatus;
  exitReason: string | null;
  broker: 'KITE' | 'GROWW' | null;
  legs: EdgeLeg[];
  strategyVersion: string;
}

export interface EdgeStore {
  getSettings(): Promise<EdgeSettings>;
  getSignalForDate(dateISO: string): Promise<SharedSignal | null>;
  listOpenPositions(): Promise<EdgePosition[]>;
  getPositionForWeek(weekKey: string, mode: EdgeMode): Promise<EdgePosition | null>;
  getPosition(id: number): Promise<EdgePosition | null>;
  /** Unique on (weekKey, mode): returns duplicate when this week's position for the mode already exists. */
  createPosition(p: NewPosition): Promise<{ ok: true; position: EdgePosition } | { ok: false; reason: 'duplicate' }>;
  /** When expectStatus is given, updates only if the row currently has that status (exit flag). Returns whether a row changed. */
  updatePosition(id: number, patch: Record<string, unknown>, expectStatus?: PositionStatus): Promise<boolean>;
  updateLeg(id: number, patch: Partial<EdgeLeg>): Promise<void>;
  logEvent(level: 'info' | 'warn' | 'error', mode: EdgeMode | null, positionId: number | null, kind: string, message: string, detail?: unknown): Promise<void>;
}

export interface EdgeMarket {
  isTradingDay(dateISO: string): boolean;
  getVixBars(dateISO: string): Promise<VixBar[]>;
  getSpot(): Promise<number | null>;
  getNearestFuture(): Promise<{ tradingsymbol: string; ltp: number } | null>;
  getFutureLtp(tradingsymbol: string): Promise<number | null>;
  listExpiries(): Promise<string[]>;
  listStrikes(expiry: string): Promise<number[]>;
  kiteSymbol(expiry: string, strike: number, right: 'CE' | 'PE'): Promise<string | null>;
  lotSize(expiry: string): Promise<number | null>;
  getQuotes(kiteSymbols: string[]): Promise<Map<string, Quote>>;
}

export interface EdgeBroker {
  name: 'KITE' | 'GROWW';
  exchange: string;
  placer: LiveOrderPlacer;
  brokerSymbol(expiry: string, strike: number, right: 'CE' | 'PE', kiteSymbol: string): Promise<string | null>;
  /** true if the broker already holds a non-zero position in any of these symbols; null when it cannot be verified. */
  holdsAny(symbols: string[]): Promise<boolean | null>;
  availableFunds(): Promise<number | null>;
}

export interface EdgeDeps {
  store: EdgeStore;
  market: EdgeMarket;
  /** Only consulted for AUTO; null when no live broker session is available. */
  broker: (settings: EdgeSettings) => Promise<EdgeBroker | null>;
  sleep?: (ms: number) => Promise<void>;
}

export interface TickReport { clock: Clock; actions: string[] }

const MAX_EXIT_ATTEMPTS = 5;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const legKey = (l: { side: string; right: string; strike: number }) => `${l.side}:${l.right}:${l.strike}`;

// ------------------------------------------------------------------ tick

export async function runEdgeTick(deps: EdgeDeps, nowMs: number): Promise<TickReport> {
  const clock = istClock(nowMs);
  const actions: string[] = [];
  const settings = await deps.store.getSettings();
  const tradingDay = deps.market.isTradingDay(clock.dateISO);

  // 1. Manage what is already open — always before any new entry.
  for (const pos of await deps.store.listOpenPositions()) {
    try {
      actions.push(...await managePosition(deps, settings, pos, clock, tradingDay, nowMs));
    } catch (err: any) {
      await deps.store.logEvent('error', pos.mode, pos.id, 'MANAGE_ERROR', `Position management failed: ${err.message}`);
    }
  }

  // 2. Entries.
  if (!tradingDay) return { clock, actions };
  const signal = await deps.store.getSignalForDate(clock.dateISO);
  if (!signal) return { clock, actions };

  let decision: EdgeDecision | null = null;
  for (const mode of ['SHADOW', 'AUTO'] as const) {
    const existing = await deps.store.getPositionForWeek(signal.weekKey, mode);
    const block = entryBlock({
      clock, nowMs, isTradingDay: tradingDay, killSwitch: settings.killSwitch,
      modeEnabled: mode === 'SHADOW' ? settings.shadowEnabled : settings.autoEnabled,
      signal, alreadyEnteredThisWeek: !!existing,
    });
    if (block) continue;
    try {
      decision ??= decideDirection(signal, await deps.market.getVixBars(signal.signalDate));
      actions.push(await enter(deps, settings, mode, signal, decision, nowMs));
    } catch (err: any) {
      await deps.store.logEvent('error', mode, null, 'ENTRY_ERROR', `Entry failed: ${err.message}`);
    }
  }
  return { clock, actions };
}

// ------------------------------------------------------------------ entry

interface ResolvedStructure {
  expiry: string; atm: number; strikeStep: number; wingPoints: number; lotSize: number;
  legs: Array<{ legIndex: number; side: 'BUY' | 'SELL'; right: 'CE' | 'PE'; strike: number; kiteSymbol: string }>;
}

async function resolveStructure(deps: EdgeDeps, signal: SharedSignal, direction: Direction): Promise<ResolvedStructure | string> {
  const expiries = await deps.market.listExpiries();
  const chosen = selectExpiry(new Date(`${signal.signalDate}T00:00:00Z`), expiries.map((e) => new Date(`${e}T00:00:00Z`)));
  if (!chosen) return 'no listed expiry after the signal date';
  const expiry = chosen.toISOString().slice(0, 10);
  const strikes = await deps.market.listStrikes(expiry);
  if (strikes.length < 2) return `fewer than two strikes listed for ${expiry}`;
  const spot = await deps.market.getSpot();
  if (!(spot && spot > 0)) return 'no live NIFTY spot';
  const strikeStep = deriveStrikeStep(strikes);
  const atm = selectATM(spot, strikes);
  const legs = resolveCreditSpread(direction, atm, strikeStep, expiry, strikes);
  if (!legs) return `a leg strike is not listed around ATM ${atm} for ${expiry} — structure not created (never substituted)`;
  const lotSize = await deps.market.lotSize(expiry);
  if (!(lotSize && lotSize > 0)) return `no lot size for ${expiry}`;
  const out: ResolvedStructure['legs'] = [];
  for (const [i, l] of legs.entries()) {
    const sym = await deps.market.kiteSymbol(expiry, l.strike, l.right);
    if (!sym) return `no tradingsymbol for ${l.strike}${l.right} ${expiry}`;
    out.push({ legIndex: i, side: l.side, right: l.right, strike: l.strike, kiteSymbol: sym });
  }
  return { expiry, atm, strikeStep, wingPoints: WING_STEPS * strikeStep, lotSize, legs: out };
}

async function recordSkippedWeek(deps: EdgeDeps, mode: EdgeMode, signal: SharedSignal, decision: EdgeDecision, reason: string, futureSymbol = ''): Promise<string> {
  // A FAILED row claims the week so the same failure is not retried and re-logged every minute.
  const created = await deps.store.createPosition({
    mode, weekKey: signal.weekKey, signalId: signal.id, signalDate: signal.signalDate, decision,
    structure: structureLabel(decision.direction), expiry: signal.signalDate, atm: 0, strikeStep: 0, wingPoints: 0,
    units: 0, lotSize: 0, quantity: 0, creditPoints: null, maxGain: null, maxLoss: null, breakeven: null,
    futureSymbol, f0: 0, status: 'FAILED', exitReason: reason, broker: null, legs: [], strategyVersion: STRATEGY_VERSION,
  });
  if (created.ok) await deps.store.logEvent('warn', mode, created.position.id, 'ENTRY_SKIPPED', `${mode}: no entry this week — ${reason}.`);
  return `${mode}: skipped (${reason})`;
}

async function enter(deps: EdgeDeps, settings: EdgeSettings, mode: EdgeMode, signal: SharedSignal, decision: EdgeDecision, nowMs: number): Promise<string> {
  const resolved = await resolveStructure(deps, signal, decision.direction);
  if (typeof resolved === 'string') return recordSkippedWeek(deps, mode, signal, decision, resolved);

  const capital = mode === 'SHADOW' ? settings.shadowCapital : settings.autoCapital;
  const units = computeUnitModeUnits(capital, settings.unitBudget || UNIT_BUDGET_RUPEES);
  if (units === 0) return recordSkippedWeek(deps, mode, signal, decision, `allocation ₹${capital} is below one unit (₹${settings.unitBudget || UNIT_BUDGET_RUPEES})`);
  const quantity = units * resolved.lotSize;

  const future = await deps.market.getNearestFuture();
  if (!future || !(future.ltp > 0)) return `${mode}: waiting — no NIFTY futures price for the monitor (F0)`;

  const quotes = await deps.market.getQuotes(resolved.legs.map((l) => l.kiteSymbol));
  const base = {
    mode, weekKey: signal.weekKey, signalId: signal.id, signalDate: signal.signalDate, decision,
    structure: structureLabel(decision.direction), expiry: resolved.expiry, atm: resolved.atm, strikeStep: resolved.strikeStep,
    wingPoints: resolved.wingPoints, units, lotSize: resolved.lotSize, quantity, futureSymbol: future.tradingsymbol, f0: future.ltp,
    strategyVersion: STRATEGY_VERSION,
  };

  if (mode === 'SHADOW') {
    const fills = resolved.legs.map((l) => ({ l, q: quotes.get(l.kiteSymbol), f: quotes.get(l.kiteSymbol) ? shadowFill(l.side, quotes.get(l.kiteSymbol)!) : null }));
    const missing = fills.find((x) => !x.f);
    if (missing) return `SHADOW: waiting — ${missing.l.side} ${missing.l.kiteSymbol} not marketable at its limit this minute`;
    const legs: EdgeLeg[] = fills.map(({ l, q, f }) => ({
      legIndex: l.legIndex, side: l.side, right: l.right, strike: l.strike, kiteSymbol: l.kiteSymbol, brokerSymbol: l.kiteSymbol,
      quantity, entryLimit: f!.limit, entryFill: f!.fill, entryOrderId: null, exitLimit: null, exitFill: null, exitOrderId: null, lastPrice: q!.ltp,
    }));
    const credit = creditPoints(legs.map((l) => ({ side: l.side, entryFill: l.entryFill! })));
    const risk = spreadRisk(decision.direction, resolved.atm, resolved.wingPoints, credit, quantity);
    const created = await deps.store.createPosition({
      ...base, creditPoints: credit, maxGain: risk.maxGainRupees, maxLoss: risk.maxLossRupees, breakeven: risk.breakeven,
      status: 'ACTIVE', exitReason: null, broker: null, legs,
    });
    if (!created.ok) return 'SHADOW: already entered this week';
    await deps.store.logEvent('info', 'SHADOW', created.position.id, 'POSITION_OPENED',
      `SHADOW ${base.structure}: BUY ${legs[0].strike}${legs[0].right} @ ${legs[0].entryFill} then SELL ${legs[1].strike}${legs[1].right} @ ${legs[1].entryFill} × ${quantity} — credit ${credit.toFixed(2)} pts, max gain ₹${Math.round(risk.maxGainRupees)}, max loss ₹${Math.round(risk.maxLossRupees)}, monitor F0 ${future.ltp}.`,
      { decision, f0: future.ltp });
    return `SHADOW: opened ${base.structure}`;
  }

  // ---------------- AUTO (real orders) ----------------
  const broker = await deps.broker(settings);
  if (!broker) return `AUTO: waiting — no live ${settings.activeBroker} session`;
  const brokerSymbols: string[] = [];
  for (const l of resolved.legs) {
    const s = await broker.brokerSymbol(resolved.expiry, l.strike, l.right, l.kiteSymbol);
    if (!s) return recordSkippedWeek(deps, mode, signal, decision, `no ${broker.name} tradingsymbol for ${l.strike}${l.right}`);
    brokerSymbols.push(s);
  }
  const holds = await broker.holdsAny(brokerSymbols);
  if (holds === null) return `AUTO: waiting — could not verify ${broker.name} positions (fail closed)`;
  if (holds) return recordSkippedWeek(deps, mode, signal, decision, `${broker.name} already holds a position in one of the legs — no order while broker and ledger disagree`);
  const funds = await broker.availableFunds();
  const required = quantity * resolved.wingPoints; // conservative: full wing width, not just margin
  if (funds === null) return `AUTO: waiting — could not read ${broker.name} funds`;
  if (funds < required) return recordSkippedWeek(deps, mode, signal, decision, `available funds ₹${Math.round(funds)} below the ₹${Math.round(required)} spread width`);

  const legs: EdgeLeg[] = resolved.legs.map((l, i) => ({
    legIndex: l.legIndex, side: l.side, right: l.right, strike: l.strike, kiteSymbol: l.kiteSymbol, brokerSymbol: brokerSymbols[i],
    quantity, entryLimit: null, entryFill: null, entryOrderId: null, exitLimit: null, exitFill: null, exitOrderId: null,
    lastPrice: quotes.get(l.kiteSymbol)?.ltp ?? null,
  }));
  // Claim the week BEFORE any order (unique key) so an overlapping tick cannot double-enter.
  const claimed = await deps.store.createPosition({
    ...base, creditPoints: null, maxGain: null, maxLoss: null, breakeven: null,
    status: 'ENTERING', exitReason: null, broker: broker.name, legs,
  });
  if (!claimed.ok) return 'AUTO: already entered this week';
  const pos = claimed.position;
  await deps.store.logEvent('info', 'AUTO', pos.id, 'ENTRY_STARTED', `AUTO ${base.structure} on ${broker.name}: placing the protective BUY first, the ATM SELL only after it fills.`);

  const planned: PlannedLeg[] = legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, tradingsymbol: l.brokerSymbol, quantity, fillPrice: l.lastPrice ?? 0 }));
  const result = await runLiveExecution(planned, { passed: true, checks: [] }, specLimitPlacer(broker.placer, deps.sleep ?? defaultSleep), {
    exchange: broker.exchange, fillTimeoutMs: AUTO_FILL_TIMEOUT_MS, maxRetries: 0,
  });

  const fillsByKey = new Map(result.legFills.map((f) => [legKey(f), f]));
  for (const pl of pos.legs) {
    const f = fillsByKey.get(legKey(pl));
    if (f && f.status === 'FILLED' && pl.id !== undefined) {
      await deps.store.updateLeg(pl.id, { entryFill: f.fillPrice, entryOrderId: f.orderId ?? null });
    }
  }
  const allFilled = pos.legs.every((pl) => fillsByKey.get(legKey(pl))?.status === 'FILLED');
  if (result.state === 'RECONCILIATION_REQUIRED') {
    await deps.store.updatePosition(pos.id, { status: 'RECONCILIATION_REQUIRED', exit_reason: 'ENTRY_STATE_UNKNOWN' });
    await deps.store.logEvent('error', 'AUTO', pos.id, 'RECONCILIATION_REQUIRED', 'AUTO entry: a leg\'s true broker state is unknown — no further orders. Verify the broker manually.', { log: result.log });
    return 'AUTO: reconciliation required';
  }
  if (!allFilled || result.protection !== 'FULL') {
    await deps.store.updatePosition(pos.id, { status: 'FAILED', exit_reason: 'ENTRY_NOT_COMPLETED' });
    await deps.store.logEvent('error', 'AUTO', pos.id, 'ENTRY_FAILED', 'AUTO entry did not complete — any filled leg was unwound by the sequencer. Nothing is left on the book by design; this week is abandoned.', { log: result.log });
    return 'AUTO: entry failed';
  }
  const filledLegs = pos.legs.map((pl) => ({ side: pl.side, entryFill: fillsByKey.get(legKey(pl))!.fillPrice }));
  const credit = creditPoints(filledLegs);
  const risk = spreadRisk(decision.direction, resolved.atm, resolved.wingPoints, credit, quantity);
  await deps.store.updatePosition(pos.id, {
    status: 'ACTIVE', credit_points: credit, max_gain: risk.maxGainRupees, max_loss: risk.maxLossRupees, breakeven: risk.breakeven,
  });
  await deps.store.logEvent('info', 'AUTO', pos.id, 'POSITION_OPENED',
    `AUTO ${base.structure} filled on ${broker.name} × ${quantity}: credit ${credit.toFixed(2)} pts, max loss ₹${Math.round(risk.maxLossRupees)}.`, { log: result.log, decision });
  return `AUTO: opened ${base.structure}`;
}

/** Spec §8.1 pricing for real entry orders: a fresh LTP re-read right before placement, limit = LTP ± max(8%, ₹3) to the tick, plus the 750 ms inter-leg spacing before the short. */
export function specLimitPlacer(inner: LiveOrderPlacer, sleep: (ms: number) => Promise<void>): LiveOrderPlacer {
  return {
    ...inner,
    async placeOrder(leg, exchange, transactionType, referencePrice) {
      if (transactionType === 'SELL') await sleep(INTER_LEG_SPACING_MS);
      const q = await inner.getQuote(leg.tradingsymbol, exchange);
      const ltp = q && q.lastPrice > 0 ? q.lastPrice : referencePrice;
      return inner.placeOrder(leg, exchange, transactionType, specLimit(transactionType, ltp));
    },
  };
}

// ------------------------------------------------------------------ manage / exit

async function managePosition(deps: EdgeDeps, settings: EdgeSettings, pos: EdgePosition, clock: Clock, tradingDay: boolean, nowMs: number): Promise<string[]> {
  const quotes = await deps.market.getQuotes(pos.legs.map((l) => l.kiteSymbol));
  for (const l of pos.legs) {
    const q = quotes.get(l.kiteSymbol);
    if (q && l.id !== undefined) await deps.store.updateLeg(l.id, { lastPrice: q.ltp });
  }

  if (pos.status === 'ACTIVE') {
    const futureLtp = await deps.market.getFutureLtp(pos.futureSymbol);
    const marks = pos.legs.map((l) => {
      const q = quotes.get(l.kiteSymbol);
      return { side: l.side, quantity: l.quantity, entryFill: l.entryFill ?? 0, exitPrice: q ? midPrice(q) : (l.entryFill ?? 0) };
    });
    await deps.store.updatePosition(pos.id, {
      unrealized_pnl: totalPnl(marks), last_future: futureLtp, marked_at: new Date(nowMs).toISOString(),
    });
    const check = exitCheck({ clock, isTradingDay: tradingDay, direction: pos.direction, f0: pos.f0, expiry: pos.expiry, futureLtp });
    if (!check.exit) return [];
    const claimed = await deps.store.updatePosition(pos.id, { status: 'EXITING', exit_reason: check.reason }, 'ACTIVE');
    if (!claimed) return [];
    await deps.store.logEvent('info', pos.mode, pos.id, 'EXIT_TRIGGERED',
      check.reason === 'TARGET_HIT' ? `Monitor target hit: future ${futureLtp} reached ${check.target} (F0 ${pos.f0}).`
        : check.reason === 'EXPIRED' ? 'Expiry passed with the position still open — settling at intrinsic value.'
          : `${check.reason === 'SAFETY_EXIT' ? 'Safety-net' : 'Scheduled'} exit on expiry day.`);
    return [await executeExit(deps, settings, { ...pos, status: 'EXITING', exitReason: check.reason }, quotes, nowMs)];
  }
  if (pos.status === 'EXITING') return [await executeExit(deps, settings, pos, quotes, nowMs)];
  return [];
}

/** Operator exit from the dashboard. */
export async function closePositionManually(deps: EdgeDeps, positionId: number, nowMs: number): Promise<{ ok: boolean; message: string }> {
  const pos = await deps.store.getPosition(positionId);
  if (!pos) return { ok: false, message: 'Position not found.' };
  if (pos.status === 'ACTIVE') {
    const claimed = await deps.store.updatePosition(pos.id, { status: 'EXITING', exit_reason: 'MANUAL' }, 'ACTIVE');
    if (!claimed) return { ok: false, message: 'Another process is already exiting this position.' };
    await deps.store.logEvent('info', pos.mode, pos.id, 'EXIT_TRIGGERED', 'Manual exit requested from the dashboard.');
  } else if (pos.status !== 'EXITING') {
    return { ok: false, message: `Position is ${pos.status}, not open.` };
  }
  const settings = await deps.store.getSettings();
  const quotes = await deps.market.getQuotes(pos.legs.map((l) => l.kiteSymbol));
  const message = await executeExit(deps, settings, { ...pos, status: 'EXITING', exitReason: pos.exitReason ?? 'MANUAL' }, quotes, nowMs);
  return { ok: true, message };
}

async function executeExit(deps: EdgeDeps, settings: EdgeSettings, pos: EdgePosition, quotes: Map<string, Quote>, nowMs: number): Promise<string> {
  const short = pos.legs.find((l) => l.side === 'SELL')!;
  const wing = pos.legs.find((l) => l.side === 'BUY')!;
  const reason = (pos.exitReason ?? 'MANUAL') as ExitReason;

  // Expiry already passed: the exchange settled both legs; record intrinsic value.
  if (reason === 'EXPIRED') {
    const spot = (await deps.market.getSpot()) ?? pos.atm;
    for (const l of [short, wing]) if (l.exitFill === null && l.id !== undefined) {
      l.exitFill = intrinsic(l.right, l.strike, spot);
      await deps.store.updateLeg(l.id, { exitFill: l.exitFill });
    }
    return finalize(deps, pos, nowMs, `settled at expiry (index ${spot})`);
  }

  // Shorts first. The wing is never sold while the short is open.
  if (short.exitFill === null) {
    const done = await closeLeg(deps, settings, pos, short, quotes, 'BUY');
    if (done !== 'FILLED') return done;
  }
  if (wing.exitFill === null) {
    const done = await closeLeg(deps, settings, pos, wing, quotes, 'SELL');
    if (done !== 'FILLED') return done;
  }
  return finalize(deps, pos, nowMs, reason);
}

async function closeLeg(deps: EdgeDeps, settings: EdgeSettings, pos: EdgePosition, leg: EdgeLeg, quotes: Map<string, Quote>, action: 'BUY' | 'SELL'): Promise<'FILLED' | string> {
  if (pos.mode === 'SHADOW') {
    const q = quotes.get(leg.kiteSymbol);
    const f = q ? shadowFill(action, q) : null;
    if (f) {
      leg.exitFill = f.fill; leg.exitLimit = f.limit;
      if (leg.id !== undefined) await deps.store.updateLeg(leg.id, { exitFill: f.fill, exitLimit: f.limit });
      return 'FILLED';
    }
    // A long wing with no bid at all on the final exit is worthless — abandon it at 0 rather than hold forever.
    if (action === 'SELL' && (pos.exitReason === 'SAFETY_EXIT') && (!q || !q.bid)) {
      leg.exitFill = 0;
      if (leg.id !== undefined) await deps.store.updateLeg(leg.id, { exitFill: 0 });
      return 'FILLED';
    }
    return `SHADOW #${pos.id}: ${action} ${leg.kiteSymbol} not marketable this minute — retrying next tick`;
  }

  // AUTO — real close order through the broker that holds the position.
  const broker = await deps.broker(settings);
  if (!broker || broker.name !== pos.broker) return `AUTO #${pos.id}: waiting for a live ${pos.broker} session to close ${leg.brokerSymbol}`;
  const planned: PlannedLeg = { side: leg.side, right: leg.right, strike: leg.strike, tradingsymbol: leg.brokerSymbol, quantity: leg.quantity, fillPrice: leg.lastPrice ?? 0 };
  let orderId: string;
  try {
    orderId = await broker.placer.closeLeg(planned, broker.exchange);
  } catch (err: any) {
    return bumpExitAttempt(deps, pos, `close request for ${leg.brokerSymbol} failed: ${err.message}`);
  }
  let outcome = await broker.placer.awaitFill(orderId, AUTO_FILL_TIMEOUT_MS);
  if (outcome.status === 'TIMEOUT') {
    const s = await broker.placer.getOrderStatus(orderId).catch(() => ({ status: 'UNKNOWN' as const, averagePrice: null }));
    if (s.status === 'COMPLETE') outcome = { status: 'COMPLETE', averagePrice: s.averagePrice };
    else if (s.status !== 'REJECTED' && s.status !== 'CANCELLED') {
      await deps.store.updatePosition(pos.id, { status: 'CLOSE_FAILED' });
      await deps.store.logEvent('error', 'AUTO', pos.id, 'CLOSE_STATE_UNKNOWN', `Close order ${orderId} for ${leg.brokerSymbol} is ${s.status} — state unknown, stopped without retrying. Verify on ${pos.broker} now.`);
      return `AUTO #${pos.id}: close state unknown — stopped`;
    }
  }
  if (outcome.status === 'COMPLETE' && outcome.averagePrice !== null) {
    leg.exitFill = outcome.averagePrice;
    if (leg.id !== undefined) await deps.store.updateLeg(leg.id, { exitFill: outcome.averagePrice, exitOrderId: orderId });
    return 'FILLED';
  }
  return bumpExitAttempt(deps, pos, `close order for ${leg.brokerSymbol} ended ${outcome.status}`);
}

async function bumpExitAttempt(deps: EdgeDeps, pos: EdgePosition, why: string): Promise<string> {
  const attempts = pos.exitAttempts + 1;
  if (attempts >= MAX_EXIT_ATTEMPTS) {
    await deps.store.updatePosition(pos.id, { status: 'CLOSE_FAILED', exit_attempts: attempts });
    await deps.store.logEvent('error', pos.mode, pos.id, 'CLOSE_FAILED', `Exit gave up after ${attempts} attempts (${why}). Protective legs are left open on purpose — close manually.`);
    return `#${pos.id}: CLOSE_FAILED`;
  }
  await deps.store.updatePosition(pos.id, { exit_attempts: attempts });
  await deps.store.logEvent('warn', pos.mode, pos.id, 'EXIT_RETRY', `Exit attempt ${attempts}/${MAX_EXIT_ATTEMPTS} did not complete (${why}); retrying next tick.`);
  return `#${pos.id}: exit retry ${attempts}`;
}

async function finalize(deps: EdgeDeps, pos: EdgePosition, nowMs: number, note: string): Promise<string> {
  const realized = totalPnl(pos.legs.map((l) => ({ side: l.side, quantity: l.quantity, entryFill: l.entryFill ?? 0, exitPrice: l.exitFill ?? 0 })));
  await deps.store.updatePosition(pos.id, { status: 'CLOSED', realized_pnl: realized, unrealized_pnl: 0, closed_at: new Date(nowMs).toISOString() });
  await deps.store.logEvent('info', pos.mode, pos.id, 'POSITION_CLOSED', `${pos.mode} #${pos.id} closed (${note}): realized ₹${Math.round(realized)}.`);
  return `${pos.mode} #${pos.id}: closed ₹${Math.round(realized)}`;
}
