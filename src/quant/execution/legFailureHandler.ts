/**
 * Decides what to do after a submission attempt leaves some legs filled
 * and some not — the one genuinely hard problem in multi-leg execution.
 * "Never allow an unintended naked option position to remain unmanaged"
 * is read here in its stricter, more defensible form: this engine's whole
 * premise is complete, defined-risk structures, so ANY incomplete fill —
 * not just a naked short — is treated as "not the intended trade" once
 * retries are exhausted, and closed rather than kept. A lone filled long
 * leg is not dangerous on its own, but it also isn't the trade that was
 * planned, and tolerating "close enough" partial structures is exactly
 * the kind of judgment call this module deliberately avoids making.
 *
 * `hasNakedShorts` is still tracked and surfaced separately from the
 * action itself — it doesn't change WHAT gets closed (everything filled,
 * either way), but it does mark the difference in urgency for logging and
 * alerting (Phase 36's "unexpected naked exposure" alert maps directly
 * onto this flag).
 */
import type { LegFillState, ProtectionState } from './types.ts';

/**
 * A filled short is "covered" when its own protective long (same right,
 * on the correct side per how ironCondor.ts/creditSpread.ts always
 * construct wings — the long CE sits ABOVE its short, the long PE sits
 * BELOW its short) is also filled. Works identically for a 2-leg credit
 * spread and a 4-leg iron condor.
 */
export function findNakedShorts(filledLegs: LegFillState[]): LegFillState[] {
  return filledLegs.filter((short) => {
    if (short.side !== 'SELL') return false;
    return !filledLegs.some((long) =>
      long.side === 'BUY' &&
      long.right === short.right &&
      (short.right === 'CE' ? long.strike > short.strike : long.strike < short.strike),
    );
  });
}

export function deriveProtectionState(legs: LegFillState[]): ProtectionState {
  const filled = legs.filter((l) => l.status === 'FILLED');
  if (filled.length === 0) return 'NONE';
  if (filled.length === legs.length) return 'FULL';
  return findNakedShorts(filled).length > 0 ? 'NAKED' : 'INCOMPLETE';
}

export type LegFailureAction = 'NONE_NEEDED' | 'RETRY_REMAINING' | 'CLOSE_FILLED_LEGS';

export interface LegFailureDecision {
  action: LegFailureAction;
  reason: string;
  /** The legs to actually place closing orders against — populated only for CLOSE_FILLED_LEGS. */
  legsToClose: LegFillState[];
  hasNakedShorts: boolean;
}

/**
 * @param legs           Every planned leg with its current fill status.
 * @param attemptsSoFar  How many submission attempts have already happened for this position.
 * @param maxRetries     How many more attempts to allow before escalating to a close. Default 2.
 */
export function decideLegFailureAction(
  legs: LegFillState[],
  attemptsSoFar: number,
  maxRetries = 2,
): LegFailureDecision {
  const filled = legs.filter((l) => l.status === 'FILLED');
  const unfilled = legs.filter((l) => l.status !== 'FILLED');
  const hasNakedShorts = findNakedShorts(filled).length > 0;

  if (unfilled.length === 0) {
    return { action: 'NONE_NEEDED', reason: 'Every leg filled — the structure is complete.', legsToClose: [], hasNakedShorts: false };
  }
  if (filled.length === 0) {
    return { action: 'NONE_NEEDED', reason: 'No leg filled — a clean failed attempt, nothing to unwind.', legsToClose: [], hasNakedShorts: false };
  }
  if (attemptsSoFar < maxRetries) {
    return {
      action: 'RETRY_REMAINING',
      reason: `${unfilled.length} leg(s) unfilled (attempt ${attemptsSoFar + 1}/${maxRetries})` +
        (hasNakedShorts ? ' — a short leg is temporarily naked, retrying with urgency.' : '.'),
      legsToClose: [],
      hasNakedShorts,
    };
  }
  return {
    action: 'CLOSE_FILLED_LEGS',
    reason: `${unfilled.length} leg(s) never filled after ${maxRetries} retries — an incomplete structure is not the intended trade` +
      (hasNakedShorts ? ', and a short leg is currently naked' : '') +
      `; closing the ${filled.length} filled leg(s) rather than leaving a partial position unmanaged.`,
    legsToClose: filled,
    hasNakedShorts,
  };
}
