/**
 * The multi-leg execution state machine (Phase 11): PLANNED -> VALIDATING
 * -> SUBMITTING -> (PARTIALLY_FILLED | FILLED) -> PROTECTED -> ACTIVE ->
 * EXIT_PENDING -> EXITING -> CLOSED, with FAILED and RECONCILIATION_REQUIRED
 * reachable at the relevant points.
 *
 * Deliberately NOT a generic event-dispatch FSM — each transition below is
 * its own small, named, single-purpose function with a stated
 * precondition, matching this codebase's preference for concrete code
 * over an abstract layer nothing else here uses. Every function is pure:
 * it takes the outcome of something that already happened (a validation
 * result, a set of fills, a leg-failure decision) and returns the next
 * state. Nothing in this file calls Kite, Supabase, or places an order —
 * that orchestration (fetching live quotes, actually submitting orders,
 * persisting state transitions) is a separate, not-yet-built layer, and
 * real order placement stays out of scope until the validation/backtest
 * phases this system's own spec requires first (Phase 25-32, Phase 42
 * steps 17-22) actually exist. This module only defines what "correct"
 * looks like once that orchestrator is built.
 *
 * RECONCILIATION_REQUIRED is reserved for a future broker-vs-internal-
 * state reconciliation module (Phase 22) to set independently, at any
 * point in a position's life — it is not something this file's own
 * transitions produce as a matter of course, except where an exit doesn't
 * cleanly account for every leg (see exitConfirmed below).
 */
import { deriveProtectionState, type LegFailureDecision } from './legFailureHandler.ts';
import type { ExecutionState, LegFillState } from './types.ts';

/** VALIDATING -> SUBMITTING | FAILED. */
export function afterValidation(validationPassed: boolean): ExecutionState {
  return validationPassed ? 'SUBMITTING' : 'FAILED';
}

/** SUBMITTING -> FILLED | PARTIALLY_FILLED | FAILED, from the fill state alone. */
export function afterSubmission(legs: LegFillState[]): ExecutionState {
  const protection = deriveProtectionState(legs);
  if (protection === 'FULL') return 'FILLED';
  if (protection === 'NONE') return 'FAILED';
  return 'PARTIALLY_FILLED'; // NAKED or INCOMPLETE
}

/**
 * PARTIALLY_FILLED -> SUBMITTING (retry) | FAILED (unwound), driven by
 * legFailureHandler.ts's own decision. NONE_NEEDED should not actually be
 * reachable from this state (it only occurs when nothing or everything is
 * filled, both of which afterSubmission already routes elsewhere) — FAILED
 * is the safe fallback if it somehow is, rather than assuming success.
 */
export function afterLegFailureHandling(decision: LegFailureDecision): ExecutionState {
  if (decision.action === 'RETRY_REMAINING') return 'SUBMITTING';
  return 'FAILED';
}

/**
 * FILLED -> PROTECTED. Only a genuinely complete structure reaches this —
 * throws rather than silently proceeding if called from anywhere else,
 * since "protected" is meaningless for an incomplete position.
 */
export function afterProtectionConfirmed(currentState: ExecutionState): ExecutionState {
  if (currentState !== 'FILLED') {
    throw new Error(`afterProtectionConfirmed called from ${currentState}, expected FILLED`);
  }
  return 'PROTECTED';
}

/** PROTECTED -> ACTIVE. Handing off to the position monitor. */
export function beginMonitoring(): ExecutionState {
  return 'ACTIVE';
}

/** ACTIVE -> EXIT_PENDING. The exit engine (not yet built) has decided to close. */
export function beginExit(): ExecutionState {
  return 'EXIT_PENDING';
}

/** EXIT_PENDING -> EXITING. Exit orders have been submitted. */
export function exitSubmitted(): ExecutionState {
  return 'EXITING';
}

/**
 * EXITING -> CLOSED | RECONCILIATION_REQUIRED. An exit that didn't
 * cleanly account for every leg (still-open or unexpectedly-rejected
 * closing orders) needs a human/reconciliation module, not a silent
 * assumption that it worked.
 */
export function exitConfirmed(legs: LegFillState[]): ExecutionState {
  const allAccountedFor = legs.every((l) => l.status === 'FILLED' || l.status === 'CANCELLED');
  return allAccountedFor ? 'CLOSED' : 'RECONCILIATION_REQUIRED';
}
