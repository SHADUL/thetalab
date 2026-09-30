import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVariationC, isWeakRead } from '../signal/variationC.ts';

test('bullish + calm VIX + weak read (divergent) -> reversed to bearish', () => {
  const result = applyVariationC({ baseDirection: 1, alpha: 0, gStar: 20, vixValue: 11.87, vixAvailable: true });
  assert.equal(result.finalDirection, -1);
  assert.equal(result.acted, true);
});

test('bullish + high VIX (not calm) -> unchanged even if the read is weak', () => {
  const result = applyVariationC({ baseDirection: 1, alpha: 0, gStar: 20, vixValue: 15.0, vixAvailable: true });
  assert.equal(result.finalDirection, 1);
  assert.equal(result.acted, false);
});

test('bullish + strong read (aligned AND |g*|>=theta8) -> unchanged even with calm VIX', () => {
  const result = applyVariationC({ baseDirection: 1, alpha: 1, gStar: 10, vixValue: 11.87, vixAvailable: true });
  assert.equal(isWeakRead(1, 10), false);
  assert.equal(result.finalDirection, 1);
  assert.equal(result.acted, false);
});

test('bearish is never reversed, regardless of VIX or read strength', () => {
  const r1 = applyVariationC({ baseDirection: -1, alpha: 0, gStar: 20, vixValue: 5, vixAvailable: true });
  const r2 = applyVariationC({ baseDirection: -1, alpha: 1, gStar: 0.001, vixValue: 5, vixAvailable: true });
  assert.equal(r1.finalDirection, -1);
  assert.equal(r2.finalDirection, -1);
  assert.equal(r1.acted, false);
  assert.equal(r2.acted, false);
});

test('VIX unavailable -> filter inert, base direction traded unfiltered (never guesses a value)', () => {
  const result = applyVariationC({ baseDirection: 1, alpha: 0, gStar: 20, vixValue: null, vixAvailable: false });
  assert.equal(result.finalDirection, 1);
  assert.equal(result.acted, false);
});

test('isWeakRead: divergent (alpha=0) is always weak regardless of |g*|', () => {
  assert.equal(isWeakRead(0, 1000, 4.5), true);
});

test('isWeakRead: aligned (alpha=1) is weak only when |g*| < theta8', () => {
  assert.equal(isWeakRead(1, 4.4, 4.5), true);
  assert.equal(isWeakRead(1, 4.5, 4.5), false);
});
