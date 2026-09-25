/**
 * Per-symbol SHADOW forward-validation health report (readiness phase,
 * Task 4) — a pure function over already-fetched DB rows/counts, same
 * split-responsibility pattern as dataQualityHealth.ts (that module
 * measures generic ingestion quality from records; this one assembles the
 * FULL set of fields the readiness phase's health endpoint must expose,
 * including ledger/telemetry/protocol-run state dataQualityHealth.ts has
 * no visibility into). Every percentage is null (never 0) when its
 * denominator is 0 — Task 4's explicit instruction.
 */

export interface ShadowHealthCounts {
  symbol: string;
  scansAttempted: number;
  snapshotWriteSuccesses: number;
  snapshotWriteAttempts: number;
  ivHistoryWriteSuccesses: number;
  ivHistoryWriteAttempts: number;
  missingBidAskCount: number;
  staleQuoteCount: number;
  missingOiCount: number;
  missingIvCount: number;
  snapshotRowCount: number;
  entryTelemetrySuccesses: number;
  entryTelemetryAttempts: number;
  exitTelemetrySuccesses: number;
  exitTelemetryAttempts: number;
  ledgerSignalSuccesses: number;
  ledgerSignalAttempts: number;
  ledgerOutcomeSuccesses: number;
  ledgerOutcomeAttempts: number;
  openShadowPositions: number;
  completedShadowTrades: number;
  eligibleCompletedShadowTrades: number;
  activeProtocolRun: boolean;
  protocolStartedAt: string | null;
  nowMs: number;
  /**
   * Forward-start blocker phase, Task 7/8: pre-classified consistency
   * counts (via shadowConsistency.ts's classifyShadowConsistency, run by
   * the caller over every SHADOW position+ledger pair for this symbol —
   * this module stays a pure aggregator, never queries anything itself).
   */
  completedLedgerActivePositionCount: number; // LEDGER_COMPLETED + POSITION_ACTIVE (RECOVERABLE_INCONSISTENCY)
  closedPositionIncompleteLedgerCount: number; // LEDGER_OPEN + POSITION_CLOSED
  protocolTimingInvalidTradeCount: number; // completed trades whose protocolTiming eligibility check failed
  recoveryRequiredCount: number; // any OTHER RECONCILIATION_REQUIRED case (an unexpected position status alongside an incomplete ledger)
}

export interface ShadowHealthReport {
  symbol: string;
  scansAttempted: number;
  snapshotWriteSuccessPct: number | null;
  ivHistoryWriteSuccessPct: number | null;
  missingBidAskPct: number | null;
  staleQuotePct: number | null;
  missingOiPct: number | null;
  missingIvPct: number | null;
  entryExecutionTelemetrySuccessPct: number | null;
  exitExecutionTelemetrySuccessPct: number | null;
  ledgerSignalSuccessPct: number | null;
  ledgerOutcomeSuccessPct: number | null;
  openShadowPositions: number;
  completedShadowTrades: number;
  eligibleCompletedShadowTrades: number;
  validForwardSamplePct: number | null;
  activeProtocolRun: boolean;
  protocolStartedAt: string | null;
  elapsedDays: number | null;
  completedLedgerActivePositionCount: number;
  closedPositionIncompleteLedgerCount: number;
  protocolTimingInvalidTradeCount: number;
  recoveryRequiredCount: number;
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'NOT_READY';
  reasons: string[];
}

export interface ShadowHealthThresholds {
  minSnapshotWritePct: number;
  minIvHistoryWritePct: number;
  maxMissingBidAskPct: number;
  maxStaleQuotePct: number;
  maxMissingOiPct: number;
  maxMissingIvPct: number;
  minEntryTelemetryPct: number;
  minExitTelemetryPct: number;
  minLedgerSignalPct: number;
  minLedgerOutcomePct: number;
}

export const DEFAULT_SHADOW_HEALTH_THRESHOLDS: ShadowHealthThresholds = {
  minSnapshotWritePct: 95, minIvHistoryWritePct: 80, maxMissingBidAskPct: 10, maxStaleQuotePct: 5,
  maxMissingOiPct: 10, maxMissingIvPct: 10, minEntryTelemetryPct: 95, minExitTelemetryPct: 95,
  minLedgerSignalPct: 95, minLedgerOutcomePct: 95,
};

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.min(100, (numerator / denominator) * 100) : null;
}

