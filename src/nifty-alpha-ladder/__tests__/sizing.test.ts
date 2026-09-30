import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUnitModeUnits } from '../sizing/unitSizing.ts';
import { computeQuantityModeUnits, structureProxyLegIndices } from '../sizing/quantitySizing.ts';
import { computeHeadroom, hasHeadroom, unitModeMarginOk, quantityModeMarginOk, noBasketMarginFallbackOk } from '../sizing/capitalGate.ts';
import { BEARISH_TEMPLATE } from '../instruments/ladderTemplate.ts';

test('allocated capital below one unit -> zero units, skip', () => {
  assert.equal(computeUnitModeUnits(100_000, 340_000), 0);
});

test('exactly one unit budget -> one unit', () => {
  assert.equal(computeUnitModeUnits(340_000, 340_000), 1);
});

test('multiple units -> exact integer floor division, matching the worked example (₹700,000 / ₹340,000 = 2)', () => {
  assert.equal(computeUnitModeUnits(700_000, 340_000), 2);
});

test('zero or negative allocation is skipped, never a negative unit count', () => {
  assert.equal(computeUnitModeUnits(0, 340_000), 0);
  assert.equal(computeUnitModeUnits(-50_000, 340_000), 0);
});

test('exact ratio scaling: per-leg quantities scale linearly with units, ratio never distorted', () => {
  for (const units of [1, 2, 5]) {
    const lotSize = 75;
    const quantities = BEARISH_TEMPLATE.map((leg) => units * leg.ratio * lotSize);
    assert.deepEqual(quantities.map((q) => q / (units * lotSize)), BEARISH_TEMPLATE.map((l) => l.ratio));
  }
});

test('quantity mode: units are exactly the configured quantity, no signal-strength scaling', () => {
  assert.equal(computeQuantityModeUnits(3), 3);
});

test('structure proxy: a 3-leg structure prices the sum of every SHORT leg', () => {
  const indices = structureProxyLegIndices(BEARISH_TEMPLATE);
  assert.deepEqual(indices, [2]); // only the SELL leg (index 2) in the declared template
});

test('capital headroom: a running loss reduces headroom 1:1', () => {
  assert.equal(computeHeadroom(500_000, -50_000), 450_000);
});

test('capital headroom: a running profit does NOT increase headroom beyond deployed capital', () => {
  assert.equal(computeHeadroom(500_000, 100_000), 500_000);
});

test('hasHeadroom: skip when already fully invested and headroom is positive', () => {
  assert.equal(hasHeadroom(500_000, 500_000), false);
  assert.equal(hasHeadroom(499_999, 500_000), true);
});

test('unit mode margin ok requires at least one whole unit', () => {
  assert.equal(unitModeMarginOk(0), false);
  assert.equal(unitModeMarginOk(1), true);
});

test('quantity mode margin ok compares the quoted proxy margin against remaining headroom', () => {
  assert.equal(quantityModeMarginOk(100_000, 500_000, 300_000), true); // 100k <= 200k remaining
  assert.equal(quantityModeMarginOk(250_000, 500_000, 300_000), false); // 250k > 200k remaining
});

test('no-basket-margin fallback compares available funds against units * unit budget', () => {
  assert.equal(noBasketMarginFallbackOk(700_000, 2, 340_000), true);
  assert.equal(noBasketMarginFallbackOk(600_000, 2, 340_000), false);
});
