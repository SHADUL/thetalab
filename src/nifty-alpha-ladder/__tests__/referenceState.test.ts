import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  restoreSide, chooseStartingReferenceState, buildPersistedState, shouldPersistReference,
  MAX_REFERENCE_STATE_AGE_DAYS, REFERENCE_SOURCE_MODE, type PersistedReferenceState, type ReferenceSource,
} from '../live/referenceState.ts';
import { createSessionAccumulator, ingest, serializeCheckpoint } from '../live/sessionAccumulator.ts';
import { foldWindow, empiricalQuantile, initialReferenceThreshold } from '../signal/largeOrderNet.ts';
import { createInMemoryAlphaLadderStore } from '../persistence/store.ts';
import { THETA } from '../parameters.ts';
import type { DepthLevelObservation } from '../types.ts';

const MIN = 60_000;
const WINDOW_MS = THETA.LARGE_ORDER_REFERENCE_WINDOW_MIN * MIN;
const DAY1 = Date.UTC(2026, 9, 7, 3, 45); // 09:15 IST
const DAY2 = Date.UTC(2026, 9, 8, 3, 45);
const OCT_FUT: ReferenceSource = { instrumentToken: 12468226, tradingsymbol: 'NIFTY26OCTFUT' };
const NOV_FUT: ReferenceSource = { instrumentToken: 12555555, tradingsymbol: 'NIFTY26NOVFUT' };

function obs(side: 'b' | 'a', qty: number, atMs: number, price = 100): DepthLevelObservation {
  return { side, price, quantity: qty, orderCount: 3, timestampMs: atMs };
}

/** One completed 15-minute window: `n` bid observations of `bidQty` and `m` ask observations of `askQty`. */
function runWindows(origin: number, state = createSessionAccumulator(origin), spec: Array<{ n: number; bidQty: number; m: number; askQty: number }>) {
  spec.forEach((w, i) => {
    const t = origin + i * WINDOW_MS + 60_000;
    const batch = [
      ...Array.from({ length: w.n }, () => obs('b', w.bidQty, t)),
      ...Array.from({ length: w.m }, () => obs('a', w.askQty, t, 105)),
    ];
    ingest(state, batch, origin + (i + 1) * WINDOW_MS);
  });
  return state;
}

const DAY1_SPEC = [{ n: 1000, bidQty: 400, m: 1200, askQty: 500 }, { n: 800, bidQty: 450, m: 900, askQty: 520 }];

function persistBoth(store: ReturnType<typeof createInMemoryAlphaLadderStore>, state: ReturnType<typeof createSessionAccumulator>, source: ReferenceSource, nowMs: number) {
  return Promise.all((['b', 'a'] as const).map((side) =>
    store.saveReferenceState(buildPersistedState(side, state.referenceThresholds[side], source, state.lastWindowFoldedAtMs, nowMs))));
}

test('day 1 persists the reference state (count, q_hat, source key, fold time, version, mode) per side', async () => {
  const store = createInMemoryAlphaLadderStore();
  const day1 = runWindows(DAY1, undefined, DAY1_SPEC);
  await persistBoth(store, day1, OCT_FUT, DAY1 + 6 * 3600_000);
  const bid = (await store.loadReferenceState('b'))!;
  const ask = (await store.loadReferenceState('a'))!;
  assert.equal(bid.cumulativeCount, 1800);
  assert.equal(ask.cumulativeCount, 2100);
  assert.equal(bid.sourceInstrumentToken, OCT_FUT.instrumentToken);
  assert.equal(bid.sourceTradingsymbol, 'NIFTY26OCTFUT');
  assert.equal(bid.sourceMode, REFERENCE_SOURCE_MODE);
  assert.equal(bid.lastWindowFoldedAtMs, DAY1 + 2 * WINDOW_MS);
  assert.equal(bid.runningThreshold, day1.referenceThresholds.b.runningThreshold);
  assert.equal(ask.runningThreshold, day1.referenceThresholds.a.runningThreshold);
});