export function computeShadowHealthReport(
  c: ShadowHealthCounts,
  thresholds: ShadowHealthThresholds = DEFAULT_SHADOW_HEALTH_THRESHOLDS,
): ShadowHealthReport {
  const snapshotWriteSuccessPct = pct(c.snapshotWriteSuccesses, c.snapshotWriteAttempts);
  const ivHistoryWriteSuccessPct = pct(c.ivHistoryWriteSuccesses, c.ivHistoryWriteAttempts);
  const missingBidAskPct = pct(c.missingBidAskCount, c.snapshotRowCount);
  const staleQuotePct = pct(c.staleQuoteCount, c.snapshotRowCount);
  const missingOiPct = pct(c.missingOiCount, c.snapshotRowCount);
  const missingIvPct = pct(c.missingIvCount, c.snapshotRowCount);
  const entryExecutionTelemetrySuccessPct = pct(c.entryTelemetrySuccesses, c.entryTelemetryAttempts);
  const exitExecutionTelemetrySuccessPct = pct(c.exitTelemetrySuccesses, c.exitTelemetryAttempts);
  const ledgerSignalSuccessPct = pct(c.ledgerSignalSuccesses, c.ledgerSignalAttempts);
  const ledgerOutcomeSuccessPct = pct(c.ledgerOutcomeSuccesses, c.ledgerOutcomeAttempts);
  const validForwardSamplePct = pct(c.eligibleCompletedShadowTrades, c.completedShadowTrades);
  const elapsedDays = c.activeProtocolRun && c.protocolStartedAt
    ? Math.max(0, (c.nowMs - Date.parse(c.protocolStartedAt)) / 86_400_000)
    : null;

  // healthStatus is NEVER inferred from a null/missing metric (Task 4's
  // explicit instruction) — only from a metric that actually HAS a value
  // and fails its own threshold. A metric with no denominator yet (e.g.
  // zero scans attempted today) contributes nothing to this judgment.
  const reasons: string[] = [];
  const checks: Array<[number | null, number, boolean, string]> = [
    [snapshotWriteSuccessPct, thresholds.minSnapshotWritePct, true, 'snapshot write success below threshold'],
    [ivHistoryWriteSuccessPct, thresholds.minIvHistoryWritePct, true, 'IV-history write success below threshold'],
    [missingBidAskPct, thresholds.maxMissingBidAskPct, false, 'missing bid/ask rate above threshold'],
    [staleQuotePct, thresholds.maxStaleQuotePct, false, 'stale-quote rate above threshold'],
    [missingOiPct, thresholds.maxMissingOiPct, false, 'missing open-interest rate above threshold'],
    [missingIvPct, thresholds.maxMissingIvPct, false, 'missing IV rate above threshold'],
    [entryExecutionTelemetrySuccessPct, thresholds.minEntryTelemetryPct, true, 'entry execution telemetry success below threshold'],
    [exitExecutionTelemetrySuccessPct, thresholds.minExitTelemetryPct, true, 'exit execution telemetry success below threshold'],
    [ledgerSignalSuccessPct, thresholds.minLedgerSignalPct, true, 'ledger signal success below threshold'],
    [ledgerOutcomeSuccessPct, thresholds.minLedgerOutcomePct, true, 'ledger outcome success below threshold'],
  ];
  let degraded = false;
  for (const [value, threshold, higherIsBetter, reason] of checks) {
    if (value === null) continue;
    const failed = higherIsBetter ? value < threshold : value > threshold;
    if (failed) { degraded = true; reasons.push(`${reason} (${value.toFixed(1)} vs ${threshold})`); }
  }

  // Task 8: ANY unresolved SHADOW lifecycle inconsistency blocks HEALTHY
  // outright, regardless of how good every percentage above looks —
  // these are correctness problems, not data-quality noise, and must
  // never be silently averaged away.
  if (c.completedLedgerActivePositionCount > 0) { degraded = true; reasons.push(`${c.completedLedgerActivePositionCount} position(s) have a completed ledger outcome but are still ACTIVE (recoverable — see SHADOW_EXIT_RECOVERY.md)`); }
  if (c.closedPositionIncompleteLedgerCount > 0) { degraded = true; reasons.push(`${c.closedPositionIncompleteLedgerCount} position(s) are CLOSED but their ledger was never completed — reconciliation required`); }
  if (c.protocolTimingInvalidTradeCount > 0) { degraded = true; reasons.push(`${c.protocolTimingInvalidTradeCount} completed trade(s) failed protocol-timing eligibility`); }
  if (c.recoveryRequiredCount > 0) { degraded = true; reasons.push(`${c.recoveryRequiredCount} position(s) are in an unexpected state requiring manual reconciliation`); }

  let healthStatus: 'HEALTHY' | 'DEGRADED' | 'NOT_READY';
  if (c.scansAttempted === 0) {
    healthStatus = 'NOT_READY';
    reasons.push('no scans attempted yet for this symbol — insufficient data to judge health');
  } else if (degraded) {
    healthStatus = 'DEGRADED';
  } else {
    healthStatus = 'HEALTHY';
  }

  return {
    symbol: c.symbol, scansAttempted: c.scansAttempted,
    snapshotWriteSuccessPct, ivHistoryWriteSuccessPct, missingBidAskPct, staleQuotePct, missingOiPct, missingIvPct,
    entryExecutionTelemetrySuccessPct, exitExecutionTelemetrySuccessPct, ledgerSignalSuccessPct, ledgerOutcomeSuccessPct,
    openShadowPositions: c.openShadowPositions, completedShadowTrades: c.completedShadowTrades,
    eligibleCompletedShadowTrades: c.eligibleCompletedShadowTrades, validForwardSamplePct,
    activeProtocolRun: c.activeProtocolRun, protocolStartedAt: c.protocolStartedAt, elapsedDays,
    completedLedgerActivePositionCount: c.completedLedgerActivePositionCount,
    closedPositionIncompleteLedgerCount: c.closedPositionIncompleteLedgerCount,
    protocolTimingInvalidTradeCount: c.protocolTimingInvalidTradeCount,
    recoveryRequiredCount: c.recoveryRequiredCount,
    healthStatus, reasons,
  };
}
