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

export type LegFillStatus = 'PENDING' | 'SUBMITTED' | 'FILLED' | 'REJECTED' | 'CANCELLED';

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
