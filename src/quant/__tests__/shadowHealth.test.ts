import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeShadowHealthReport, type ShadowHealthCounts } from '../analytics/shadowHealth.ts';

const BASE: ShadowHealthCounts = {
  symbol: 'NIFTY', scansAttempted: 0,
  snapshotWriteSuccesses: 0, snapshotWriteAttempts: 0,
  ivHistoryWriteSuccesses: 0, ivHistoryWriteAttempts: 0,
  missingBidAskCount: 0, staleQuoteCount: 0, missingOiCount: 0, missingIvCount: 0, snapshotRowCount: 0,
  entryTelemetrySuccesses: 0, entryTelemetryAttempts: 0,
  exitTelemetrySuccesses: 0, exitTelemetryAttempts: 0,
  ledgerSignalSuccesses: 0, ledgerSignalAttempts: 0,
  ledgerOutcomeSuccesses: 0, ledgerOutcomeAttempts: 0,
  openShadowPositions: 0, completedShadowTrades: 0, eligibleCompletedShadowTrades: 0,
  activeProtocolRun: false, protocolStartedAt: null, nowMs: Date.now(),
  completedLedgerActivePositionCount: 0, closedPositionIncompleteLedgerCount: 0,
  protocolTimingInvalidTradeCount: 0, recoveryRequiredCount: 0,
};

test('zero denominators produce null percentages, never a fabricated 0%', () => {
  const report = computeShadowHealthReport(BASE);
  assert.equal(report.snapshotWriteSuccessPct, null);
  assert.equal(report.ivHistoryWriteSuccessPct, null);
  assert.equal(report.missingBidAskPct, null);
  assert.equal(report.entryExecutionTelemetrySuccessPct, null);
  assert.equal(report.validForwardSamplePct, null);
});

test('zero scans attempted -> NOT_READY, never HEALTHY/DEGRADED inferred from missing data', () => {
  const report = computeShadowHealthReport(BASE);
  assert.equal(report.healthStatus, 'NOT_READY');
});

test('every metric passing its threshold with real data -> HEALTHY', () => {
  const report = computeShadowHealthReport({
    ...BASE, scansAttempted: 20,
    snapshotWriteSuccesses: 20, snapshotWriteAttempts: 20,
    ivHistoryWriteSuccesses: 20, ivHistoryWriteAttempts: 20,
    snapshotRowCount: 80, missingBidAskCount: 2, staleQuoteCount: 1, missingOiCount: 1, missingIvCount: 1,
    entryTelemetrySuccesses: 20, entryTelemetryAttempts: 20,
    exitTelemetrySuccesses: 15, exitTelemetryAttempts: 15,
    ledgerSignalSuccesses: 20, ledgerSignalAttempts: 20,
    ledgerOutcomeSuccesses: 15, ledgerOutcomeAttempts: 15,
    completedShadowTrades: 15, eligibleCompletedShadowTrades: 15,
  });
  assert.equal(report.healthStatus, 'HEALTHY');
  assert.equal(report.reasons.length, 0);
});

test('a metric failing its threshold with real data -> DEGRADED with a specific reason', () => {
  const report = computeShadowHealthReport({
    ...BASE, scansAttempted: 20,
    snapshotWriteSuccesses: 10, snapshotWriteAttempts: 20, // 50% — well below 95% threshold
  });
  assert.equal(report.healthStatus, 'DEGRADED');
  assert.ok(report.reasons.some((r) => r.includes('snapshot write success')));
});

test('validForwardSamplePct = eligibleCompletedShadowTrades / completedShadowTrades, null when no completed trades yet', () => {
  const withTrades = computeShadowHealthReport({ ...BASE, scansAttempted: 5, completedShadowTrades: 10, eligibleCompletedShadowTrades: 7 });
  assert.equal(withTrades.validForwardSamplePct, 70);
  const withoutTrades = computeShadowHealthReport({ ...BASE, scansAttempted: 5 });
  assert.equal(withoutTrades.validForwardSamplePct, null);
});

test('any unresolved SHADOW lifecycle inconsistency blocks HEALTHY, even when every percentage passes', () => {
  const withCompletedButActive = computeShadowHealthReport({
    ...BASE, scansAttempted: 20,
    snapshotWriteSuccesses: 20, snapshotWriteAttempts: 20, ivHistoryWriteSuccesses: 20, ivHistoryWriteAttempts: 20,
    entryTelemetrySuccesses: 20, entryTelemetryAttempts: 20, exitTelemetrySuccesses: 20, exitTelemetryAttempts: 20,
    ledgerSignalSuccesses: 20, ledgerSignalAttempts: 20, ledgerOutcomeSuccesses: 20, ledgerOutcomeAttempts: 20,
    completedLedgerActivePositionCount: 1,
  });
  assert.equal(withCompletedButActive.healthStatus, 'DEGRADED');
  assert.ok(withCompletedButActive.reasons.some((r) => r.includes('completed ledger outcome but are still ACTIVE')));

  const withReconciliation = computeShadowHealthReport({ ...BASE, scansAttempted: 5, closedPositionIncompleteLedgerCount: 2 });
  assert.equal(withReconciliation.healthStatus, 'DEGRADED');
  assert.ok(withReconciliation.reasons.some((r) => r.includes('reconciliation required')));

  const withProtocolTimingInvalid = computeShadowHealthReport({ ...BASE, scansAttempted: 5, protocolTimingInvalidTradeCount: 3 });
  assert.equal(withProtocolTimingInvalid.healthStatus, 'DEGRADED');
  assert.ok(withProtocolTimingInvalid.reasons.some((r) => r.includes('protocol-timing eligibility')));

  const withRecoveryRequired = computeShadowHealthReport({ ...BASE, scansAttempted: 5, recoveryRequiredCount: 1 });
  assert.equal(withRecoveryRequired.healthStatus, 'DEGRADED');
  assert.ok(withRecoveryRequired.reasons.some((r) => r.includes('unexpected state')));
});

test('elapsedDays is null when no protocol run is active, and a real positive number once one is', () => {
  const noRun = computeShadowHealthReport(BASE);
  assert.equal(noRun.elapsedDays, null);
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const withRun = computeShadowHealthReport({ ...BASE, activeProtocolRun: true, protocolStartedAt: tenDaysAgo });
  assert.ok(withRun.elapsedDays !== null && withRun.elapsedDays >= 9.9 && withRun.elapsedDays <= 10.1);
});
