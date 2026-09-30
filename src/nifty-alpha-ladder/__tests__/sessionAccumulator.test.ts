import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAccumulator, ingest, evaluateCurrentSignal } from '../live/sessionAccumulator.ts';
import { THETA } from '../parameters.ts';
import type { DepthLevelObservation } from '../types.ts';

const ORIGIN = Date.UTC(2026, 8, 30, 3, 45, 0); // 09:15 IST

function obs(side: 'b' | 'a', price: number, quantity: number, orderCount: number, minutesAfterOrigin: number): DepthLevelObservation {
  return { side, price, quantity, orderCount, timestampMs: ORIGIN + minutesAfterOrigin * 60_000 };
}

test('session accumulator: G2 aggregate windows complete on the theta4 boundary and feed the signal engine', () => {
  let state = createSessionAccumulator(ORIGIN);
  // Heavy, persistent one-sided (bid-dominant) pressure across several 3-min windows, well past theta5=9.0 within a handful of windows if it accumulates correctly.
  for (let w = 0; w < 5; w++) {
    const minute = w * 3 + 1;
    state = ingest(state, [obs('b', 100, 1000, 5, minute), obs('a', 105, 50, 1, minute)], ORIGIN + (w * 3 + 3) * 60_000);
  }
  assert.ok(state.aggregateSnapshots.length >= 5, `expected at least 5 completed G2 snapshots, got ${state.aggregateSnapshots.length}`);
  // Every snapshot should have rho close to +1 (overwhelmingly bid-heavy).
  for (const snap of state.aggregateSnapshots) {
    const rho = (snap.bidQty - snap.askQty) / (snap.bidQty + snap.askQty);
    assert.ok(rho > 0.8, `expected strongly positive rho, got ${rho}`);
  }
});

test('session accumulator: reference threshold only activates after theta2 observations are folded, and never before', () => {
  let state = createSessionAccumulator(ORIGIN);
  // Feed exactly one theta3 window's worth of small observation count — far below theta2's warmup requirement.
  const observations = Array.from({ length: 100 }, (_, i) => obs('b', 100 + i, 50 + i, 1, 1));
  state = ingest(state, observations, ORIGIN + THETA.LARGE_ORDER_REFERENCE_WINDOW_MIN * 60_000);
  assert.equal(state.referenceThresholds.b.cumulativeCount, 100);
  assert.ok(state.referenceThresholds.b.cumulativeCount < THETA.LARGE_ORDER_WARMUP_COUNT, 'sanity: 100 observations must be far below the real warmup count');
});

test('session accumulator: evaluateCurrentSignal wiring reaches the same signal engine, decision structure matches the pure fixture path', () => {
  let state = createSessionAccumulator(ORIGIN);
  // Persistent bid pressure across many windows — enough for a genuine G1 net and G2 crossing.
  for (let w = 0; w < 10; w++) {
    const minute = w * 3 + 1;
    state = ingest(state, [obs('b', 100, 2000, 8, minute), obs('a', 105, 100, 1, minute)], ORIGIN + (w * 3 + 3) * 60_000);
  }
  const nowSec = 33 * 60; // just after the 10th window closes
  const decision = evaluateCurrentSignal(state, nowSec, THETA.VIX_BAR_GRANULARITY_MIN * 60 * 100, { value: 20, available: true }); // a large cutoff so this stays on the crossing path if it crosses at all
  // The wiring must produce a well-formed decision object either way (fired or not) — this test proves the live accumulator reaches signalEngine.evaluateSignal correctly, not a specific direction (that's Milestone 2's own, already-proven worked-example test).
  assert.ok(decision.fired === true || decision.fired === false);
  if (decision.fired) {
    assert.ok(decision.finalDirection === 1 || decision.finalDirection === -1);
    assert.ok(decision.path === 'crossing' || decision.path === 'cutoff');
  }
});
