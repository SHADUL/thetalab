import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderFlowFeatures } from '../live/orderFlowFeatures.ts';
import { createSessionAccumulator, ingest } from '../live/sessionAccumulator.ts';
import { createInMemoryAlphaLadderStore } from '../persistence/store.ts';
import type { DepthLevelObservation } from '../types.ts';

const ORIGIN = Date.UTC(2026, 9, 7, 3, 45, 0); // 09:15 IST
const MIN = 60_000;
const CUTOFF = (14 * 60 + 30 - (9 * 60 + 15)) * 60;
const NO_VIX = { value: null, available: false };

function obs(side: 'b' | 'a', qty: number, orders: number, atMin: number, price = 100): DepthLevelObservation {
  return { side, price, quantity: qty, orderCount: orders, timestampMs: ORIGIN + atMin * MIN };
}

/** Heavy bid-side pressure for `windows` 3-minute buckets, with large resting bid orders and thresholds already warm. */
function bullishLookingFlow(windows: number, warm = true) {
  const state = createSessionAccumulator(ORIGIN);
  if (warm) {
    state.referenceThresholds = { b: { cumulativeCount: 200_000, runningThreshold: 100 }, a: { cumulativeCount: 200_000, runningThreshold: 100 } };
  }
  for (let w = 0; w < windows; w++) {
    const t = w * 3 + 1;
    ingest(state, [obs('b', 5000 + w, 9, t), obs('a', 100, 1, t, 105)], ORIGIN + (w * 3 + 3) * MIN);
  }
  return state;
}

test('features: no data yet -> d1 = 0, no direction, G1 not active (no data, not "no pressure")', () => {
  const f = computeOrderFlowFeatures(createSessionAccumulator(ORIGIN), 600, CUTOFF, NO_VIX);
  assert.equal(f.d1, 0);
  assert.equal(f.finalDirection, null);
  assert.equal(f.g1Active, false);
});

test('features: warm-up not met -> g1Active false even with flow present', () => {
  const f = computeOrderFlowFeatures(bullishLookingFlow(5, false), 5 * 180, CUTOFF, NO_VIX);
  assert.equal(f.g1Active, false);
});

test('features: sustained bid pressure crosses G2 +theta5, d2 comes from the crossing, Alpha Ladder fades an aligned read', () => {
  const state = bullishLookingFlow(14);
  const f = computeOrderFlowFeatures(state, 14 * 180, CUTOFF, NO_VIX);
  assert.equal(f.g1Active, true);
  assert.equal(f.g2Crossed, true);
  assert.equal(f.d2Basis, 'crossing');
  assert.equal(f.d2, 1);
  assert.equal(f.d1, 1);
  assert.equal(f.alpha, 1);              // aligned
  assert.equal(f.baseDirection, -1);     // fade
  assert.equal(f.finalDirection, -1);    // Variation C is inert without VIX, and never touches a bearish base
  assert.equal(f.variationCActed, false);
});

test('features: before any crossing d2 is the provisional running-area sign', () => {
  const f = computeOrderFlowFeatures(bullishLookingFlow(3), 3 * 180, CUTOFF, NO_VIX);
  assert.equal(f.g2Crossed, false);
  assert.equal(f.d2Basis, 'running_area');
});

test('features: computing them never mutates the accumulator (read-only)', () => {
  const state = bullishLookingFlow(14);
  const before = JSON.stringify(state);
  computeOrderFlowFeatures(state, 14 * 180, CUTOFF, NO_VIX);
  computeOrderFlowFeatures(state, CUTOFF + 10, CUTOFF, NO_VIX);
  assert.equal(JSON.stringify(state), before);
});

test('features: past the cutoff d2 uses the cutoff-area basis', () => {
  const f = computeOrderFlowFeatures(bullishLookingFlow(14), CUTOFF + 60, CUTOFF, NO_VIX);
  assert.equal(f.d2Basis, 'cutoff_area');
});

test('store: a published feature row is accepted by the in-memory store', async () => {
  const store = createInMemoryAlphaLadderStore();
  const features = computeOrderFlowFeatures(bullishLookingFlow(14), 14 * 180, CUTOFF, NO_VIX);
  await store.insertOrderFlowFeature({ ...features, sessionDate: '2026-10-07', workerInstance: 't', sessionValid: true, sessionIntegrityReason: null });
});
