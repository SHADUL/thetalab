import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlignment, signWithTolerance } from '../signal/alignmentRule.ts';

test('sign with tolerance: dead-band around zero', () => {
  assert.equal(signWithTolerance(0.001, 1e-4), 1);
  assert.equal(signWithTolerance(-0.001, 1e-4), -1);
  assert.equal(signWithTolerance(0.00001, 1e-4), 0);
  assert.equal(signWithTolerance(-0.00001, 1e-4), 0);
});

test('aligned bullish/bullish -> base direction bearish, alpha=1 (fade the pressure)', () => {
  const { baseDirection, alpha } = resolveAlignment(1, 1);
  assert.equal(baseDirection, -1);
  assert.equal(alpha, 1);
});

test('aligned bearish/bearish -> base direction bullish, alpha=1', () => {
  const { baseDirection, alpha } = resolveAlignment(-1, -1);
  assert.equal(baseDirection, 1);
  assert.equal(alpha, 1);
});

test('divergent cases follow d1 (alpha=0), including d2=0', () => {
  assert.deepEqual(resolveAlignment(1, -1), { baseDirection: 1, alpha: 0 });
  assert.deepEqual(resolveAlignment(-1, 1), { baseDirection: -1, alpha: 0 });
  assert.deepEqual(resolveAlignment(1, 0), { baseDirection: 1, alpha: 0 });
  assert.deepEqual(resolveAlignment(-1, 0), { baseDirection: -1, alpha: 0 });
});

test('d1=0 -> undefined base direction (engine must not fire)', () => {
  const { baseDirection } = resolveAlignment(0, 1);
  assert.equal(baseDirection, null);
});

test('closed form matches Proposition 4.4: Ψ = d1·(1 − 2·1{d1=d2}) for d1≠0', () => {
  for (const d1 of [-1, 1] as const) {
    for (const d2 of [-1, 0, 1] as const) {
      const expected = d1 * (1 - 2 * (d1 === d2 ? 1 : 0));
      const { baseDirection } = resolveAlignment(d1, d2);
      assert.equal(baseDirection, expected);
    }
  }
});
