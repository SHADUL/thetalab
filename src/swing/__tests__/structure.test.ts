import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateStructureSetup } from '../structure/evaluate.ts';

const BASE = {
  close: 100,
  ema20: 95,           // close > ema20: passes
  high52w: 120,         // 100/120 = 0.833 >= 0.75: passes
  yesterdayVolume: 100_000, // > 70,000: passes
  weeklyRsi14: 60,      // < 75: passes
  weeklyHigh: 105,
  prevWeeklyHigh: 100,  // 105 > 100: passes
};

test('evaluateStructureSetup: a stock satisfying every condition passes all gates and gets a score', () => {
  const r = evaluateStructureSetup(BASE);
  assert.equal(r.passesAll, true);
  assert.ok(Object.values(r.gates).every(Boolean));
  assert.notEqual(r.score, null);
  assert.ok(r.score! > 0 && r.score! <= 100);
});

test('evaluateStructureSetup: price floor gate — close must exceed 20', () => {
  const r = evaluateStructureSetup({ ...BASE, close: 15, ema20: 10, high52w: 20 });
  assert.equal(r.gates.priceFloor, false);
  assert.equal(r.passesAll, false);
  assert.equal(r.score, null);
});

test('evaluateStructureSetup: liquidity gate — yesterday volume must exceed 70,000', () => {
  const r = evaluateStructureSetup({ ...BASE, yesterdayVolume: 50_000 });
  assert.equal(r.gates.liquidity, false);
  assert.equal(r.passesAll, false);
});

test('evaluateStructureSetup: 52-week-high proximity gate — must be within 25% of the high', () => {
  const near = evaluateStructureSetup({ ...BASE, close: 90, high52w: 120 }); // 90/120 = 0.75 exactly, boundary
  assert.equal(near.gates.near52wHigh, true);
  const far = evaluateStructureSetup({ ...BASE, close: 89, high52w: 120 }); // just under
  assert.equal(far.gates.near52wHigh, false);
});

test('evaluateStructureSetup: proximity score is 0 at the gate threshold and 100 at the high itself', () => {
  const atGate = evaluateStructureSetup({ ...BASE, close: 90, high52w: 120 }); // exactly 75%
  assert.equal(atGate.factors.proximity, 0);
  const atHigh = evaluateStructureSetup({ ...BASE, close: 120, high52w: 120 }); // at the 52w high
  assert.equal(atHigh.factors.proximity, 100);
});

test('evaluateStructureSetup: daily EMA20 gate — close must exceed it', () => {
  const r = evaluateStructureSetup({ ...BASE, close: 90, ema20: 95, high52w: 120 });
  assert.equal(r.gates.aboveDailyEma20, false);
  assert.equal(r.passesAll, false);
});

test('evaluateStructureSetup: weekly RSI ceiling gate — must stay under 75', () => {
  const overheated = evaluateStructureSetup({ ...BASE, weeklyRsi14: 78 });
  assert.equal(overheated.gates.weeklyRsiCeiling, false);
  assert.equal(overheated.passesAll, false);
});

test('evaluateStructureSetup: weekly higher-high gate — this week must exceed last week', () => {
  const r = evaluateStructureSetup({ ...BASE, weeklyHigh: 99, prevWeeklyHigh: 100 });
  assert.equal(r.gates.weeklyHigherHigh, false);
  assert.equal(r.passesAll, false);
});

test('evaluateStructureSetup: missing data fails the relevant gate rather than guessing', () => {
  const r = evaluateStructureSetup({ ...BASE, ema20: null, high52w: null, yesterdayVolume: null, weeklyRsi14: null, weeklyHigh: null, prevWeeklyHigh: null });
  assert.equal(r.gates.aboveDailyEma20, false);
  assert.equal(r.gates.near52wHigh, false);
  assert.equal(r.gates.liquidity, false);
  assert.equal(r.gates.weeklyRsiCeiling, false);
  assert.equal(r.gates.weeklyHigherHigh, false);
  assert.equal(r.passesAll, false);
  assert.equal(r.score, null);
});

test('evaluateStructureSetup: a stronger setup (closer to high, further above EMA20) scores higher', () => {
  const weak = evaluateStructureSetup({ ...BASE, close: 91, ema20: 90, high52w: 120 }); // barely past every gate
  const strong = evaluateStructureSetup({ ...BASE, close: 118, ema20: 100, high52w: 120 }); // comfortably past
  assert.ok(strong.score! > weak.score!);
});
