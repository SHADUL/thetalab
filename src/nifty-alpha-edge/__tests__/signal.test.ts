/** Port of the reference Python tests (test_signal.py) against the SHARED signal engine hedged131 consumes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFirstCrossing, computeG2Knots } from '../../nifty-alpha-ladder/signal/imbalancePath.ts';
import { computeG1Area } from '../../nifty-alpha-ladder/signal/largeOrderNet.ts';
import { evaluateSignal } from '../../nifty-alpha-ladder/signal/signalEngine.ts';
import { resolveAlignment } from '../../nifty-alpha-ladder/signal/alignmentRule.ts';
import { applyVariationC } from '../../nifty-alpha-ladder/signal/variationC.ts';
import { decideDirection, vixAtOrBefore } from '../decision.ts';
import { IST, SIGNAL_DATE, WORKED_VIX, makeSignal } from './fakes.ts';

const sec = (h: number, m: number) => (h * 60 + m - (9 * 60 + 15)) * 60; // seconds since 09:15
const RHOS = [-0.41, -0.44, 0.02, -0.46, -0.52, -0.38, -0.61, -0.27, -0.02, -0.55, -0.63, -0.49, -0.58, -0.41, -0.72, -0.66, -0.57, -0.69, -0.74];
// G2 snapshots: stamps 09:18 onward every 3 minutes, built from (bid, ask) so rho is exactly as given.
const G2 = computeG2Knots(RHOS.map((r, i) => ({ timeSec: sec(9, 18) + 180 * i, bidQty: 1 + r, askQty: 1 - r })));
const G1 = [[9, 16, 420], [9, 24, 1380], [9, 35, 2610], [9, 47, 1950], [9, 58, 3240], [10, 6, 2880], [10, 15, 3700]]
  .map(([h, m, v]) => ({ timeSec: sec(h, m), value: v }));

test('crossing: first |G2| >= 9 at 10:12 with G2 = -9.13', () => {
  const c = findFirstCrossing(G2, sec(14, 30))!;
  assert.equal(c.timeSec, sec(10, 12));
  assert.ok(Math.abs(c.value - -9.13) < 1e-9);
});

test('G1 area at 10:12 matches the document (~7,707,000 contract-seconds)', () => {
  assert.ok(Math.abs(computeG1Area(G1, sec(10, 12)) - 7_707_000) < 1, String(computeG1Area(G1, sec(10, 12))));
});

test('strictly causal at 10:13: with the 10:15 knot not yet visible the decision is unchanged (d1 = +1, D = -1)', () => {
  // Convention difference, documented rather than changed: the reference
  // Python stops the area at the last visible knot (6,571,800); the shared
  // engine holds the last G1 value flat up to u (6,571,800 + 2,880 x 360 s =
  // 7,608,600). The PDF does not fix this; only the magnitude differs here.
  const visible = G1.filter((k) => k.timeSec <= sec(10, 13));
  assert.ok(Math.abs(computeG1Area(visible, sec(10, 12)) - 7_608_600) < 1);
  const d = evaluateSignal({ g1Knots: visible, g2Knots: G2.filter((k) => k.timeSec <= sec(10, 13)), nowSec: sec(10, 13), cutoffSec: sec(14, 30), vix: { value: 11.87, available: true } });
  assert.ok(d.fired);
  if (d.fired) { assert.equal(d.d1, 1); assert.equal(d.finalDirection, -1); }
});

test('worked example decision: crossing path, d1=+1, d2=-1, divergent (alpha 0), D0=+1, VIX 11.87 flips it to bearish', () => {
  const d = evaluateSignal({ g1Knots: G1, g2Knots: G2, nowSec: sec(10, 15), cutoffSec: sec(14, 30), vix: { value: 11.87, available: true } });
  assert.ok(d.fired);
  if (!d.fired) return;
  assert.equal(d.path, 'crossing');
  assert.equal(d.signalInstantSec, sec(10, 12));
  assert.deepEqual([d.d1, d.d2, d.alpha, d.baseDirection, d.finalDirection], [1, -1, 0, 1, -1]);
  assert.equal(d.variationCActed, true);
});

test('hedged131 re-applies Variation C with the real VIX bar at or before τ* (10:00 bar, 11.87) -> bearish', () => {
  assert.equal(vixAtOrBefore(WORKED_VIX, IST(SIGNAL_DATE, 10, 12)), 11.87);
  const dec = decideDirection(makeSignal(), WORKED_VIX);
  assert.equal(dec.direction, -1);
  assert.equal(dec.variationCActed, true);
  assert.equal(dec.vix, 11.87);
});

test('VIX unreadable -> Variation C inert, trade D0', () => {
  const dec = decideDirection(makeSignal(), []);
  assert.equal(dec.direction, 1);
  assert.equal(dec.vixAvailable, false);
});

test('non-positive VIX closes are ignored', () => {
  assert.equal(vixAtOrBefore([{ startMs: IST(SIGNAL_DATE, 10, 0), close: 0 }, { startMs: IST(SIGNAL_DATE, 9, 45), close: 11.9 }], IST(SIGNAL_DATE, 10, 12)), 11.9);
});

test('a VIX bar stamped after τ* is never used', () => {
  assert.equal(vixAtOrBefore([{ startMs: IST(SIGNAL_DATE, 10, 15), close: 11 }], IST(SIGNAL_DATE, 10, 12)), null);
});

test('decision truth table (d1, d2, VIX, g*) -> D, matching the reference implementation', () => {
  const cases: Array<[number, number, number, number, number]> = [
    [1, 1, 20, 10, -1], [1, -1, 20, 10, 1], [1, -1, 11, 10, -1], [1, 0, 11, 10, -1],
    [-1, -1, 20, 10, 1], [-1, -1, 11, 10, 1], [-1, -1, 11, 3, -1], [-1, 1, 11, 3, -1], [-1, 0, 20, 3, -1],
  ];
  for (const [d1, d2, vix, g, want] of cases) {
    const { baseDirection, alpha } = resolveAlignment(d1 as any, d2 as any);
    const got = applyVariationC({ baseDirection: baseDirection!, alpha, gStar: g, vixValue: vix, vixAvailable: true }).finalDirection;
    assert.equal(got, want, `${d1},${d2},${vix},${g}`);
  }
});

test('d1 = 0 never decides', () => {
  assert.equal(resolveAlignment(0, 1).baseDirection, null);
});

test('earliest possible crossing is the 9th snapshot (09:42)', () => {
  const g2 = computeG2Knots(Array.from({ length: 12 }, (_, i) => ({ timeSec: sec(9, 18) + 180 * i, bidQty: 1, askQty: 0 })));
  assert.equal(findFirstCrossing(g2, sec(14, 30))!.timeSec, sec(9, 42));
});

test('cutoff path when G2 never crosses', () => {
  const flat = computeG2Knots(Array.from({ length: 100 }, (_, i) => ({ timeSec: sec(9, 18) + 180 * i, bidQty: 1 + 0.5 * (-1) ** i, askQty: 1 - 0.5 * (-1) ** i })));
  const d = evaluateSignal({ g1Knots: G1, g2Knots: flat, nowSec: sec(14, 30), cutoffSec: sec(14, 30), vix: { value: null, available: false } });
  assert.ok(d.fired);
  if (d.fired) { assert.equal(d.path, 'cutoff'); assert.equal(d.signalInstantSec, sec(14, 30)); }
});
