/**
 * Shared types for the multi-leg execution state machine, leg-failure
 * handler, and pre-trade validation (Phase 11-12). Pure data shapes only —
 * no Kite/Supabase calls anywhere in this folder. The orchestrator that
 * feeds these with live quotes/fills/margin is a separate, not-yet-built
 * layer; see this folder's README-equivalent notes in stateMachine.ts's
 * header for the exact boundary.
 */

export type ExecutionState =
  | 'PLANNED'
  | 'VALIDATING'
  | 'SUBMITTING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PROTECTED'
  | 'ACTIVE'
  | 'EXIT_PENDING'
  | 'EXITING'
  | 'CLOSED'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED';

/**
 * AMBIGUOUS: a submission timed out and a follow-up broker status query
 * still couldn't determine whether the order actually filled — "network
 * timeout != broker rejection" (QUANT_AUDIT.md Task 4). Never safe to
 * retry (the original order may already be filled at the broker) and
 * never safe to silently treat as unfilled either — see liveFill.ts's
 * handling, which routes any AMBIGUOUS leg straight to
 * RECONCILIATION_REQUIRED rather than through the normal retry/close path.
 */
export type LegFillStatus = 'PENDING' | 'SUBMITTED' | 'FILLED' | 'REJECTED' | 'CANCELLED' | 'AMBIGUOUS';

export interface LegFillState {
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
  status: LegFillStatus;
}

/**
 * Whether the position, as currently filled, carries an unprotected short
 * (dangerous — needs immediate attention) versus simply being incomplete
 * (not dangerous by itself, but not the intended trade either — this
 * engine's whole premise is complete, defined-risk structures, so an
 * incomplete fill is never treated as "good enough," only as "urgent" or
 * "not yet urgent." See legFailureHandler.ts for why an incomplete-but-
 * not-naked position still gets unwound rather than kept.
 */
export type ProtectionState = 'NONE' | 'INCOMPLETE' | 'NAKED' | 'FULL';
