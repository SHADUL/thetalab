/**
 * Pure lifecycle rules for one hedged131 position: when an entry is
 * allowed, when an exit is due, how SHADOW fills are simulated, and P&L.
 * No I/O — the engine supplies clock, quotes and state.
 */
import { nowIST } from '../nifty-alpha-ladder/calendar/istClock.ts';
import { weekdayOf } from '../nifty-alpha-ladder/calendar/signalCalendar.ts';
import { targetHit, effectiveTarget, targetProgress } from '../nifty-alpha-ladder/monitor/futuresMonitor.ts';
import { marketableLimitPrice } from '../nifty-alpha-ladder/execution/marketableLimit.ts';
import type { Direction } from '../nifty-alpha-ladder/types.ts';
import {
  ENTRY_GRACE_MIN, MARKET_CLOSE_MIN, MARKET_OPEN_MIN, OPTION_TICK, SAFETY_EXIT_MIN, SCHEDULED_EXIT_MIN,
} from './parameters.ts';

export type EdgeMode = 'SHADOW' | 'AUTO';
export type PositionStatus = 'ENTERING' | 'ACTIVE' | 'EXITING' | 'CLOSED' | 'FAILED' | 'CLOSE_FAILED' | 'RECONCILIATION_REQUIRED';
export type ExitReason = 'TARGET_HIT' | 'SCHEDULED_EXIT' | 'SAFETY_EXIT' | 'EXPIRED' | 'MANUAL';

export interface Clock {
  dateISO: string;
  minutes: number;
  weekday: ReturnType<typeof weekdayOf>;
}

export function istClock(nowMs: number): Clock {
  const { dateISO, minutesSinceMidnight } = nowIST(nowMs);
  return { dateISO, minutes: minutesSinceMidnight, weekday: weekdayOf(new Date(`${dateISO}T00:00:00Z`)) };
}

export const inMarketHours = (c: Clock) => c.minutes >= MARKET_OPEN_MIN && c.minutes <= MARKET_CLOSE_MIN;

// ---------------------------------------------------------------- entry

export type EntryBlock =
  | 'NOT_TRADING_DAY' | 'OUTSIDE_MARKET_HOURS' | 'NO_SIGNAL_THIS_WEEK' | 'SIGNAL_NOT_TODAY'
  | 'ENTRY_WINDOW_PASSED' | 'ALREADY_ENTERED_THIS_WEEK' | 'MODE_DISABLED' | 'KILL_SWITCH';

export function entryBlock(input: {
  clock: Clock; nowMs: number; isTradingDay: boolean; modeEnabled: boolean; killSwitch: boolean;
  signal: { signalDate: string; createdAtMs: number } | null; alreadyEnteredThisWeek: boolean;
}): EntryBlock | null {
  if (input.killSwitch) return 'KILL_SWITCH';
  if (!input.modeEnabled) return 'MODE_DISABLED';
  if (!input.isTradingDay) return 'NOT_TRADING_DAY';
  if (!inMarketHours(input.clock)) return 'OUTSIDE_MARKET_HOURS';
  if (!input.signal) return 'NO_SIGNAL_THIS_WEEK';
  if (input.alreadyEnteredThisWeek) return 'ALREADY_ENTERED_THIS_WEEK';
  if (input.signal.signalDate !== input.clock.dateISO) return 'SIGNAL_NOT_TODAY';
  if (input.nowMs - input.signal.createdAtMs > ENTRY_GRACE_MIN * 60_000) return 'ENTRY_WINDOW_PASSED';
  return null;
}

// ---------------------------------------------------------------- exit

export interface ExitCheckInput {
  clock: Clock;
  isTradingDay: boolean;
  direction: Direction;
  f0: number;
  expiry: string;
  futureLtp: number | null;
}

export interface ExitCheck {
  exit: boolean;
  reason: ExitReason | null;
  target: number;
}

/**
 * Triggers in time order (spec §11): monitor target (futures ticks inside
 * 09:15–15:30 only), scheduled force-exit at 15:10 on the expiry day,
 * safety net from 15:20. A position still open after its expiry date is
 * EXPIRED (the exchange settled it). No stop exists by design.
 */
export function exitCheck(input: ExitCheckInput): ExitCheck {
  const { clock } = input;
  const state = { direction: input.direction, f0: input.f0 };
  const target = effectiveTarget(state, clock.weekday);
  if (clock.dateISO > input.expiry) return { exit: true, reason: 'EXPIRED', target };
  if (!input.isTradingDay || !inMarketHours(clock)) return { exit: false, reason: null, target };
  if (input.futureLtp !== null && input.futureLtp > 0 && targetHit(state, input.futureLtp, clock.weekday)) {
    return { exit: true, reason: 'TARGET_HIT', target };
  }
  if (clock.dateISO === input.expiry && clock.minutes >= SAFETY_EXIT_MIN) return { exit: true, reason: 'SAFETY_EXIT', target };
  if (clock.dateISO === input.expiry && clock.minutes >= SCHEDULED_EXIT_MIN) return { exit: true, reason: 'SCHEDULED_EXIT', target };
  return { exit: false, reason: null, target };
}

export function monitorProgress(direction: Direction, f0: number, futureLtp: number, clock: Clock) {
  return targetProgress({ direction, f0 }, futureLtp, clock.weekday);
}

// ---------------------------------------------------------------- SHADOW fills

export interface Quote { ltp: number; bid: number | null; ask: number | null }

/**
 * Marketable-limit SHADOW fill against the real touch (spec §8.1): the limit
 * is LTP ± max(8%·LTP, ₹3) rounded outward to the tick; a BUY fills at the
 * ask only if ask ≤ limit, a SELL at the bid only if bid ≥ limit. Never
 * assumes a fill at LTP. Returns null when the touch is not marketable.
 */
/** Marketable limit (spec §8.1) expressed in whole paise, so float tick arithmetic never leaks into prices. */
export function specLimit(side: 'BUY' | 'SELL', ltp: number): number {
  return Math.round(marketableLimitPrice(side, ltp, OPTION_TICK) * 100) / 100;
}

export function shadowFill(side: 'BUY' | 'SELL', q: Quote): { limit: number; fill: number } | null {
  if (!(q.ltp > 0)) return null;
  const limit = specLimit(side, q.ltp);
  if (side === 'BUY') return q.ask !== null && q.ask > 0 && q.ask <= limit ? { limit, fill: q.ask } : null;
  return q.bid !== null && q.bid > 0 && q.bid >= limit ? { limit, fill: q.bid } : null;
}

// ---------------------------------------------------------------- P&L

export interface LegPnlInput { side: 'BUY' | 'SELL'; quantity: number; entryFill: number; exitPrice: number }

export function legPnl(l: LegPnlInput): number {
  return (l.side === 'SELL' ? l.entryFill - l.exitPrice : l.exitPrice - l.entryFill) * l.quantity;
}

export function totalPnl(legs: LegPnlInput[]): number {
  return legs.reduce((s, l) => s + legPnl(l), 0);
}

/** Net credit per unit in points: short premium received minus wing premium paid. */
export function creditPoints(legs: Array<{ side: 'BUY' | 'SELL'; entryFill: number }>): number {
  return legs.reduce((s, l) => s + (l.side === 'SELL' ? l.entryFill : -l.entryFill), 0);
}

export function midPrice(q: Quote): number {
  return q.bid && q.ask && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.ltp;
}

/** Intrinsic value of an option at expiry (used only to settle a position the exchange already expired). */
export function intrinsic(right: 'CE' | 'PE', strike: number, spot: number): number {
  return right === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}
