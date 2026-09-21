import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPaperExecution, type PlannedLeg } from '../execution/paperFill.ts';
import type { ValidationResult } from '../execution/preTradeValidation.ts';

const LEGS: PlannedLeg[] = [
  { side: 'SELL', right: 'PE', strike: 24600, tradingsymbol: 'NIFTY26SEP24600PE', quantity: 65, fillPrice: 120 },
  { side: 'BUY', right: 'PE', strike: 24500, tradingsymbol: 'NIFTY26SEP24500PE', quantity: 65, fillPrice: 80 },
  { side: 'SELL', right: 'CE', strike: 25400, tradingsymbol: 'NIFTY26SEP25400CE', quantity: 65, fillPrice: 110 },
  { side: 'BUY', right: 'CE', strike: 25500, tradingsymbol: 'NIFTY26SEP25500CE', quantity: 65, fillPrice: 75 },
];

function passingValidation(): ValidationResult {
  return { passed: true, checks: [{ name: 'marketDataFreshness', passed: true, detail: 'fresh' }] };
}

function failingValidation(): ValidationResult {
  return {
    passed: false,
    checks: [
      { name: 'marketDataFreshness', passed: true, detail: 'fresh' },
      { name: 'riskLimits', passed: false, detail: 'Position size resolved to zero lots.' },
    ],
  };
}

test('a validation failure never places anything — every leg REJECTED, state FAILED', () => {
  const result = runPaperExecution(LEGS, failingValidation());
  assert.equal(result.state, 'FAILED');
  assert.equal(result.protection, 'NONE');
  assert.ok(result.legFills.every((l) => l.status === 'REJECTED'));
  assert.match(result.log[0], /VALIDATING -> FAILED/);
  assert.match(result.log[0], /riskLimits/);
});

test('a passing validation fills every leg instantly and drives the state machine to ACTIVE', () => {
  const result = runPaperExecution(LEGS, passingValidation());
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.protection, 'FULL');
  assert.equal(result.legFills.length, 4);
  assert.ok(result.legFills.every((l) => l.status === 'FILLED'));
  // Original leg data (tradingsymbol/quantity/fillPrice) must survive into the result, not just status.
  assert.equal(result.legFills[0].tradingsymbol, 'NIFTY26SEP24600PE');
  assert.equal(result.legFills[0].fillPrice, 120);
});

test('the log traces every real state transition in order, not a summary', () => {
  const result = runPaperExecution(LEGS, passingValidation());
  assert.equal(result.log.length, 4);
  assert.match(result.log[0], /VALIDATING -> SUBMITTING/);
  assert.match(result.log[1], /SUBMITTING -> FILLED/);
  assert.match(result.log[2], /FILLED -> PROTECTED/);
  assert.match(result.log[3], /PROTECTED -> ACTIVE/);
});