test('day 2 restores the exact persisted state and cumulative N / q_hat continue the existing recursion', async () => {
  const store = createInMemoryAlphaLadderStore();
  const day1 = runWindows(DAY1, undefined, DAY1_SPEC);
  await persistBoth(store, day1, OCT_FUT, DAY1 + 6 * 3600_000);

  const decision = chooseStartingReferenceState({
    checkpoint: null, persistedBid: await store.loadReferenceState('b'), persistedAsk: await store.loadReferenceState('a'),
    source: OCT_FUT, nowMs: DAY2 + 60_000,
  });
  assert.equal(decision.origin, 'PERSISTED');
  assert.equal(decision.outcomes.b!.restored, true);
  assert.deepEqual(decision.state.b, day1.referenceThresholds.b);
  assert.deepEqual(decision.state.a, day1.referenceThresholds.a);

  const day2 = createSessionAccumulator(DAY2);
  day2.referenceThresholds = decision.state;
  const day2Spec = [{ n: 320, bidQty: 480, m: 330, askQty: 510 }];
  runWindows(DAY2, day2, day2Spec);

  const expectedBid = foldWindow(day1.referenceThresholds.b, { windowCount: 320, windowQuantile: empiricalQuantile(Array(320).fill(480)) });
  const expectedAsk = foldWindow(day1.referenceThresholds.a, { windowCount: 330, windowQuantile: empiricalQuantile(Array(330).fill(510)) });
  assert.equal(day2.referenceThresholds.b.cumulativeCount, 1800 + 320);
  assert.equal(day2.referenceThresholds.a.cumulativeCount, 2100 + 330);
  assert.equal(day2.referenceThresholds.b.runningThreshold, expectedBid.runningThreshold);
  assert.equal(day2.referenceThresholds.a.runningThreshold, expectedAsk.runningThreshold);
});

test('a same-day restart restores from the checkpoint ONLY — persisted state is not applied on top (no double counting)', async () => {
  const store = createInMemoryAlphaLadderStore();
  const sameDay = runWindows(DAY1, undefined, DAY1_SPEC);
  await persistBoth(store, sameDay, OCT_FUT, DAY1 + 3600_000);
  const checkpoint = serializeCheckpoint(sameDay);
  const decision = chooseStartingReferenceState({
    checkpoint, persistedBid: await store.loadReferenceState('b'), persistedAsk: await store.loadReferenceState('a'),
    source: OCT_FUT, nowMs: DAY1 + 2 * 3600_000,
  });
  assert.equal(decision.origin, 'CHECKPOINT');
  assert.equal(decision.state.b.cumulativeCount, 1800); // not 3600
  assert.equal(decision.state.a.cumulativeCount, 2100);
});

test('persisting is gated on a newly completed window and is idempotent (an upsert, not an append)', async () => {
  assert.equal(shouldPersistReference(null, DAY1), true);
  assert.equal(shouldPersistReference(DAY1 + WINDOW_MS, DAY1 + WINDOW_MS), false);
  assert.equal(shouldPersistReference(DAY1 + WINDOW_MS, DAY1 + 2 * WINDOW_MS), true);
  const store = createInMemoryAlphaLadderStore();
  const s = runWindows(DAY1, undefined, DAY1_SPEC);
  await persistBoth(store, s, OCT_FUT, 1);
  await persistBoth(store, s, OCT_FUT, 2);
  assert.equal((await store.loadReferenceState('b'))!.cumulativeCount, 1800);
});

test('BID and ASK are independent: a malformed ASK resets only ASK while BID is restored', async () => {
  const store = createInMemoryAlphaLadderStore();
  const day1 = runWindows(DAY1, undefined, DAY1_SPEC);
  await persistBoth(store, day1, OCT_FUT, DAY1 + 3600_000);
  const badAsk = { ...(await store.loadReferenceState('a'))!, cumulativeCount: -5 };
  const d = chooseStartingReferenceState({ checkpoint: null, persistedBid: await store.loadReferenceState('b'), persistedAsk: badAsk, source: OCT_FUT, nowMs: DAY2 });
  assert.equal(d.outcomes.b!.restored, true);
  assert.equal(d.state.b.cumulativeCount, 1800);
  assert.equal(d.outcomes.a!.restored, false);
  assert.equal(d.outcomes.a!.reason, 'MALFORMED');
  assert.deepEqual(d.state.a, initialReferenceThreshold());
});

