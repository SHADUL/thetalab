import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findNakedShorts, deriveProtectionState, decideLegFailureAction } from '../execution/legFailureHandler.ts';
import type { LegFillState } from '../execution/types.ts';

// A real Iron Condor's four legs (matches how ironCondor.ts always builds
// them: long CE strike > short CE strike, long PE strike < short PE strike).
function condorLegs(overrides: Partial<Record<'shortPut' | 'longPut' | 'shortCall' | 'longCall', LegFillState['status']>> = {}): LegFillState[] {
  return [
    { side: 'SELL', right: 'PE', strike: 24600, status: overrides.shortPut ?? 'FILLED' },
    { side: 'BUY', right: 'PE', strike: 24500, status: overrides.longPut ?? 'FILLED' },
    { side: 'SELL', right: 'CE', strike: 25400, status: overrides.shortCall ?? 'FILLED' },
    { side: 'BUY', right: 'CE', strike: 25500, status: overrides.longCall ?? 'FILLED' },
  ];
}

test('findNakedShorts: fully filled condor has no naked shorts', () => {
  assert.deepEqual(findNakedShorts(condorLegs().filter((l) => l.status === 'FILLED')), []);
});

test('findNakedShorts: only shorts filled -> both are naked', () => {
  const legs = condorLegs({ longPut: 'PENDING', longCall: 'PENDING' });
  const filled = legs.filter((l) => l.status === 'FILLED');
  const naked = findNakedShorts(filled);
  assert.equal(naked.length, 2);
  assert.ok(naked.every((l) => l.side === 'SELL'));
});

test('findNakedShorts: one side complete, other side\'s short still naked', () => {
  const legs = condorLegs({ longCall: 'PENDING' }); // put side complete, call side missing its wing
  const filled = legs.filter((l) => l.status === 'FILLED');
  const naked = findNakedShorts(filled);
  assert.equal(naked.length, 1);
  assert.equal(naked[0].right, 'CE');
});

test('findNakedShorts: only longs filled -> no shorts at all, so none are naked', () => {
  const legs = condorLegs({ shortPut: 'PENDING', shortCall: 'PENDING' });
  const filled = legs.filter((l) => l.status === 'FILLED');
  assert.deepEqual(findNakedShorts(filled), []);
});

test('deriveProtectionState covers all four states', () => {
  assert.equal(deriveProtectionState(condorLegs({ shortPut: 'PENDING', longPut: 'PENDING', shortCall: 'PENDING', longCall: 'PENDING' })), 'NONE');
  assert.equal(deriveProtectionState(condorLegs()), 'FULL');
  assert.equal(deriveProtectionState(condorLegs({ longCall: 'PENDING' })), 'NAKED');
  assert.equal(deriveProtectionState(condorLegs({ shortPut: 'PENDING', shortCall: 'PENDING' })), 'INCOMPLETE');
});

test('decideLegFailureAction: a complete structure needs nothing', () => {
  const decision = decideLegFailureAction(condorLegs(), 0);
  assert.equal(decision.action, 'NONE_NEEDED');
  assert.equal(decision.hasNakedShorts, false);
});

test('decideLegFailureAction: a totally failed attempt (nothing filled) needs nothing to unwind', () => {
  const legs = condorLegs({ shortPut: 'REJECTED', longPut: 'REJECTED', shortCall: 'REJECTED', longCall: 'REJECTED' });
  const decision = decideLegFailureAction(legs, 0);
  assert.equal(decision.action, 'NONE_NEEDED');
  assert.deepEqual(decision.legsToClose, []);
});

test('decideLegFailureAction: retries while budget remains, flags urgency when a short is naked', () => {
  const legs = condorLegs({ longCall: 'PENDING' }); // short call naked
  const decision = decideLegFailureAction(legs, 0, 2);
  assert.equal(decision.action, 'RETRY_REMAINING');
  assert.equal(decision.hasNakedShorts, true);
  assert.match(decision.reason, /naked/i);
});

test('decideLegFailureAction: escalates to closing every filled leg once retries are exhausted, even without a naked short', () => {
  // Only the two protective longs filled — bounded risk on its own, but
  // still not the intended trade, and still gets unwound.
  const legs = condorLegs({ shortPut: 'PENDING', shortCall: 'PENDING' });
  const decision = decideLegFailureAction(legs, 2, 2);
  assert.equal(decision.action, 'CLOSE_FILLED_LEGS');
  assert.equal(decision.hasNakedShorts, false);
  assert.equal(decision.legsToClose.length, 2);
  assert.ok(decision.legsToClose.every((l) => l.side === 'BUY'));
});

test('decideLegFailureAction: escalates and closes everything filled, including naked shorts, once retries are exhausted', () => {
  const legs = condorLegs({ longCall: 'PENDING' });
  const decision = decideLegFailureAction(legs, 2, 2);
  assert.equal(decision.action, 'CLOSE_FILLED_LEGS');
  assert.equal(decision.hasNakedShorts, true);
  assert.equal(decision.legsToClose.length, 3); // shortPut, longPut, shortCall
  assert.match(decision.reason, /naked/i);
});
