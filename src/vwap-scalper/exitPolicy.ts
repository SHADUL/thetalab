/**
 * The ONE shared exit-policy core (VWAP_SCALPER_AUDIT.md §2.13/§3.4) —
 * before this file existed, `handleVwapScalperMonitor` (live) and
 * `evaluateVwapScalperExit` (backtest-shaped, targetAndStop.ts) each
 * independently implemented target/stop/tie-break logic. They happened to
 * agree, but nothing enforced that, and Phase 2's own explicit warning is
 * "do NOT maintain one strategy in live code and a different one in
 * backtest." This module is the fix: ONE pure function, fed a small,
 * deliberately generic price-observation shape that both a live tick and
 * a historical OHLC bar can populate.
 *
 * Priority/tie-break policy (owned here, nowhere else): STOP is checked
 * BEFORE target. If both would trigger from the same observation, STOP
 * wins — the same conservative "assume the worse outcome when genuinely
 * ambiguous" discipline this codebase's options backtest engine already
 * uses for ambiguous same-bar fills. This is now the ONLY place that
 * policy is expressed.
 */
import type { Direction } from './types.ts';

export type ExitDecision = 'HOLD' | 'STOP' | 'TARGET' | 'SESSION_END';

/**
 * A generic "what did we observe this check" shape — live supplies a
 * single tick collapsed to high=low=last=ltp; backtest supplies a real
 * bar's high/low/close. Either way, `high`/`low` are what "did price
 * reach this level" is tested against, and `last` is the fallback exit
 * price used ONLY for a SESSION_END exit (there's no trigger level to
 * exit AT — the position closes at whatever price was last observed).
 */
export interface PriceObservation {
  high: number;
  low: number;
  last: number;
}

export interface ExitPolicyInput {
  direction: Direction;
  /** Null stop never triggers a STOP exit — only the target (and session-end) matter, same as before. */
  stopPrice: number | null;
  /** Already resolved by computeEffectiveTarget (VWAP vs. the min-reward floor) — this module doesn't recompute it, just applies it. */
  effectiveTarget: number;
  observation: PriceObservation;
  sessionEnded: boolean;
}

export interface ExitPolicyResult {
  decision: ExitDecision;
  /** Null exactly when decision is HOLD. */
  exitPrice: number | null;
}

const HOLD_RESULT: ExitPolicyResult = { decision: 'HOLD', exitPrice: null };

export function evaluateExitPolicy(input: ExitPolicyInput): ExitPolicyResult {
  const { direction, stopPrice, effectiveTarget, observation } = input;

  const stopHit = stopPrice !== null && (direction === 'LONG' ? observation.low <= stopPrice : observation.high >= stopPrice);
  if (stopHit) return { decision: 'STOP', exitPrice: stopPrice! };

  const targetHit = direction === 'LONG' ? observation.high >= effectiveTarget : observation.low <= effectiveTarget;
  if (targetHit) return { decision: 'TARGET', exitPrice: effectiveTarget };

  if (input.sessionEnded) return { decision: 'SESSION_END', exitPrice: observation.last };

  return HOLD_RESULT;
}

/** Builds a PriceObservation from a single live tick — high=low=last=ltp, since a live poll only ever observes one instantaneous price, never a range. */
export function observationFromLiveTick(ltp: number): PriceObservation {
  return { high: ltp, low: ltp, last: ltp };
}

/** Builds a PriceObservation from a historical OHLC bar — the real high/low the bar actually traded through, close as the fallback/session-end price. */
export function observationFromBar(bar: { h: number; l: number; c: number }): PriceObservation {
  return { high: bar.h, low: bar.l, last: bar.c };
}
