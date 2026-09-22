/**
 * The daily risk controller's core decision (Phase 20): should NEW entries
 * be blocked for the rest of today. Mirrors src/intraday's own
 * checkDailyRiskLimits() exactly — same closed reason enum, same "checked
 * once per entry attempt, never blocks an exit" posture — extended with
 * the one thing options-selling needs that intraday's tick-based version
 * didn't: a real equity-based daily loss check independent of any single
 * candidate's own sizing.
 *
 * This is a genuinely stricter gate than the implicit one already living
 * in positionSizing.ts's maxDailyLoss constraint: that one only zeroes
 * out lots for whichever SPECIFIC candidate is being sized, and says
 * nothing about consecutive losses at all. This function is a blanket
 * refusal, checked before a candidate is even built, and is the one place
 * consecutive-loss protection is enforced.
 *
 * Once locked, only exits remain active — the caller must still let
 * position-monitor run regardless of this flag. Per the spec's own "require
 * manual re-enable" instruction, this module never un-sets a lock itself;
 * clearing one is a separate, explicit action (see api/options-autotrade.ts's
 * clear-daily-lock resource).
 */

export type DailyLockReason = 'MAX_DAILY_LOSS' | 'MAX_CONSECUTIVE_LOSSES' | null;

export interface DailyLockResult {
  locked: boolean;
  reason: DailyLockReason;
  detail: string;
}

export interface DailyRiskState {
  /** Negative = a loss so far today. */
  realizedPnlToday: number;
  consecutiveLosses: number;
}

export interface DailyRiskLimits {
  equity: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
}

export function checkDailyRiskLock(state: DailyRiskState, limits: DailyRiskLimits): DailyLockResult {
  // equity <= 0 means "not configured yet", not "a ₹0 budget" — without
  // this guard, a fresh settings row (equity 0, realizedPnlToday 0, the
  // default starting state) trivially satisfies `0 <= -0` and locks out
  // on the very first check of the day, before the user ever gets a
  // chance to configure real equity. A genuinely unconfigured risk
  // budget can't be evaluated, so it's skipped here rather than treated
  // as already exceeded.
  if (limits.equity > 0) {
    const maxLossAmount = limits.equity * (limits.maxDailyLossPct / 100);
    if (state.realizedPnlToday <= -maxLossAmount) {
      return {
        locked: true, reason: 'MAX_DAILY_LOSS',
        detail: `Realized loss today (₹${(-state.realizedPnlToday).toFixed(0)}) has reached the daily budget (₹${maxLossAmount.toFixed(0)}, ${limits.maxDailyLossPct}% of equity).`,
      };
    }
  }
  if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return {
      locked: true, reason: 'MAX_CONSECUTIVE_LOSSES',
      detail: `${state.consecutiveLosses} consecutive losing exit(s) reached the configured cap (${limits.maxConsecutiveLosses}).`,
    };
  }
  return { locked: false, reason: null, detail: 'Within daily risk limits.' };
}
