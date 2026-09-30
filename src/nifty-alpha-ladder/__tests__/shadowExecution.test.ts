import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketableLimitPrice } from '../execution/marketableLimit.ts';
import { simulateFill } from '../execution/shadowFillModel.ts';
import { simulateEntrySequence, noNakedShortInvariantHolds, type LegSpec } from '../execution/entrySequencer.ts';
import { simulateRollback } from '../execution/rollback.ts';
import { simulateShortFirstExit, type ExitLegSpec } from '../exit/shortFirstExit.ts';
import { exitRepricingBuffer, lateSessionFloor, effectiveRepricingBuffer } from '../exit/repricing.ts';
import { targetDistance, effectiveTarget, targetHit, targetProgress } from '../monitor/futuresMonitor.ts';
import { deriveHealthStatus, deriveSessionQuality, canFireNewSignal, evaluateReconnectIntegrity } from '../live/connectionSupervisor.ts';

// ---- marketableLimit ----
test('marketable limit: worked-example buffer/rounding reproduces the PDF values', () => {
  assert.ok(Math.abs(marketableLimitPrice('BUY', 111.20, 0.05) - 120.10) < 0.01);
  assert.ok(Math.abs(marketableLimitPrice('BUY', 17.30, 0.05) - 20.30) < 0.01);
  assert.ok(Math.abs(marketableLimitPrice('SELL', 47.60, 0.05) - 43.75) < 0.01);
});

test('marketable limit: a sale is never priced at or below zero', () => {
  assert.ok(marketableLimitPrice('SELL', 0.10, 0.05) > 0);
});

// ---- shadowFillModel ----
test('shadow fill: BUY fills only when ask <= limit (touch fill on the first check)', () => {
  const outcome = simulateFill('BUY', 120, 111.35, [{ atMs: 0, bid: 110, ask: 118 }], 5000);
  assert.equal(outcome.filled, true);
  assert.equal(outcome.status, 'TOUCH_FILL');
  assert.equal(outcome.fillPrice, 118);
});

test('shadow fill: never assumes instant fill at LTP — a limit not yet marketable does not fill', () => {
  const outcome = simulateFill('BUY', 100, 100, [{ atMs: 0, bid: 95, ask: 105 }], 5000);
  assert.equal(outcome.filled, false);
  assert.equal(outcome.status, 'LIMIT_NOT_MARKETABLE');
});

test('shadow fill: SELL fills only when bid >= limit', () => {
  const outcome = simulateFill('SELL', 43.75, 47.60, [{ atMs: 0, bid: 44, ask: 50 }], 5000);
  assert.equal(outcome.filled, true);
  assert.equal(outcome.fillPrice, 44);
});

test('shadow fill: times out when the touch never crosses the limit within the deadline', () => {
  const outcome = simulateFill('BUY', 100, 100, [
    { atMs: 0, bid: 95, ask: 105 },
    { atMs: 1000, bid: 95, ask: 104 },
  ], 500);
  assert.equal(outcome.filled, false);
});

// ---- entrySequencer ----
function leg(side: 'BUY' | 'SELL', ask: number, bid: number, ref: number): LegSpec {
  return { side, tradingsymbol: 'X', quantity: 100, tick: 0.05, referencePrice: ref, snapshots: [{ atMs: 0, bid, ask }] };
}

test('entry sequence: every leg fills -> COMPLETE', () => {
  const legs: LegSpec[] = [leg('BUY', 105, 95, 100), leg('BUY', 20, 15, 17), leg('SELL', 45, 48, 47)];
  const result = simulateEntrySequence(legs);
  assert.equal(result.state, 'COMPLETE');
  assert.ok(result.legResults.every((r) => r.outcome.filled));
});

test('entry sequence: leg 1 fails -> ABANDONED, nothing rolled back', () => {
  const legs: LegSpec[] = [
    { side: 'BUY', tradingsymbol: 'X', quantity: 100, tick: 0.05, referencePrice: 100, snapshots: [] }, // never fills
    leg('BUY', 20, 15, 17),
    leg('SELL', 45, 48, 47),
  ];
  const result = simulateEntrySequence(legs);
  assert.equal(result.state, 'ABANDONED');
  assert.deepEqual(result.rollbackIndices, []);
});

