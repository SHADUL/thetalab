/**
 * Paper broker + position marking + exit rules.
 *
 * PAPER ONLY. This module has no network access of any kind — it imports no
 * HTTP client and calls no broker API. Every fill it produces is labelled
 * PAPER_FILL and must never be presented as an exchange fill.
 *
 * P&L definitions (consistent with the baseline cost model):
 *   closingDebitPts = short ask + slip − (long bid − slip)
 *   grossPnl        = (creditPts − closingDebitPts) × qty
 *   markedNet       = grossPnl − roundTripCost        (FLAT ₹150 by default)
 *
 * Exits (checked in this order):
 *   STOP_LOSS      markedNet ≤ −stopLoss% × grossCredit
 *   PROFIT_TARGET  markedNet ≥ +target%   × grossCredit
 *   TIME_EXIT      held ≥ maxHoldSec
 * A forced exit (flatten / kill switch / session end) bypasses the rules.
 *
 * If either leg's quote is missing or stale, the position cannot be marked:
 * SL/TP are not evaluated on made-up prices, and a due exit becomes
 * PENDING_EXIT until both legs are priceable again.
 */
import type { ChainSnapshot } from './chain.ts';
import type { PulseConfig } from './config.ts';
import { configKey } from './config.ts';
import { orderCharges, sumCosts, type CostBreakdown } from './costs.ts';
import type { SpreadCandidate, SpreadKind } from './spreads.ts';

export type ExitReason = 'STOP_LOSS' | 'PROFIT_TARGET' | 'TIME_EXIT' | 'MANUAL_FLATTEN' | 'KILL_SWITCH' | 'SESSION_END';

export interface PaperFill {
  kind: 'PAPER_FILL';
  leg: 'SHORT' | 'LONG';
  side: 'BUY' | 'SELL';
  tradingsymbol: string;
  qty: number;
  price: number;
  /** Quote side the fill was priced from. */
  basis: 'BID' | 'ASK';
  slippagePts: number;
  at: number;
}

export interface PositionEvent { at: number; type: string; detail: string }

export interface PositionMark {
  at: number;
  priced: boolean;
  closingDebitPts: number | null;
  grossPnl: number | null;
  markedNet: number | null;
  shortAsk: number | null;
  longBid: number | null;
  reason: string | null;
}

