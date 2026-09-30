import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRho, computeG2Knots, computeG2Area, findFirstCrossing } from '../signal/imbalancePath.ts';
import type { AggregateSnapshot } from '../types.ts';

test('rho calculation: (B-A)/(B+A)', () => {
  assert.equal(computeRho({ timeSec: 0, bidQty: 30, askQty: 70 }), (30 - 70) / 100);
});

test('zero denominator yields rho=0, not NaN or Infinity', () => {
  assert.equal(computeRho({ timeSec: 0, bidQty: 0, askQty: 0 }), 0);
});

test('cumulative path sums rho_k across snapshots', () => {
  const snapshots: AggregateSnapshot[] = [
    { timeSec: 0, bidQty: 60, askQty: 40 }, // rho=0.2
    { timeSec: 180, bidQty: 40, askQty: 60 }, // rho=-0.2
    { timeSec: 360, bidQty: 90, askQty: 10 }, // rho=0.8
  ];
  const knots = computeG2Knots(snapshots);
  assert.equal(knots.length, 3);
  assert.ok(Math.abs(knots[0].value - 0.2) < 1e-9);
  assert.ok(Math.abs(knots[1].value - 0.0) < 1e-9);
  assert.ok(Math.abs(knots[2].value - 0.8) < 1e-9);
});

test('first crossing: reproduces the worked example exactly (10:12, G2=-9.13)', () => {
  const rows: Array<[string, number]> = [
    ['09:18', -0.41], ['09:21', -0.44], ['09:24', 0.02], ['09:27', -0.46], ['09:30', -0.52],
    ['09:33', -0.38], ['09:36', -0.61], ['09:39', -0.27], ['09:42', -0.02], ['09:45', -0.55],
    ['09:48', -0.63], ['09:51', -0.49], ['09:54', -0.58], ['09:57', -0.41], ['10:00', -0.72],
    ['10:03', -0.66], ['10:06', -0.57], ['10:09', -0.69], ['10:12', -0.74],
  ];
  const origin = Date.UTC(2026, 8, 30, 9, 18, 0);
  const snapshots: AggregateSnapshot[] = rows.map(([hm, rho]) => {
    const [h, m] = hm.split(':').map(Number);
    const ts = (Date.UTC(2026, 8, 30, h, m, 0) - origin) / 1000;
    // Construct bid/ask that realize the given rho exactly, scale arbitrary.
    const bidQty = (1 + rho) * 50;
    const askQty = (1 - rho) * 50;
    return { timeSec: ts, bidQty, askQty };
  });
  const knots = computeG2Knots(snapshots);
  const lastKnot = knots[knots.length - 1];
  assert.ok(Math.abs(lastKnot.value - -9.13) < 0.01, `expected G2(10:12) ~ -9.13, got ${lastKnot.value}`);

  const crossing = findFirstCrossing(knots, lastKnot.timeSec);
  assert.ok(crossing, 'expected a crossing to be found');
  assert.equal(crossing!.timeSec, lastKnot.timeSec);
  assert.ok(Math.abs(crossing!.value - -9.13) < 0.01);

  // No crossing should have been found any earlier than 10:12 — verify the
  // second-to-last knot (10:09, G2=-8.39) does NOT cross theta5=9.0.
  const secondToLast = knots[knots.length - 2];
  const earlyCrossing = findFirstCrossing(knots, secondToLast.timeSec);
  assert.equal(earlyCrossing, null);
});

test('no crossing before cutoff -> caller falls through to the cutoff path (this module just reports null)', () => {
  const knots = computeG2Knots([{ timeSec: 0, bidQty: 55, askQty: 45 }]);
  assert.equal(findFirstCrossing(knots, 1000, 9.0), null);
});

test('signed area of G2 (used on the cutoff path)', () => {
  const knots = computeG2Knots([
    { timeSec: 0, bidQty: 60, askQty: 40 },
    { timeSec: 180, bidQty: 60, askQty: 40 },
  ]);
  // Two knots both at G2=0.2 then 0.4 (cumulative) — area to 180 = trapezoid(0.2,0.4)*180 = 0.3*180=54
  const area = computeG2Area(knots, 180);
  assert.ok(Math.abs(area - 54) < 1e-9);
});
