/**
 * SHADOW ledger<->position consistency (forward-start blocker phase,
 * Tasks 3/4/7). See SHADOW_EXIT_RECOVERY.md for the full durable-sequence
 * design this classifier and the recovery finalization it drives are
 * built around.
 *
 * The dangerous edge case this fixes: `recordOutcome` succeeds (the
 * ledger row is `completed=true`) but the process crashes/errors before
 * the position's own `status='CLOSED'` UPDATE runs. Without this, the
 * next monitor cycle's `recordOutcome` call correctly returns
 * `alreadyCompleted` (the idempotency guard working exactly as designed)
 * — but the OLD code then just `continue`d, leaving the position ACTIVE
 * forever, because nothing ever re-attempted the close once the ledger
 * said done.
 *
 * The fix: LEDGER_COMPLETED + POSITION_ACTIVE is a RECOVERABLE
 * inconsistency, not a terminal one — the FIRST completed ledger outcome
 * is authoritative, and the position is idempotently finalized CLOSED
 * from THOSE PERSISTED VALUES, never by re-simulating a second exit,
 * never by recomputing a different P&L from newer quotes, never by
 * writing a second batch of exit telemetry.
 */

export type ShadowConsistencyState =
  | 'NORMAL_OPEN' // ledger not yet completed, position still ACTIVE — the ordinary in-flight state.
  | 'NORMAL_CLOSED' // ledger completed, position CLOSED — the ordinary terminal state.
  | 'RECOVERABLE_INCONSISTENCY' // ledger completed, position still ACTIVE — recordOutcome succeeded but the position-close UPDATE never ran (or hasn't yet, in this exact monitor pass). Fixable from the persisted outcome, no reconciliation needed.
  | 'RECONCILIATION_REQUIRED'; // position CLOSED but the ledger was never completed, or the position is in some OTHER status entirely — never auto-fixed, must be surfaced.

/**
 * Pure classifier — no DB access. `positionStatus` is whatever the
 * position row's own `status` column currently holds; only 'ACTIVE' and
 * 'CLOSED' are the two states this SHADOW lifecycle ever intentionally
 * produces — anything else (CLOSE_FAILED, RECONCILIATION_REQUIRED, or any
 * future status) alongside an incomplete ledger is ALSO flagged for
 * reconciliation rather than silently ignored.
 */
export function classifyShadowConsistency(ledgerCompleted: boolean, positionStatus: string): ShadowConsistencyState {
  if (positionStatus === 'ACTIVE') return ledgerCompleted ? 'RECOVERABLE_INCONSISTENCY' : 'NORMAL_OPEN';
  if (positionStatus === 'CLOSED') return ledgerCompleted ? 'NORMAL_CLOSED' : 'RECONCILIATION_REQUIRED';
  return 'RECONCILIATION_REQUIRED';
}

/**
 * Task 6's "exit telemetry written + crash before outcome" case: true
 * when a PRIOR invocation already wrote an EXIT telemetry batch for this
 * ledger row but the ledger itself was never completed — re-simulating a
 * fresh exit here would create a SECOND, independently-priced exit
 * (a different set of quotes, a different P&L), which this module never
 * silently allows. The caller must refuse to proceed (no re-simulation,
 * no fragile reconstruction from partial stored fields) and flag for
 * manual reconciliation instead — the same discipline
 * classifyShadowConsistency already applies to every other ambiguous
 * combination.
 */
export function hasOrphanedExitTelemetry(ledgerCompleted: boolean, existingExitTelemetryCount: number): boolean {
  return !ledgerCompleted && existingExitTelemetryCount > 0;
}

/** Everything the recovery path needs to know about the FIRST, already-completed ledger outcome — read-only, never recomputed. */
export interface PersistedLedgerOutcomeFacts {
  exitReason: string | null;
  netPnl: number | null;
  outcomeRecordedAtIso: string | null;
  validForForwardValidationCarry: boolean; // the ENTRY-side eligibility already stamped on the position — recovery never upgrades it, only ANDs in whether exit telemetry was actually found.
}

export interface ShadowRecoveryFinalizationInput {
  ledgerId: string;
  positionId: number;
  entryDateIso: string; // fallback exit_date when outcomeRecordedAtIso is unavailable — never fabricates a date, just falls back to a known-real one.
  outcome: PersistedLedgerOutcomeFacts;
  /** Whether a phase='EXIT' execution-quality batch was actually found for this ledgerId — determined by the caller with a read-only COUNT, never re-inserted here. */
  exitTelemetryFound: boolean;
}

export interface ShadowRecoveryFinalizationPlan {
  positionId: number;
  update: {
    status: 'CLOSED';
    execution_state: 'CLOSED';
    exit_date: string;
    exit_reason: string;
    realized_pnl: number;
    valid_for_forward_validation: boolean;
    forward_validation_ineligibility_reasons: string[] | null;
  };
}

/**
 * Builds the finalization UPDATE payload from the FIRST, already-
 * persisted ledger outcome — never recomputes P&L, never re-simulates an
 * exit, never re-derives exit_reason from a fresh evaluateExit() call.
 * The caller is responsible for applying this via an atomic
 * `WHERE id = ? AND status = 'ACTIVE'` UPDATE (Task 4) so a second,
 * concurrent recovery attempt affects zero rows instead of double-firing.
 */
export function buildShadowRecoveryFinalizationPlan(input: ShadowRecoveryFinalizationInput): ShadowRecoveryFinalizationPlan {
  const reasons: string[] = [];
  if (!input.exitTelemetryFound) reasons.push('exit execution-quality telemetry was not found for this ledger row at recovery time');
  const validForForwardValidation = input.outcome.validForForwardValidationCarry && input.exitTelemetryFound;
  return {
    positionId: input.positionId,
    update: {
      status: 'CLOSED', execution_state: 'CLOSED',
      exit_date: (input.outcome.outcomeRecordedAtIso ?? input.entryDateIso).slice(0, 10),
      exit_reason: input.outcome.exitReason ?? 'RECOVERED_UNKNOWN_REASON',
      realized_pnl: input.outcome.netPnl ?? 0,
      valid_for_forward_validation: validForForwardValidation,
      forward_validation_ineligibility_reasons: reasons.length > 0 ? reasons : null,
    },
  };
}