test('same contract: state is preserved across a restart', async () => {
  const store = createInMemoryAlphaLadderStore();
  await persistBoth(store, runWindows(DAY1, undefined, DAY1_SPEC), OCT_FUT, DAY1 + 3600_000);
  const o = restoreSide('b', await store.loadReferenceState('b'), OCT_FUT, DAY1 + 2 * 3600_000);
  assert.equal(o.restored, true);
  assert.equal(o.state.cumulativeCount, 1800);
});

test('contract roll: a different instrument token is an explicit SOURCE_CHANGED reset — no cross-contract mixing', async () => {
  const store = createInMemoryAlphaLadderStore();
  await persistBoth(store, runWindows(DAY1, undefined, DAY1_SPEC), OCT_FUT, DAY1 + 3600_000);
  for (const side of ['b', 'a'] as const) {
    const o = restoreSide(side, await store.loadReferenceState(side), NOV_FUT, DAY2);
    assert.equal(o.restored, false);
    assert.equal(o.reason, 'SOURCE_CHANGED');
    assert.match(o.detail, /NIFTY26OCTFUT/);
    assert.match(o.detail, /NIFTY26NOVFUT/);
    assert.deepEqual(o.state, initialReferenceThreshold());
  }
});

test('strategy version or source mode change resets rather than trusting old statistics', async () => {
  const store = createInMemoryAlphaLadderStore();
  await persistBoth(store, runWindows(DAY1, undefined, DAY1_SPEC), OCT_FUT, DAY1 + 3600_000);
  const row = (await store.loadReferenceState('b'))!;
  assert.equal(restoreSide('b', { ...row, strategyVersion: 'HEDGED133_V9' }, OCT_FUT, DAY2).reason, 'STRATEGY_VERSION_CHANGED');
  assert.equal(restoreSide('b', { ...row, sourceMode: 'SOMETHING_ELSE' }, OCT_FUT, DAY2).reason, 'SOURCE_MODE_CHANGED');
});

test('malformed / missing / stale persisted state fails safe to a zero reset', () => {
  const good: PersistedReferenceState = buildPersistedState('b', { cumulativeCount: 100, runningThreshold: 50 }, OCT_FUT, DAY1, DAY1);
  const now = DAY1 + 3600_000;
  assert.equal(restoreSide('b', null, OCT_FUT, now).reason, 'NO_PRIOR_STATE');
  assert.equal(restoreSide('b', undefined, OCT_FUT, now).reason, 'NO_PRIOR_STATE');
  assert.equal(restoreSide('b', { ...good, cumulativeCount: NaN }, OCT_FUT, now).reason, 'MALFORMED');
  assert.equal(restoreSide('b', { ...good, cumulativeCount: 10.5 }, OCT_FUT, now).reason, 'MALFORMED');
  assert.equal(restoreSide('b', { ...good, runningThreshold: -1 }, OCT_FUT, now).reason, 'MALFORMED');
  assert.equal(restoreSide('b', { ...good, sourceInstrumentToken: undefined }, OCT_FUT, now).reason, 'MALFORMED');
  assert.equal(restoreSide('b', { ...good, side: 'a' }, OCT_FUT, now).reason, 'MALFORMED');
  assert.equal(restoreSide('b', { ...good, lastWindowFoldedAtMs: now + 3600_000 }, OCT_FUT, now).reason, 'STALE');
  assert.equal(restoreSide('b', { ...good, lastWindowFoldedAtMs: now - (MAX_REFERENCE_STATE_AGE_DAYS + 1) * 86_400_000 }, OCT_FUT, now).reason, 'STALE');
  assert.deepEqual(restoreSide('b', { ...good, cumulativeCount: NaN }, OCT_FUT, now).state, initialReferenceThreshold());
});

test('a pre-migration row (null source columns) is treated as malformed, never trusted', () => {
  const legacy = { side: 'b', cumulativeCount: 90_000, runningThreshold: 300, sourceInstrumentToken: null, sourceTradingsymbol: null, lastWindowFoldedAtMs: NaN, strategyVersion: null, sourceMode: null, updatedAtMs: 1 };
  assert.equal(restoreSide('b', legacy, OCT_FUT, DAY2).reason, 'MALFORMED');
});

test('the 150,000 warm-up threshold is unchanged and the carried count activates classification exactly as before', () => {
  assert.equal(THETA.LARGE_ORDER_WARMUP_COUNT, 150_000);
  assert.equal(THETA.LARGE_ORDER_REFERENCE_WINDOW_MIN, 15);
});
