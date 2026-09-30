import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearishUnitPayoff, computePayoffSummary, computeBreakEvenOffsets } from '../risk/payoff.ts';

const A = 24150;
const wing = 200; // spec's declared 200-point wing (4 strike steps at Δ=50)

test('payoff region: S_T >= A -> 0', () => {
  assert.equal(bearishUnitPayoff(A, A, wing), 0);
  assert.equal(bearishUnitPayoff(A + 500, A, wing), 0);
});

test('payoff region: A-200 <= S_T < A -> rises 0 -> 800', () => {
  assert.equal(bearishUnitPayoff(A, A, wing), 0);
  assert.equal(bearishUnitPayoff(A - 200, A, wing), 800);
  assert.equal(bearishUnitPayoff(A - 100, A, wing), 400);
});

test('payoff region: A-400 <= S_T < A-200 -> falls 800 -> 600', () => {
  assert.equal(bearishUnitPayoff(A - 200, A, wing), 800);
  assert.equal(bearishUnitPayoff(A - 400, A, wing), 600);
  assert.equal(bearishUnitPayoff(A - 300, A, wing), 700);
});

test('payoff region: S_T < A-400 -> constant 600 (the covered tail)', () => {
  assert.equal(bearishUnitPayoff(A - 400, A, wing), 600);
  assert.equal(bearishUnitPayoff(A - 1000, A, wing), 600);
  assert.equal(bearishUnitPayoff(0, A, wing), 600);
});

test('payoff is non-negative everywhere (no unbounded exposure in either tail)', () => {
  for (let s = 0; s <= A + 1000; s += 25) {
    assert.ok(bearishUnitPayoff(s, A, wing) >= 0, `payoff negative at S_T=${s}`);
  }
});

test('max loss / max gain / tail value: reproduces the worked example exactly', () => {
  const summary = computePayoffSummary(225.60, 2, 75, A);
  assert.ok(Math.abs(summary.maxLoss - 33_840) < 1e-6);
  assert.ok(Math.abs(summary.maxGain - 86_160) < 1e-6);
  assert.ok(Math.abs(summary.tailValue - 56_160) < 1e-6);
  assert.equal(summary.breakEvens.length, 1);
  assert.ok(Math.abs(summary.breakEvens[0] - 24_093.60) < 1e-6);
});

test('break-even: single break-even for 0<delta<600', () => {
  assert.deepEqual(computeBreakEvenOffsets(400), [-100]);
});

test('break-even: a second break-even appears for 600<=delta<800', () => {
  const offsets = computeBreakEvenOffsets(700);
  assert.equal(offsets.length, 2);
  assert.ok(Math.abs(offsets[0] - -175) < 1e-9);
  assert.ok(Math.abs(offsets[1] - -300) < 1e-9);
});

test('break-even: no break-even at or beyond the structural bounds', () => {
  assert.deepEqual(computeBreakEvenOffsets(0), []);
  assert.deepEqual(computeBreakEvenOffsets(800), []);
  assert.deepEqual(computeBreakEvenOffsets(-10), []);
});
