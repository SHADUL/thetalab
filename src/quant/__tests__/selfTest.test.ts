import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runForwardValidationSelfTest } from '../execution/selfTest.ts';

test('runForwardValidationSelfTest passes end-to-end with the current wiring — every required check succeeds', async () => {
  const result = await runForwardValidationSelfTest();
  const failing = result.checks.filter((c) => !c.passed);
  assert.equal(failing.length, 0, `self-test checks failed: ${JSON.stringify(failing, null, 2)}`);
  assert.equal(result.passed, true);
  assert.equal(result.brokerCallsMade, 0);
});

test('runForwardValidationSelfTest reports one check per required lifecycle property (Task 7\'s own list)', async () => {
  const result = await runForwardValidationSelfTest();
  const names = result.checks.map((c) => c.name);
  assert.ok(names.some((n) => n.includes('entry fill simulation')));
  assert.ok(names.some((n) => n.includes('ledger signal recorded')));
  assert.ok(names.some((n) => n.includes('entry telemetry present')));
  assert.ok(names.some((n) => n.includes('monitor HOLD')));
  assert.ok(names.some((n) => n.includes('monitor EXIT')));
  assert.ok(names.some((n) => n.includes('exit fill simulation')));
  assert.ok(names.some((n) => n.includes('exit telemetry present')));
  assert.ok(names.some((n) => n.includes('entryExecutionCost looked up')));
  assert.ok(names.some((n) => n.includes('completed outcome recorded')));
  assert.ok(names.some((n) => n.includes('no duplicate completion')));
  assert.ok(names.some((n) => n.includes('eligibility gate')));
  assert.ok(names.some((n) => n.includes('zero broker calls')));
  assert.ok(names.some((n) => n.includes('RECOVERABLE_INCONSISTENCY')));
  assert.ok(names.some((n) => n.includes('getOutcome reads back')));
  assert.ok(names.some((n) => n.includes('never recomputed from newer quotes')));
  assert.ok(names.some((n) => n.includes('finalized CLOSED')));
  assert.ok(names.some((n) => n.includes('no duplicate exit telemetry')));
  assert.ok(names.some((n) => n.includes('completed exactly once')));
});

test('runForwardValidationSelfTest is idempotent to run repeatedly (each call builds its own fresh in-memory state)', async () => {
  const first = await runForwardValidationSelfTest();
  const second = await runForwardValidationSelfTest();
  assert.equal(first.passed, true);
  assert.equal(second.passed, true);
});