test('entry sequence: leg 2 fails after leg 1 filled -> ROLLBACK, leg 1 flagged for unwind', () => {
  const legs: LegSpec[] = [
    leg('BUY', 105, 95, 100),
    { side: 'BUY', tradingsymbol: 'Y', quantity: 100, tick: 0.05, referencePrice: 17, snapshots: [] }, // never fills
    leg('SELL', 45, 48, 47),
  ];
  const result = simulateEntrySequence(legs);
  assert.equal(result.state, 'ROLLBACK');
  assert.deepEqual(result.rollbackIndices, [0]);
});

test('entry sequence: leg 3 fails after legs 1+2 filled -> ROLLBACK of both', () => {
  const legs: LegSpec[] = [
    leg('BUY', 105, 95, 100),
    leg('BUY', 20, 15, 17),
    { side: 'SELL', tradingsymbol: 'Z', quantity: 500, tick: 0.05, referencePrice: 47, snapshots: [] }, // never fills
  ];
  const result = simulateEntrySequence(legs);
  assert.equal(result.state, 'ROLLBACK');
  assert.deepEqual(result.rollbackIndices, [0, 1]);
});

test('no-naked-short invariant holds for a normal completed entry (2 longs before the short)', () => {
  const legs: LegSpec[] = [leg('BUY', 105, 95, 100), leg('BUY', 20, 15, 17), leg('SELL', 45, 48, 47)];
  const result = simulateEntrySequence(legs);
  assert.equal(noNakedShortInvariantHolds(result.legResults), true);
});

test('no-naked-short invariant DETECTS a violation if a short leg somehow filled with no prior long coverage', () => {
  const violating = [
    { leg: leg('SELL', 45, 48, 47), limit: 43.75, outcome: { filled: true, status: 'TOUCH_FILL' as const, fillPrice: 48, fillAtMs: 0, slippageVsReference: 0 } },
  ];
  assert.equal(noNakedShortInvariantHolds(violating as any), false);
});

// ---- rollback ----
test('rollback: reverse placement order, filled legs unwound', () => {
  const legs: LegSpec[] = [leg('BUY', 105, 95, 100), leg('BUY', 20, 15, 17)];
  const entry = simulateEntrySequence(legs);
  const filledIdx = [0, 1];
  const rollback = simulateRollback(entry.legResults, filledIdx, () => [{ atMs: 0, bid: 200, ask: 210 }]);
  assert.equal(rollback.fullyUnwound, true);
  // Reverse order: leg 1 (index 1) unwound before leg 0.
  assert.deepEqual(rollback.legs.map((l) => l.originalLegIndex), [1, 0]);
  assert.deepEqual(rollback.legs.map((l) => l.compensatingSide), ['SELL', 'SELL']); // both original legs were BUY
});

test('rollback: stops and reports non-full-unwind when a compensating order cannot be established', () => {
  const legs: LegSpec[] = [leg('BUY', 105, 95, 100), leg('BUY', 20, 15, 17)];
  const entry = simulateEntrySequence(legs);
  const rollback = simulateRollback(entry.legResults, [0, 1], (idx) => (idx === 1 ? [] : [{ atMs: 0, bid: 90, ask: 100 }]));
  assert.equal(rollback.fullyUnwound, false);
  assert.equal(rollback.legs.length, 1); // stopped after the first (leg 1, reverse order) failed
});

// ---- shortFirstExit ----
function exitLeg(entrySide: 'BUY' | 'SELL', legIndex: number, ask: number, bid: number, ref: number): ExitLegSpec {
  return { legIndex, entrySide, quantity: 100, tick: 0.05, referencePrice: ref, snapshots: [{ atMs: 0, bid, ask }] };
}

test('short-first exit: all shorts close, then longs release', () => {
  const legs: ExitLegSpec[] = [exitLeg('BUY', 0, 105, 95, 100), exitLeg('SELL', 2, 45, 48, 47)];
  const result = simulateShortFirstExit(legs);
  assert.equal(result.allShortsClosed, true);
  assert.equal(result.shortResults.length, 1);
  assert.equal(result.longResults.length, 1);
  assert.equal(result.heldOpenLegIndices.length, 0);
});

test('short-first exit: a failed short leaves protective longs OPEN on purpose', () => {
  const legs: ExitLegSpec[] = [
    exitLeg('BUY', 0, 105, 95, 100),
    { legIndex: 2, entrySide: 'SELL', quantity: 100, tick: 0.05, referencePrice: 47, snapshots: [] }, // never fills
  ];
  const result = simulateShortFirstExit(legs);
  assert.equal(result.allShortsClosed, false);
  assert.deepEqual(result.heldOpenLegIndices, [0]);
  assert.equal(result.longResults.length, 0); // never even attempted
});

