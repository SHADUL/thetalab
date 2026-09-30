import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLadder, allLegsResolved, BEARISH_TEMPLATE } from '../instruments/ladderTemplate.ts';

const strikeStep = 50;
const atm = 24150;
const expiry = '2026-10-06';
const listed = [23750, 23950, 24150, 24350, 24550, 23800, 24000, 24200]; // deliberately unordered; covers both orientations' legs

test('bearish orientation: exact 4:5:1 ladder, exact strikes, declared placement order preserved', () => {
  const legs = resolveLadder(-1, atm, strikeStep, expiry, listed);
  assert.ok(allLegsResolved(legs));
  assert.deepEqual(
    legs.map((l) => [l.side, l.right, l.strike, l.ratio]),
    [
      ['BUY', 'PE', 24150, 4],
      ['BUY', 'PE', 23750, 1],
      ['SELL', 'PE', 23950, 5],
    ],
  );
});

test('bullish orientation: exact mirror (offsets negated, PE<->CE), same placement order', () => {
  const legs = resolveLadder(1, atm, strikeStep, expiry, listed);
  assert.ok(allLegsResolved(legs));
  assert.deepEqual(
    legs.map((l) => [l.side, l.right, l.strike, l.ratio]),
    [
      ['BUY', 'CE', 24150, 4],
      ['BUY', 'CE', 24550, 1],
      ['SELL', 'CE', 24350, 5],
    ],
  );
});

test('ratio is preserved exactly: 4:5:1 in both orientations, no distortion', () => {
  for (const direction of [-1, 1] as const) {
    const legs = resolveLadder(direction, atm, strikeStep, expiry, listed);
    assert.ok(allLegsResolved(legs));
    const ratios = legs.map((l) => l.ratio);
    assert.deepEqual(ratios, [4, 1, 5]);
  }
});

test('a leg whose strike is not listed resolves to null for that leg only', () => {
  const sparseListing = [24150, 23950]; // missing 23750 (the far protective leg)
  const legs = resolveLadder(-1, atm, strikeStep, expiry, sparseListing);
  assert.equal(legs[0] !== null, true);
  assert.equal(legs[1], null);
  assert.equal(legs[2] !== null, true);
  assert.equal(allLegsResolved(legs), false);
});

test('placement order is exactly [buy ATM, buy far, sell middle] — never reordered', () => {
  assert.deepEqual(
    BEARISH_TEMPLATE.map((l) => l.side),
    ['BUY', 'BUY', 'SELL'],
  );
});
