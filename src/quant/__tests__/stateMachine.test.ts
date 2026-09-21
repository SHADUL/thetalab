import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  afterValidation, afterSubmission, afterLegFailureHandling,
  afterProtectionConfirmed, beginMonitoring, beginExit, exitSubmitted, exitConfirmed,
} from '../execution/stateMachine.ts';
import type { LegFailureDecision } from '../execution/legFailureHandler.ts';
import type { LegFillState } from '../execution/types.ts';

function condorLegs(overrides: Partial<Record<'shortPut' | 'longPut' | 'shortCall' | 'longCall', LegFillState['status']>> = {}): LegFillState[] {
  return [
    { side: 'SELL', right: 'PE', strike: 24600, status: overrides.shortPut ?? 'FILLED' },
    { side: 'BUY', right: 'PE', strike: 24500, status: overrides.longPut ?? 'FILLED' },
    { side: 'SELL', right: 'CE', strike: 25400, status: overrides.shortCall ?? 'FILLED' },
    { side: 'BUY', right: 'CE', strike: 25500, status: overrides.longCall ?? 'FILLED' },
  ];
}

test('afterValidation', () => {
  assert.equal(afterValidation(true), 'SUBMITTING');
  assert.equal(afterValidation(false), 'FAILED');
});

test('afterSubmission: fully filled -> FILLED', () => {
  assert.equal(afterSubmission(condorLegs()), 'FILLED');
});

test('afterSubmission: nothing filled -> FAILED', () => {
  const legs = condorLegs({ shortPut: 'REJECTED', longPut: 'REJECTED', shortCall: 'REJECTED', longCall: 'REJECTED' });
  assert.equal(afterSubmission(legs), 'FAILED');
});

test('afterSubmission: partially filled (naked or incomplete) -> PARTIALLY_FILLED', () => {
  assert.equal(afterSubmission(condorLegs({ longCall: 'PENDING' })), 'PARTIALLY_FILLED'); // naked
  assert.equal(afterSubmission(condorLegs({ shortPut: 'PENDING', shortCall: 'PENDING' })), 'PARTIALLY_FILLED'); // incomplete
});

function decision(action: LegFailureDecision['action']): LegFailureDecision {
  return { action, reason: 'test', legsToClose: [], hasNakedShorts: false };
}

test('afterLegFailureHandling: RETRY_REMAINING loops back to SUBMITTING', () => {
  assert.equal(afterLegFailureHandling(decision('RETRY_REMAINING')), 'SUBMITTING');
});

test('afterLegFailureHandling: CLOSE_FILLED_LEGS ends in FAILED (cleanly unwound)', () => {
  assert.equal(afterLegFailureHandling(decision('CLOSE_FILLED_LEGS')), 'FAILED');
});

test('afterLegFailureHandling: NONE_NEEDED is not expected mid-loop, but falls back to FAILED rather than assuming success', () => {
  assert.equal(afterLegFailureHandling(decision('NONE_NEEDED')), 'FAILED');
});

test('afterProtectionConfirmed: only FILLED may proceed to PROTECTED', () => {
  assert.equal(afterProtectionConfirmed('FILLED'), 'PROTECTED');
});

test('afterProtectionConfirmed: throws from any other state rather than silently proceeding', () => {
  assert.throws(() => afterProtectionConfirmed('PARTIALLY_FILLED'), /expected FILLED/);
  assert.throws(() => afterProtectionConfirmed('ACTIVE'), /expected FILLED/);
});

test('beginMonitoring / beginExit / exitSubmitted are fixed transitions', () => {
  assert.equal(beginMonitoring(), 'ACTIVE');
  assert.equal(beginExit(), 'EXIT_PENDING');
  assert.equal(exitSubmitted(), 'EXITING');
});

test('exitConfirmed: every leg filled or cancelled -> CLOSED', () => {
  const legs: LegFillState[] = [
    { side: 'BUY', right: 'PE', strike: 24600, status: 'FILLED' },
    { side: 'SELL', right: 'PE', strike: 24500, status: 'CANCELLED' },
  ];
  assert.equal(exitConfirmed(legs), 'CLOSED');
});

test('exitConfirmed: a leg still pending or rejected needs reconciliation, not a silent assumption', () => {
  const legs: LegFillState[] = [
    { side: 'BUY', right: 'PE', strike: 24600, status: 'FILLED' },
    { side: 'SELL', right: 'PE', strike: 24500, status: 'REJECTED' },
  ];
  assert.equal(exitConfirmed(legs), 'RECONCILIATION_REQUIRED');
});