export interface PaperPosition {
  id: string;
  tradeNo: number;
  configKey: string;
  configName: string;
  dataMode: 'LIVE_PAPER' | 'SIMULATION';
  direction: 'BULLISH' | 'BEARISH';
  kind: SpreadKind;
  expiry: string;
  short: { strike: number; right: 'CE' | 'PE'; tradingsymbol: string };
  long: { strike: number; right: 'CE' | 'PE'; tradingsymbol: string };
  qty: number;
  lots: number;
  lotSize: number;
  widthPts: number;
  entryAt: number;
  entryShort: number;
  entryLong: number;
  creditPts: number;
  grossCredit: number;
  costModel: 'FLAT' | 'DETAILED';
  roundTripCost: number;
  entryFeesDetailed: CostBreakdown;
  maxLoss: number;
  targetPnl: number;
  stopPnl: number;
  entryReason: string;
  signal: { price: number; r5: number; r15: number; ma60: number; ups: number; downs: number };
  status: 'OPEN' | 'PENDING_EXIT' | 'CLOSED';
  mark: PositionMark | null;
  pendingExit: { reason: ExitReason; since: number } | null;
  exitAt: number | null;
  exitShort: number | null;
  exitLong: number | null;
  closingDebitPts: number | null;
  exitFeesDetailed: CostBreakdown | null;
  realizedGross: number | null;
  realizedNet: number | null;
  exitReason: ExitReason | null;
  holdSec: number | null;
  fills: PaperFill[];
  events: PositionEvent[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function openPaperPosition(args: {
  cand: SpreadCandidate; direction: 'BULLISH' | 'BEARISH'; config: PulseConfig; at: number; tradeNo: number;
  dataMode: 'LIVE_PAPER' | 'SIMULATION'; entryReason: string;
  signal: PaperPosition['signal'];
}): PaperPosition {
  const { cand, config: c, at } = args;
  if (c.paperOnly !== true) throw new Error('paper broker refuses a non-paper config');
  if (!cand.eligible || cand.shortEntry == null || cand.longEntry == null || cand.creditPts == null || cand.grossCredit == null || cand.maxLoss == null || cand.roundTripCost == null) {
    throw new Error('paper broker refuses an ineligible or unpriced candidate');
  }
  const fills: PaperFill[] = [
    { kind: 'PAPER_FILL', leg: 'SHORT', side: 'SELL', tradingsymbol: cand.short.tradingsymbol, qty: cand.qty, price: cand.shortEntry, basis: 'BID', slippagePts: c.slippagePtsPerLeg, at },
    { kind: 'PAPER_FILL', leg: 'LONG', side: 'BUY', tradingsymbol: cand.long.tradingsymbol, qty: cand.qty, price: cand.longEntry, basis: 'ASK', slippagePts: c.slippagePtsPerLeg, at },
  ];
  const grossCredit = cand.grossCredit;
  return {
    id: `NP-${args.dataMode === 'SIMULATION' ? 'SIM-' : ''}${String(args.tradeNo).padStart(4, '0')}`,
    tradeNo: args.tradeNo,
    configKey: configKey(c),
    configName: c.name,
    dataMode: args.dataMode,
    direction: args.direction,
    kind: cand.kind,
    expiry: cand.expiry,
    short: { strike: cand.short.strike, right: cand.short.right, tradingsymbol: cand.short.tradingsymbol },
    long: { strike: cand.long.strike, right: cand.long.right, tradingsymbol: cand.long.tradingsymbol },
    qty: cand.qty, lots: cand.lots, lotSize: cand.lotSize, widthPts: cand.widthPts,
    entryAt: at, entryShort: cand.shortEntry, entryLong: cand.longEntry,
    creditPts: cand.creditPts, grossCredit,
    costModel: c.costModel, roundTripCost: cand.roundTripCost,
    entryFeesDetailed: cand.entryCostsDetailed!,
    maxLoss: cand.maxLoss,
    targetPnl: r2(grossCredit * c.profitTargetPctOfCredit / 100),
    stopPnl: r2(-grossCredit * c.stopLossPctOfCredit / 100),
    entryReason: args.entryReason,
    signal: args.signal,
    status: 'OPEN', mark: null, pendingExit: null,
    exitAt: null, exitShort: null, exitLong: null, closingDebitPts: null, exitFeesDetailed: null,
    realizedGross: null, realizedNet: null, exitReason: null, holdSec: null,
    fills,
    events: [{ at, type: 'PAPER_FILL', detail: `SELL ${cand.qty} ${cand.short.tradingsymbol} @ ${cand.shortEntry.toFixed(2)} (bid − slip) · BUY ${cand.qty} ${cand.long.tradingsymbol} @ ${cand.longEntry.toFixed(2)} (ask + slip)` }],
  };
}

export function markPosition(p: PaperPosition, chain: ChainSnapshot, c: PulseConfig): PositionMark {
  const sq = chain.quote(p.short.strike, p.short.right);
  const lq = chain.quote(p.long.strike, p.long.right);
  const now = chain.at;
  const fresh = (ts: number | null | undefined) => ts != null && now - ts <= c.quoteFreshnessMs;
  let reason: string | null = null;
  if (!sq || !lq) reason = 'Option quote missing';
  else if (!fresh(sq.ts) || !fresh(lq.ts)) reason = 'Option quote stale';
  else if (!((sq.ask ?? 0) > 0) || !((lq.bid ?? 0) > 0)) reason = 'Closing side of the book is empty';
  if (reason) return { at: now, priced: false, closingDebitPts: null, grossPnl: null, markedNet: null, shortAsk: sq?.ask ?? null, longBid: lq?.bid ?? null, reason };
  const shortExit = sq!.ask! + c.slippagePtsPerLeg;
  const longExit = Math.max(0, lq!.bid! - c.slippagePtsPerLeg);
  const closingDebitPts = r2(shortExit - longExit);
  const grossPnl = r2((p.creditPts - closingDebitPts) * p.qty);
  return { at: now, priced: true, closingDebitPts, grossPnl, markedNet: r2(grossPnl - p.roundTripCost), shortAsk: sq!.ask!, longBid: lq!.bid!, reason: null };
}

/** Which rule (if any) wants this position closed now. */
export function exitDue(p: PaperPosition, mark: PositionMark, now: number, c: PulseConfig, forced: ExitReason | null): ExitReason | null {
  if (forced) return forced;
  if (mark.priced && mark.markedNet != null) {
    if (mark.markedNet <= p.stopPnl) return 'STOP_LOSS';
    if (mark.markedNet >= p.targetPnl) return 'PROFIT_TARGET';
  }
  if (now - p.entryAt >= c.maxHoldSec * 1000) return 'TIME_EXIT';
  return null;
}

/**
 * Advance one position by one evaluation. Returns the updated position
 * (a new object; the input is not mutated).
 */
export function stepPosition(p: PaperPosition, chain: ChainSnapshot, c: PulseConfig, forced: ExitReason | null = null): PaperPosition {
  if (p.status === 'CLOSED') return p;
  const now = chain.at;
  const mark = markPosition(p, chain, c);
  const next: PaperPosition = { ...p, mark: mark.priced ? mark : { ...mark, closingDebitPts: p.mark?.closingDebitPts ?? null, grossPnl: p.mark?.grossPnl ?? null, markedNet: p.mark?.markedNet ?? null }, events: p.events };
  const due = p.pendingExit?.reason ?? exitDue(p, mark, now, c, forced);
  if (!due) return next;
  if (!mark.priced) {
    if (!p.pendingExit) {
      next.status = 'PENDING_EXIT';
      next.pendingExit = { reason: due, since: now };
      next.events = [...p.events, { at: now, type: 'PENDING_EXIT', detail: `${due} due but ${mark.reason?.toLowerCase()} — no fill assumed; waiting for valid prices` }];
    }
    return next;
  }
  return closeAt(next, mark, due, now, c);
}

function closeAt(p: PaperPosition, mark: PositionMark, reason: ExitReason, now: number, c: PulseConfig): PaperPosition {
  const shortExit = r2(mark.shortAsk! + c.slippagePtsPerLeg);
  const longExit = r2(Math.max(0, mark.longBid! - c.slippagePtsPerLeg));
  const fills: PaperFill[] = [
    ...p.fills,
    { kind: 'PAPER_FILL', leg: 'SHORT', side: 'BUY', tradingsymbol: p.short.tradingsymbol, qty: p.qty, price: shortExit, basis: 'ASK', slippagePts: c.slippagePtsPerLeg, at: now },
    { kind: 'PAPER_FILL', leg: 'LONG', side: 'SELL', tradingsymbol: p.long.tradingsymbol, qty: p.qty, price: longExit, basis: 'BID', slippagePts: c.slippagePtsPerLeg, at: now },
  ];
  const exitFeesDetailed = sumCosts([orderCharges('BUY', shortExit, p.qty), orderCharges('SELL', longExit, p.qty)]);
  const closingDebitPts = r2(shortExit - longExit);
  const realizedGross = r2((p.creditPts - closingDebitPts) * p.qty);
  const realizedNet = r2(realizedGross - p.roundTripCost);
  const wasPending = p.pendingExit ? ` (pending since ${Math.round((now - p.pendingExit.since) / 1000)}s)` : '';
  return {
    ...p,
    status: 'CLOSED', pendingExit: null,
    exitAt: now, exitShort: shortExit, exitLong: longExit, closingDebitPts, exitFeesDetailed,
    realizedGross, realizedNet, exitReason: reason, holdSec: Math.round((now - p.entryAt) / 1000),
    fills,
    events: [...p.events, { at: now, type: 'PAPER_FILL', detail: `${reason}${wasPending}: BUY ${p.qty} ${p.short.tradingsymbol} @ ${shortExit.toFixed(2)} (ask + slip) · SELL ${p.qty} ${p.long.tradingsymbol} @ ${longExit.toFixed(2)} (bid − slip) · net ${realizedNet >= 0 ? '+' : '−'}₹${Math.abs(realizedNet).toFixed(0)}` }],
  };
}
