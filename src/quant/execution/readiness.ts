/**
 * Forward-validation readiness evaluator (readiness phase, Task 5). A
 * pure function: every input is a fact the CALLER has already probed
 * (a DB check, an env read, a constant lookup) — this function itself
 * performs no I/O and has no side effects, only judges the assembled
 * facts and returns READY/NOT_READY with reasons, the same discipline as
 * shadowExecution.ts's isEligibleForForwardValidation.
 */

export interface ForwardValidationReadinessInput {
  /** Task 9: renamed/widened from "migration012Present" — now covers 011+012+013 together, since 011 (forward_validation_runs) turned out to have never been applied either. */
  migrationsPresent: boolean;
  baselineVersion: string;
  expectedBaselineVersion: string;
  shadowExecutionV1Active: boolean;
  entryTelemetryWired: boolean;
  exitTelemetryWired: boolean;
  ledgerSignalWired: boolean;
  ledgerOutcomeWired: boolean;
  entryExecutionCostNonStubbed: boolean;
  completionIdempotencyActive: boolean;
  healthEndpointWorking: boolean;
  hasActiveUnresolvedDataQualityFault: boolean;
  autoEnabled: boolean;
  useNetEvRankingEnabled: boolean;
  /** Task 9: the completed-trade eligibility gate must actually receive protocol-run facts, not just be capable of it. */
  protocolTimingEligibilityWired: boolean;
  /** Task 9: the LEDGER_COMPLETED+POSITION_ACTIVE recovery path (shadowConsistency.ts) is wired into the position monitor. */
  completedLedgerRecoveryWired: boolean;
  /** Task 9: canonical net-P&L formula (executionCost.ts) is the one and only path producing grossPnl/netPnl for SHADOW outcomes. */
  canonicalPnlActive: boolean;
  /** Task 9: no position is currently sitting in a state classifyShadowConsistency would call RECOVERABLE_INCONSISTENCY or RECONCILIATION_REQUIRED. */
  hasUnresolvedShadowLifecycleInconsistency: boolean;
}

export interface ForwardValidationReadinessResult {
  status: 'READY' | 'NOT_READY';
  reasons: string[];
}

export function evaluateForwardValidationReadiness(input: ForwardValidationReadinessInput): ForwardValidationReadinessResult {
  const reasons: string[] = [];
  if (!input.migrationsPresent) reasons.push('migrations 011/012/013 (protocol-run table, position<->ledger link, completion idempotency, execution-quality extension columns, version fingerprint, atomic active-run index) are not all present in production');
  if (input.baselineVersion !== input.expectedBaselineVersion) reasons.push(`baseline drift: expected ${input.expectedBaselineVersion}, got ${input.baselineVersion}`);
  if (!input.shadowExecutionV1Active) reasons.push('SHADOW_EXECUTION_V1 is not the active fill model');
  if (!input.entryTelemetryWired) reasons.push('entry execution-quality telemetry is not wired');
  if (!input.exitTelemetryWired) reasons.push('exit execution-quality telemetry is not wired');
  if (!input.ledgerSignalWired) reasons.push('forward-validation ledger signal recording is not wired');
  if (!input.ledgerOutcomeWired) reasons.push('forward-validation ledger outcome recording is not wired');
  if (!input.entryExecutionCostNonStubbed) reasons.push('entryExecutionCost is still hard-coded/stubbed rather than looked up from real telemetry');
  if (!input.completionIdempotencyActive) reasons.push('completion idempotency guard (ledger completed flag, atomic conditional write) is not active');
  if (!input.healthEndpointWorking) reasons.push('the shadow-health endpoint is not working');
  if (input.hasActiveUnresolvedDataQualityFault) reasons.push('an unresolved SHADOW data-quality fault is currently active');
  if (input.autoEnabled) reasons.push('AUTO is enabled — the forward-validation protocol must only ever start under SHADOW');
  if (input.useNetEvRankingEnabled) reasons.push('USE_NET_EV_RANKING is enabled — the protocol requires the frozen gross-EV ranking baseline');
  if (!input.protocolTimingEligibilityWired) reasons.push('the completed-trade eligibility gate is not receiving protocol-run timing facts');
  if (!input.completedLedgerRecoveryWired) reasons.push('the LEDGER_COMPLETED+POSITION_ACTIVE recovery path is not wired into the position monitor');
  if (!input.canonicalPnlActive) reasons.push('the canonical net-P&L formula is not the sole path producing SHADOW gross/net P&L');
  if (input.hasUnresolvedShadowLifecycleInconsistency) reasons.push('at least one SHADOW position is in an unresolved lifecycle-inconsistency state (see shadow-health)');
  return { status: reasons.length === 0 ? 'READY' : 'NOT_READY', reasons };
}
