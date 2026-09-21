/**
 * Target and stop-loss evaluation for an OPEN position — Sections 4/5 of
 * the reference doc.
 *
 * Target: VWAP itself, re-evaluated every bar since VWAP keeps moving
 * (Section 4: "the limit price is resubmitted every bar to the current
 * VWAP, so the exit order tracks VWAP as it moves") — LONG exits when
 * high >= that bar's own VWAP, SHORT when low <= that bar's own VWAP.
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

export function evaluateVwapScalperExit(
  direction: Direction,
  stopPrice: number | null,
  barsSinceEntry: Bar[],
  bandsSinceEntry: VwapBandsPoint[],
): VwapScalperExitEvaluation {
  for (let i = 0; i < barsSinceEntry.length; i++) {
    const bar = barsSinceEntry[i];
    const vwap = bandsSinceEntry[i].vwap;

    const stopHit = stopPrice !== null && (direction === 'LONG' ? bar.l <= stopPrice : bar.h >= stopPrice);
    if (stopHit) return { exited: true, reason: 'STOP', exitPrice: stopPrice!, exitBarIndex: i };

    const targetHit = direction === 'LONG' ? bar.h >= vwap : bar.l <= vwap;
    if (targetHit) return { exited: true, reason: 'TARGET', exitPrice: vwap, exitBarIndex: i };
  }
  return NOT_EXITED;
}
