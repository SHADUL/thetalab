import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAccumulator, ingest, serializeCheckpoint, restoreFromCheckpoint, restoreOrStartFresh } from '../live/sessionAccumulator.ts';
import { createInMemoryAlphaLadderStore } from '../persistence/store.ts';
import type { DepthLevelObservation } from '../types.ts';

const ORIGIN = Date.UTC(2026, 8, 30, 3, 45, 0); // 09:15 IST

function obs(side: 'b' | 'a', price: number, quantity: number, orderCount: number, minutesAfterOrigin: number): DepthLevelObservation {
  return { side, price, quantity, orderCount, timestampMs: ORIGIN + minutesAfterOrigin * 60_000 };
}

test('checkpoint: serialize -> restore round-trips the in-progress bucket exactly, admitted price-level states included', () => {
  let state = createSessionAccumulator(ORIGIN);
  // Complete two theta4 intervals, then leave a THIRD partially filled (the "partial bucket" this exists to protect).
  state = ingest(state, [obs('b', 100, 500, 3, 1), obs('a', 105, 200, 1, 1)], ORIGIN + 3 * 60_000);
  state = ingest(state, [obs('b', 100, 600, 3, 4), obs('a', 105, 250, 1, 4)], ORIGIN + 6 * 60_000);
  // Partial third interval — not yet completed (interval end would be at 9 min).
  state = ingest(state, [obs('b', 100, 700, 4, 7)], ORIGIN + 7 * 60_000);

  assert.equal(state.aggregateSnapshots.length, 2); // exactly 2 COMPLETED so far
  assert.ok(state.pendingIntervalObservations.length > 0); // the partial third bucket is real, un-lost data

  const checkpoint = serializeCheckpoint(state);
  const restored = restoreFromCheckpoint(checkpoint);

  assert.deepEqual(restored.aggregateSnapshots, state.aggregateSnapshots);
  assert.deepEqual(restored.pendingIntervalObservations, state.pendingIntervalObservations);
  assert.equal(restored.lastIntervalEndMs, state.lastIntervalEndMs);
  assert.deepEqual(restored.referenceThresholds, state.referenceThresholds);

  // Continuing to ingest into the RESTORED state completes the same
  // interval correctly — proving "continue the same interval," not start a new one.
  const continued = ingest(restored, [obs('a', 105, 300, 1, 8)], ORIGIN + 9 * 60_000);
  assert.equal(continued.aggregateSnapshots.length, 3); // the previously-partial bucket is now correctly completed
});

test('checkpoint: no missing observations are fabricated — a partial bucket with only 1 of N real ticks stays exactly that after restore', () => {
  let state = createSessionAccumulator(ORIGIN);
  state = ingest(state, [obs('b', 100, 500, 3, 1)], ORIGIN + 2 * 60_000);
  const checkpoint = serializeCheckpoint(state);
  const restored = restoreFromCheckpoint(checkpoint);
  assert.equal(restored.pendingIntervalObservations.length, 1); // exactly what was really observed, nothing padded in
});

test('restoreOrStartFresh: no checkpoint -> fresh accumulator, no gap flagged (nothing to have gapped from)', () => {
  const decision = restoreOrStartFresh(null, ORIGIN, ORIGIN + 60_000, 5 * 60_000);
  assert.equal(decision.gapDetected, false);
  assert.equal(decision.state.rawObservations.length, 0);
});

test('restoreOrStartFresh: a short downtime (within tolerance) resumes cleanly, no gap flagged', () => {
  let state = createSessionAccumulator(ORIGIN);
  state = ingest(state, [obs('b', 100, 500, 3, 1)], ORIGIN + 3 * 60_000);
  const checkpoint = serializeCheckpoint(state);
  const restartAtMs = ORIGIN + 3 * 60_000 + 30_000; // 30s later — well within tolerance
  const decision = restoreOrStartFresh(checkpoint, ORIGIN, restartAtMs, 5 * 60_000);
  assert.equal(decision.gapDetected, false);
});

test('restoreOrStartFresh: a long downtime (exceeds tolerance) is flagged as a genuine gap — never silently resumed as clean', () => {
  let state = createSessionAccumulator(ORIGIN);
  state = ingest(state, [obs('b', 100, 500, 3, 1)], ORIGIN + 3 * 60_000);
  const checkpoint = serializeCheckpoint(state);
  const restartAtMs = ORIGIN + 3 * 60_000 + 10 * 60_000; // 10 minutes later — a real gap
  const decision = restoreOrStartFresh(checkpoint, ORIGIN, restartAtMs, 5 * 60_000);
  assert.equal(decision.gapDetected, true);
  assert.ok(decision.gapDurationMs >= 10 * 60_000);
});

test('AlphaLadderStore: checkpoint save/load round-trips through the in-memory store', async () => {
  const store = createInMemoryAlphaLadderStore();
  let state = createSessionAccumulator(ORIGIN);
  state = ingest(state, [obs('b', 100, 500, 3, 1)], ORIGIN + 3 * 60_000);
  const checkpoint = serializeCheckpoint(state);
  await store.saveAccumulatorCheckpoint('2026-09-30', checkpoint);
  const loaded = await store.loadAccumulatorCheckpoint('2026-09-30');
  assert.deepEqual(loaded, checkpoint);
  const missing = await store.loadAccumulatorCheckpoint('2026-10-01');
  assert.equal(missing, null);
});
