/**
 * Target and stop-loss evaluation for an OPEN position — Sections 4/5 of
 * the reference doc.
 *
 * Target: VWAP by default, re-evaluated every bar since VWAP keeps moving
 * (Section 4: "the limit price is resubmitted every bar to the current
 * VWAP, so the exit order tracks VWAP as it moves") — LONG exits when
 * high >= that bar's own VWAP, SHORT when low <= that bar's own VWAP.
 *
 * Optionally floored at a minimum reward-to-risk multiple (e.g. "at least
 * 1:2"): when a real stop and a minRewardMultiple are both supplied, the
 * effective target becomes whichever is FARTHER from entry (more
 * favorable) between VWAP and entry ± minRewardMultiple × riskPerUnit —
 * see computeEffectiveTarget. A pure VWAP-only target (the original
 * behavior) is what you get when either is omitted; this is additive, not
 * a replacement.
 *
 * Stop: fixed at entry time, not trailed (Section 5) — LONG stops when
 * low <= stopPrice, SHORT when high >= stopPrice.
 *
 * When both trigger on the SAME bar, this reports STOP — a conservative,
 * stated assumption (without tick data there's no way to know which was
 * actually touched first intrabar; assuming the worse outcome is the
 * same discipline this codebase's options backtest engine already uses
 * for ambiguous same-bar fills).
 */
import type { Bar, Direction, VwapBandsPoint } from './types.ts';

export interface VwapScalperExitEvaluation {
  exited: boolean;
  reason: 'TARGET' | 'STOP' | null;
  exitPrice: number | null;
  /** Index into the barsSinceEntry array passed in, not the original full-session array. */
  exitBarIndex: number | null;
}

const NOT_EXITED: VwapScalperExitEvaluation = { exited: false, reason: null, exitPrice: null, exitBarIndex: null };

/**
 * The target for THIS bar: plain VWAP unless a real stop AND a positive
 * minRewardMultiple are both available (there's no risk-per-unit to floor
 * against otherwise — falls back to VWAP, never fabricates a distance).
 * When both are available, takes whichever is farther from entry between
 * VWAP and the minimum-reward level — VWAP when the mean-reversion move
 * is large, the R-multiple floor when VWAP alone would fall short of it.
 */
export function computeEffectiveTarget(
  direction: Direction,
  entryPrice: number | null,
  stopPrice: number | null,
  currentVwap: number,
  minRewardMultiple: number | null = null,
): number {
  if (entryPrice === null || stopPrice === null || minRewardMultiple === null || !(minRewardMultiple > 0)) return currentVwap;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (!(riskPerUnit > 0)) return currentVwap;
  const minRewardTarget = direction === 'LONG' ? entryPrice + minRewardMultiple * riskPerUnit : entryPrice - minRewardMultiple * riskPerUnit;
  return direction === 'LONG' ? Math.max(currentVwap, minRewardTarget) : Math.min(currentVwap, minRewardTarget);
}

export function evaluateVwapScalperExit(
  direction: Direction,
  stopPrice: number | null,
  barsSinceEntry: Bar[],
  bandsSinceEntry: VwapBandsPoint[],
  entryPrice: number | null = null,
  minRewardMultiple: number | null = null,
): VwapScalperExitEvaluation {
  for (let i = 0; i < barsSinceEntry.length; i++) {
    const bar = barsSinceEntry[i];
    const target = computeEffectiveTarget(direction, entryPrice, stopPrice, bandsSinceEntry[i].vwap, minRewardMultiple);

    const stopHit = stopPrice !== null && (direction === 'LONG' ? bar.l <= stopPrice : bar.h >= stopPrice);
    if (stopHit) return { exited: true, reason: 'STOP', exitPrice: stopPrice!, exitBarIndex: i };

    const targetHit = direction === 'LONG' ? bar.h >= target : bar.l <= target;
    if (targetHit) return { exited: true, reason: 'TARGET', exitPrice: target, exitBarIndex: i };
  }
  return NOT_EXITED;
}
