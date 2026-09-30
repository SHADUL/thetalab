import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEnabledExecutionProfiles, hasExecutionProfileToggles } from '../execution/executionProfiles.ts';

test('no toggle columns present: falls back to the legacy single execution_mode', () => {
  assert.deepEqual(deriveEnabledExecutionProfiles({ execution_mode: 'AUTO' }), ['AUTO']);
  assert.deepEqual(deriveEnabledExecutionProfiles({ execution_mode: 'PAPER' }), ['PAPER']);
  assert.deepEqual(deriveEnabledExecutionProfiles({ execution_mode: 'OFF' }), []);
  assert.deepEqual(deriveEnabledExecutionProfiles({ execution_mode: null }), []);
});

test('hasExecutionProfileToggles is false until any toggle column is non-null', () => {
  assert.equal(hasExecutionProfileToggles({ execution_mode: 'AUTO' }), false);
  assert.equal(hasExecutionProfileToggles({ execution_mode: 'AUTO', paper_enabled: null, shadow_enabled: null, auto_enabled: null }), false);
  assert.equal(hasExecutionProfileToggles({ auto_enabled: false }), true);
});

test('toggles present: independent profiles run together, legacy execution_mode is ignored', () => {
  assert.deepEqual(
    deriveEnabledExecutionProfiles({ execution_mode: 'OFF', paper_enabled: false, shadow_enabled: true, auto_enabled: true }),
    ['SHADOW', 'AUTO'],
  );
});

test('toggles present but all false: nothing runs, even if legacy execution_mode still says AUTO', () => {
  assert.deepEqual(
    deriveEnabledExecutionProfiles({ execution_mode: 'AUTO', paper_enabled: false, shadow_enabled: false, auto_enabled: false }),
    [],
  );
});

test('toggles present: all three profiles can run at once', () => {
  assert.deepEqual(
    deriveEnabledExecutionProfiles({ paper_enabled: true, shadow_enabled: true, auto_enabled: true }),
    ['PAPER', 'SHADOW', 'AUTO'],
  );
});

test('order is always PAPER, SHADOW, AUTO regardless of which are enabled', () => {
  assert.deepEqual(
    deriveEnabledExecutionProfiles({ paper_enabled: true, shadow_enabled: false, auto_enabled: true }),
    ['PAPER', 'AUTO'],
  );
});
