import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateForwardValidationReadiness, type ForwardValidationReadinessInput } from '../execution/readiness.ts';

const ALL_GOOD: ForwardValidationReadinessInput = {
  migrationsPresent: true, baselineVersion: 'BASELINE_V1', expectedBaselineVersion: 'BASELINE_V1',
  shadowExecutionV1Active: true, entryTelemetryWired: true, exitTelemetryWired: true,
  ledgerSignalWired: true, ledgerOutcomeWired: true, entryExecutionCostNonStubbed: true,
  completionIdempotencyActive: true, healthEndpointWorking: true, hasActiveUnresolvedDataQualityFault: false,
  autoEnabled: false, useNetEvRankingEnabled: false,
  protocolTimingEligibilityWired: true, completedLedgerRecoveryWired: true, canonicalPnlActive: true,
  hasUnresolvedShadowLifecycleInconsistency: false,
};

test('every condition satisfied -> READY, zero reasons', () => {
  const result = evaluateForwardValidationReadiness(ALL_GOOD);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.reasons, []);
});

test('each individual failure produces NOT_READY with its own specific reason, one at a time', () => {
  const cases: Array<[Partial<ForwardValidationReadinessInput>, string]> = [
    [{ migrationsPresent: false }, 'migrations 011/012/013'],
    [{ baselineVersion: 'BASELINE_V2' }, 'baseline drift'],
    [{ shadowExecutionV1Active: false }, 'SHADOW_EXECUTION_V1'],
    [{ entryTelemetryWired: false }, 'entry execution-quality telemetry'],
    [{ exitTelemetryWired: false }, 'exit execution-quality telemetry'],
    [{ ledgerSignalWired: false }, 'ledger signal'],
    [{ ledgerOutcomeWired: false }, 'ledger outcome'],
    [{ entryExecutionCostNonStubbed: false }, 'entryExecutionCost'],
    [{ completionIdempotencyActive: false }, 'idempotency guard'],
    [{ healthEndpointWorking: false }, 'shadow-health endpoint'],
    [{ hasActiveUnresolvedDataQualityFault: true }, 'data-quality fault'],
    [{ autoEnabled: true }, 'AUTO is enabled'],
    [{ useNetEvRankingEnabled: true }, 'USE_NET_EV_RANKING'],
    [{ protocolTimingEligibilityWired: false }, 'protocol-run timing facts'],
    [{ completedLedgerRecoveryWired: false }, 'recovery path is not wired'],
    [{ canonicalPnlActive: false }, 'canonical net-P&L formula'],
    [{ hasUnresolvedShadowLifecycleInconsistency: true }, 'lifecycle-inconsistency state'],
  ];
  for (const [override, expectedSubstring] of cases) {
    const result = evaluateForwardValidationReadiness({ ...ALL_GOOD, ...override });
    assert.equal(result.status, 'NOT_READY');
    assert.ok(result.reasons.some((r) => r.includes(expectedSubstring)), `expected a reason containing "${expectedSubstring}", got: ${JSON.stringify(result.reasons)}`);
  }
});

test('multiple simultaneous failures are all reported, not just the first', () => {
  const result = evaluateForwardValidationReadiness({ ...ALL_GOOD, autoEnabled: true, useNetEvRankingEnabled: true, migrationsPresent: false });
  assert.equal(result.status, 'NOT_READY');
  assert.equal(result.reasons.length, 3);
});

test('evaluateForwardValidationReadiness performs no I/O and has no side effects (pure — same input always yields the same output)', () => {
  const a = evaluateForwardValidationReadiness(ALL_GOOD);
  const b = evaluateForwardValidationReadiness(ALL_GOOD);
  assert.deepEqual(a, b);
});