// ---- repricing ----
test('repricing schedule matches theta30/theta31 bands exactly', () => {
  assert.equal(exitRepricingBuffer(0), 0.025);
  assert.equal(exitRepricingBuffer(5), 0.05);
  assert.equal(exitRepricingBuffer(12), 0.10);
  assert.equal(lateSessionFloor(0), 0.18);
  assert.equal(lateSessionFloor(5), 0.24);
  assert.equal(lateSessionFloor(12), 0.30);
});

test('effective repricing buffer is floored by the late-session schedule only after 15:20', () => {
  assert.equal(effectiveRepricingBuffer(0, false), 0.025);
  assert.equal(effectiveRepricingBuffer(0, true), 0.18); // floored up
  assert.equal(effectiveRepricingBuffer(12, true), 0.30);
});

// ---- futuresMonitor ----
test('monitor target: 300 points Wed-Fri, 400 Mon-Tue', () => {
  assert.equal(targetDistance('Wednesday'), 300);
  assert.equal(targetDistance('Friday'), 300);
  assert.equal(targetDistance('Monday'), 400);
  assert.equal(targetDistance('Tuesday'), 400);
});

test('monitor target: bullish and bearish targets, worked-example values', () => {
  const bearish = { direction: -1 as const, f0: 24_211.80 };
  assert.ok(Math.abs(effectiveTarget(bearish, 'Wednesday') - 23_911.80) < 1e-9);
  assert.ok(Math.abs(effectiveTarget(bearish, 'Monday') - 23_811.80) < 1e-9);
  const bullish = { direction: 1 as const, f0: 24_211.80 };
  assert.ok(Math.abs(effectiveTarget(bullish, 'Wednesday') - 24_511.80) < 1e-9);
});

test('monitor target hit detection: bearish target hit when future falls to/through target', () => {
  const state = { direction: -1 as const, f0: 24_211.80 };
  assert.equal(targetHit(state, 23_900, 'Wednesday'), true); // at/below target (23,911.80)
  assert.equal(targetHit(state, 24_000, 'Wednesday'), false); // not yet
});

test('monitor F0 is never mutated — the caller must pass the same object through unchanged', () => {
  const state = Object.freeze({ direction: 1 as const, f0: 24_211.80 });
  assert.doesNotThrow(() => effectiveTarget(state, 'Tuesday'));
});

test('monitor progress: clamped to [0, distance], never overshoots past 100%', () => {
  const state = { direction: -1 as const, f0: 24_211.80 };
  const progress = targetProgress(state, 23_500, 'Wednesday'); // moved 711.8 pts, more than the 300 target
  assert.equal(progress.travelled, 300);
  assert.equal(progress.distance, 300);
});

// ---- connectionSupervisor ----
test('health status: never HEALTHY merely because the process is alive — stale feed is reported STALE', () => {
  const status = deriveHealthStatus({ nowMs: 100_000, lastSocketMessageAtMs: 50_000, isMarketHours: true, isWarmedUp: true, hasUnrecoverableGapThisWeek: false });
  assert.equal(status, 'STALE');
});

test('health status: HEALTHY requires fresh messages AND completed warmup', () => {
  const status = deriveHealthStatus({ nowMs: 100_000, lastSocketMessageAtMs: 99_000, isMarketHours: true, isWarmedUp: false, hasUnrecoverableGapThisWeek: false });
  assert.equal(status, 'WARMING_UP');
});

test('session quality: a material gap invalidates the whole week, not just the gap moment', () => {
  assert.equal(deriveSessionQuality('HEALTHY', true), 'INVALID_FOR_NEW_SIGNAL');
  assert.equal(canFireNewSignal(deriveSessionQuality('HEALTHY', true)), false);
});

test('session quality: healthy + no gap -> VALID, new signals may fire', () => {
  assert.equal(deriveSessionQuality('HEALTHY', false), 'VALID');
  assert.equal(canFireNewSignal('VALID'), true);
});

test('reconnect integrity: only HEALTHY when every condition passes', () => {
  const good = evaluateReconnectIntegrity({ subscriptionReestablished: true, newDataFlowing: true, durableStateRestored: true, gapDurationMs: 1000, maxRecoverableGapMs: 60_000 });
  assert.equal(good.healthy, true);
  const bad = evaluateReconnectIntegrity({ subscriptionReestablished: true, newDataFlowing: false, durableStateRestored: true, gapDurationMs: 1000, maxRecoverableGapMs: 60_000 });
  assert.equal(bad.healthy, false);
  assert.match(bad.reason!, /no new data/);
});
