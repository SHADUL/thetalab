import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyShadowConsistency, buildShadowRecoveryFinalizationPlan } from '../execution/shadowConsistency.ts';

test('ledger open + position ACTIVE = NORMAL_OPEN', () => {
  assert.equal(classifyShadowConsistency(false, 'ACTIVE'), 'NORMAL_OPEN');
});

test('ledger completed + position CLOSED = NORMAL_CLOSED', () => {
  assert.equal(classifyShadowConsistency(true, 'CLOSED'), 'NORMAL_CLOSED');
});

test('ledger completed + position ACTIVE = RECOVERABLE_INCONSISTENCY', () => {
  assert.equal(classifyShadowConsistency(true, 'ACTIVE'), 'RECOVERABLE_INCONSISTENCY');
});

test('ledger open + position CLOSED = RECONCILIATION_REQUIRED', () => {
  assert.equal(classifyShadowConsistency(false, 'CLOSED'), 'RECONCILIATION_REQUIRED');
});

test('any other position status is always flagged, never silently treated as normal', () => {
  assert.equal(classifyShadowConsistency(false, 'CLOSE_FAILED'), 'RECONCILIATION_REQUIRED');
  assert.equal(classifyShadowConsistency(true, 'RECONCILIATION_REQUIRED'), 'RECONCILIATION_REQUIRED');
});

test('buildShadowRecoveryFinalizationPlan uses the PERSISTED outcome values, never recomputing P&L', () => {
  const plan = buildShadowRecoveryFinalizationPlan({
    ledgerId: 'ledger-1', positionId: 42, entryDateIso: '2026-01-05',
    outcome: { exitReason: 'STOP_LOSS_CREDIT_MULTIPLE', netPnl: -12345, outcomeRecordedAtIso: '2026-01-08T10:15:00.000Z', validForForwardValidationCarry: true },
    exitTelemetryFound: true,
  });
  assert.equal(plan.positionId, 42);
  assert.equal(plan.update.status, 'CLOSED');
  assert.equal(plan.update.realized_pnl, -12345);
  assert.equal(plan.update.exit_reason, 'STOP_LOSS_CREDIT_MULTIPLE');
  assert.equal(plan.update.exit_date, '2026-01-08');
  assert.equal(plan.update.valid_for_forward_validation, true);
  assert.equal(plan.update.forward_validation_ineligibility_reasons, null);
});

test('buildShadowRecoveryFinalizationPlan falls back to entryDateIso when outcomeRecordedAtIso is unavailable — never fabricates a date', () => {
  const plan = buildShadowRecoveryFinalizationPlan({
    ledgerId: 'ledger-1', positionId: 42, entryDateIso: '2026-01-05',
    outcome: { exitReason: 'TIME_EXIT', netPnl: 500, outcomeRecordedAtIso: null, validForForwardValidationCarry: true },
    exitTelemetryFound: true,
  });
  assert.equal(plan.update.exit_date, '2026-01-05');
});

test('buildShadowRecoveryFinalizationPlan marks ineligible (never deletes) when exit telemetry cannot be found at recovery time', () => {
  const plan = buildShadowRecoveryFinalizationPlan({
    ledgerId: 'ledger-1', positionId: 42, entryDateIso: '2026-01-05',
    outcome: { exitReason: 'TIME_EXIT', netPnl: 500, outcomeRecordedAtIso: '2026-01-08T10:15:00.000Z', validForForwardValidationCarry: true },
    exitTelemetryFound: false,
  });
  assert.equal(plan.update.status, 'CLOSED', 'the position must still be finalized CLOSED — only its forward-sample eligibility is affected');
  assert.equal(plan.update.valid_for_forward_validation, false);
  assert.ok(plan.update.forward_validation_ineligibility_reasons?.some((r) => r.includes('exit execution-quality telemetry')));
});
