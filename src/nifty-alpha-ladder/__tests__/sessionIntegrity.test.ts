import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSessionIntegrity, hasContinuousCoverageFromOpen } from '../live/sessionIntegrity.ts';
import { createSessionAccumulator, ingest, serializeCheckpoint, type AccumulatorCheckpoint } from '../live/sessionAccumulator.ts';
import { deriveHealthStatus, deriveSessionQuality, canFireNewSignal } from '../live/connectionSupervisor.ts';
import type { DepthLevelObservation } from '../types.ts';

const ORIGIN = Date.UTC(2026, 9, 6, 3, 45, 0); // 09:15:00 IST
const MIN = 60_000;
const IST = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 6, h - 5, m - 30, s); // wall-clock IST -> epoch ms

function obs(side: 'b' | 'a', price: number, quantity: number, atMs: number): DepthLevelObservation {
  return { side, price, quantity, orderCount: 2, timestampMs: atMs };
}

/** A checkpoint of a worker that observed continuously from 09:15 for `buckets` closed 3-minute buckets. */
function continuousCheckpoint(buckets: number): AccumulatorCheckpoint {
  return {
    sessionOriginMs: ORIGIN,
    aggregateSnapshots: Array.from({ length: buckets }, (_, i) => ({ timeSec: (i + 1) * 180, bidQty: 1000 + i, askQty: 800 + i })),
    pendingIntervalObservations: [obs('b', 100, 50, ORIGIN + buckets * 3 * MIN + 10_000)],
    lastIntervalEndMs: ORIGIN + buckets * 3 * MIN,
    referenceThresholds: { b: { cumulativeCount: 5, runningThreshold: 100 }, a: { cumulativeCount: 5, runningThreshold: 100 } },
    pendingWindowObservations: { b: [], a: [] },
    lastWindowFoldedAtMs: ORIGIN,
  };
}

const base = { sessionOriginMs: ORIGIN, gapDetected: false, gapDurationMs: 0, priorInvalidation: null };

test('session integrity: starts 08:55 -> valid', () => {
  const r = assessSessionIntegrity({ ...base, startMs: IST(8, 55), checkpoint: null });
  assert.equal(r.valid, true);
});

test('session integrity: starts 09:14:59 -> valid', () => {
  const r = assessSessionIntegrity({ ...base, startMs: IST(9, 14, 59), checkpoint: null });
  assert.equal(r.valid, true);
});

test('session integrity: starts 09:15 with clean state -> valid', () => {
  const r = assessSessionIntegrity({ ...base, startMs: IST(9, 15), checkpoint: null });
  assert.equal(r.valid, true);
});

test('session integrity: starts 09:20 with no checkpoint -> invalid LATE_SESSION_START', () => {
  const r = assessSessionIntegrity({ ...base, startMs: IST(9, 20), checkpoint: null });
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'LATE_SESSION_START');
});

test('session integrity: starts 11:01 with no checkpoint -> invalid, reason names the missing interval', () => {
  const r = assessSessionIntegrity({ ...base, startMs: IST(11, 1), checkpoint: null });
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'LATE_SESSION_START');
  assert.equal(r.detail, 'Late start — market data missing from 09:15 to 11:01 IST');
});

test('session integrity: restart at 11:01 with a valid checkpoint and continuous history -> valid, not a late start', () => {
  const checkpoint = continuousCheckpoint(37);
  const r = assessSessionIntegrity({ ...base, startMs: IST(11, 1), checkpoint });
  assert.equal(r.valid, true);
});

test('session integrity: restart with an unrecoverable gap -> invalid', () => {
  const r = assessSessionIntegrity({ ...base, startMs: IST(11, 1), checkpoint: continuousCheckpoint(10), gapDetected: true, gapDurationMs: 9_000_000 });
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'UNRECOVERABLE_FEED_GAP');
});

test('session integrity: once invalid, a later restart with an otherwise-clean checkpoint stays invalid', () => {
  const prior = { valid: false, reason: 'LATE_SESSION_START' as const, detail: 'Late start — market data missing from 09:15 to 11:01 IST' };
  const r = assessSessionIntegrity({ ...base, startMs: IST(12, 0), checkpoint: continuousCheckpoint(5), priorInvalidation: prior });
  assert.equal(r.valid, false);
  assert.equal(r.detail, prior.detail);
});

test('session integrity: a checkpoint whose history has a hole (missing bucket) is not provably continuous', () => {
  const cp = continuousCheckpoint(6);
  cp.aggregateSnapshots.splice(2, 1); // bucket 3 never observed
  assert.equal(hasContinuousCoverageFromOpen(cp), false);
});

test('session integrity: a legacy checkpoint with zero-filled leading buckets is not continuous', () => {
  const cp = continuousCheckpoint(6);
  cp.aggregateSnapshots[0] = { timeSec: 180, bidQty: 0, askQty: 0 };
  assert.equal(hasContinuousCoverageFromOpen(cp), false);
  const r = assessSessionIntegrity({ ...base, startMs: IST(11, 1), checkpoint: cp });
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'LATE_SESSION_START');
});

test('missing historical buckets are never inserted as zero observations', () => {
  // Worker first sees data at 11:01 IST; 09:15-11:01 was never observed.
  let state = createSessionAccumulator(ORIGIN);
  const lateStart = IST(11, 1);
  state = ingest(state, [obs('b', 100, 400, lateStart + 5_000), obs('a', 101, 300, lateStart + 5_000)], lateStart + 10_000);
  state = ingest(state, [obs('b', 100, 450, lateStart + 4 * MIN), obs('a', 101, 320, lateStart + 4 * MIN)], lateStart + 7 * MIN);
  assert.ok(state.aggregateSnapshots.length > 0, 'real post-start observations are still retained');
  for (const snap of state.aggregateSnapshots) {
    assert.ok(snap.bidQty > 0 || snap.askQty > 0, `no synthetic {0,0} bucket may exist, found one at ${snap.timeSec}s`);
  }
  const firstBucketStartSec = state.aggregateSnapshots[0].timeSec - 180;
  assert.ok(firstBucketStartSec >= (lateStart - ORIGIN) / 1000 - 180, 'no bucket exists before real data began');
  // The persisted form of this late-start state is provably NOT continuous from the open.
  assert.equal(hasContinuousCoverageFromOpen(serializeCheckpoint(state)), false);
});

test('an on-time worker still emits contiguous non-zero buckets from 180s and is provably continuous', () => {
  let state = createSessionAccumulator(ORIGIN);
  for (let w = 0; w < 4; w++) {
    state = ingest(state, [obs('b', 100, 500, ORIGIN + (w * 3 + 1) * MIN), obs('a', 101, 400, ORIGIN + (w * 3 + 1) * MIN)], ORIGIN + (w * 3 + 3) * MIN);
  }
  assert.deepEqual(state.aggregateSnapshots.map((s) => s.timeSec), [180, 360, 540, 720]);
  assert.equal(hasContinuousCoverageFromOpen(serializeCheckpoint(state)), true);
});

test('session integrity and worker health are independent: HEALTHY worker, INVALID session, no new signal', () => {
  const health = deriveHealthStatus({ nowMs: 100_000, lastSocketMessageAtMs: 99_500, isMarketHours: true, isWarmedUp: true, hasUnrecoverableGapThisWeek: true });
  assert.equal(health, 'HEALTHY');
  const quality = deriveSessionQuality(health, true);
  assert.equal(quality, 'INVALID_FOR_NEW_SIGNAL');
  assert.equal(canFireNewSignal(quality), false);
});
