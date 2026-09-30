import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialReferenceThreshold,
  foldWindow,
  isThresholdActive,
  isLargeOrderLevel,
  buildLargeOrderEvents,
  computeG1Knots,
  computeG1Area,
  empiricalQuantile,
} from '../signal/largeOrderNet.ts';
import { THETA } from '../parameters.ts';
import type { DepthLevelObservation, ReferenceThresholdState } from '../types.ts';

test('quantile warmup: threshold inactive below θ2 observations, active at/above it', () => {
  let state = initialReferenceThreshold();
  state = foldWindow(state, { windowCount: THETA.LARGE_ORDER_WARMUP_COUNT - 1, windowQuantile: 500 });
  assert.equal(isThresholdActive(state), false);
  state = foldWindow(state, { windowCount: 1, windowQuantile: 500 });
  assert.equal(isThresholdActive(state), true);
});

test('reference threshold recursion is a count-weighted mean of window quantiles, not the pooled quantile', () => {
  let state = initialReferenceThreshold();
  state = foldWindow(state, { windowCount: 100, windowQuantile: 200 });
  state = foldWindow(state, { windowCount: 300, windowQuantile: 600 });
  // (100*200 + 300*600) / 400 = 500
  assert.equal(state.runningThreshold, 500);
  assert.equal(state.cumulativeCount, 400);
});

test('a level only classifies as large-order once active and strictly above threshold', () => {
  const active: ReferenceThresholdState = { cumulativeCount: THETA.LARGE_ORDER_WARMUP_COUNT, runningThreshold: 1000 };
  const inactive: ReferenceThresholdState = { cumulativeCount: 0, runningThreshold: 1000 };
  assert.equal(isLargeOrderLevel(1001, active), true);
  assert.equal(isLargeOrderLevel(1000, active), false); // strictly greater required
  assert.equal(isLargeOrderLevel(999999, inactive), false); // not active yet
});

test('empiricalQuantile: θ1=0.85 nearest-rank on a known sample', () => {
  const sample = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(empiricalQuantile(sample, 0.85), 85);
});

const alwaysLargeThreshold = () => ({ cumulativeCount: THETA.LARGE_ORDER_WARMUP_COUNT, runningThreshold: 0 });

test('a genuinely new large-order level at a fresh price is recorded as an event', () => {
  const obs: DepthLevelObservation[] = [{ side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: Date.parse('2026-09-30T09:16:10Z') }];
  const events = buildLargeOrderEvents(obs, alwaysLargeThreshold);
  assert.equal(events.length, 1);
  assert.equal(events[0].side, 'b');
  assert.equal(events[0].quantity, 500);
});

test('a level whose quantity changes at the same price, in a DIFFERENT minute, emits a second event', () => {
  const t0 = Date.parse('2026-09-30T09:16:10Z');
  const obs: DepthLevelObservation[] = [
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t0 },
    { side: 'b', price: 100, quantity: 700, orderCount: 3, timestampMs: t0 + 70_000 }, // next minute
  ];
  const events = buildLargeOrderEvents(obs, alwaysLargeThreshold);
  assert.equal(events.length, 2);
});

test('a level whose quantity changes twice within the SAME minute is merged into one stored event (summed), not two', () => {
  const t0 = Date.parse('2026-09-30T09:16:10Z');
  const obs: DepthLevelObservation[] = [
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t0 },
    { side: 'b', price: 100, quantity: 700, orderCount: 3, timestampMs: t0 + 5_000 }, // same minute, quantity changed
  ];
  const events = buildLargeOrderEvents(obs, alwaysLargeThreshold);
  assert.equal(events.length, 1);
  assert.equal(events[0].quantity, 500 + 700); // per Definition 2.2: merged events are SUMMED, not replaced
});

test('an unchanged level (same price, same quantity and order count) does not re-emit', () => {
  const t0 = Date.parse('2026-09-30T09:16:10Z');
  const obs: DepthLevelObservation[] = [
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t0 },
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t0 + 5000 },
  ];
  const events = buildLargeOrderEvents(obs, alwaysLargeThreshold);
  assert.equal(events.length, 1);
});

test('a disappeared level is forgotten — its reappearance (even at the SAME quantity) is a brand-new event, not suppressed as unchanged', () => {
  const t0 = Date.parse('2026-09-30T09:16:10Z');
  const t1 = t0 + 70_000; // next minute: this level drops below threshold (no longer "large")
  const t2 = t1 + 70_000; // the minute after: reappears at the SAME quantity as t0
  const threshold = (side: 'b' | 'a', ts: number) =>
    ts === t1 ? { cumulativeCount: THETA.LARGE_ORDER_WARMUP_COUNT, runningThreshold: 1_000_000 } : { cumulativeCount: THETA.LARGE_ORDER_WARMUP_COUNT, runningThreshold: 0 };
  const obs: DepthLevelObservation[] = [
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t0 },
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t1 }, // filtered out (not large this instant)
    { side: 'b', price: 100, quantity: 500, orderCount: 3, timestampMs: t2 }, // same qty as t0, but state was forgotten at t1
  ];
  const events = buildLargeOrderEvents(obs, threshold);
  assert.equal(events.length, 2); // one at t0's minute, one at t2's minute — NOT merged/suppressed as "unchanged"
});

test('events of the same side/price/clock-minute are merged (summed) and stamped at the minute start', () => {
  const base = Date.parse('2026-09-30T09:16:00Z');
  const obs: DepthLevelObservation[] = [
    { side: 'b', price: 100, quantity: 300, orderCount: 2, timestampMs: base + 5_000 },
    { side: 'b', price: 200, quantity: 400, orderCount: 1, timestampMs: base + 40_000 },
  ];
  const events = buildLargeOrderEvents(obs, alwaysLargeThreshold);
  assert.equal(events.length, 1);
  assert.equal(events[0].timestampMs, base);
  assert.equal(events[0].quantity, 700);
  assert.equal(events[0].orderCount, 3);
});

test('minute aggregation: events at different minutes stay separate knots', () => {
  const t0 = Date.parse('2026-09-30T09:16:00Z');
  const events = [
    { side: 'b' as const, timestampMs: t0, quantity: 420, orderCount: 1 },
    { side: 'b' as const, timestampMs: t0 + 8 * 60_000, quantity: 1380 - 420, orderCount: 1 },
  ];
  const knots = computeG1Knots(events, t0);
  assert.equal(knots.length, 2);
  assert.equal(knots[0].value, 420);
  assert.equal(knots[1].value, 1380);
});

test('signed area (G1): reproduces the worked example to within floating-point tolerance', () => {
  const t0 = Date.parse('2026-09-30T09:16:00Z');
  const knotTimes = ['09:16', '09:24', '09:35', '09:47', '09:58', '10:06', '10:15'];
  const values = [420, 1380, 2610, 1950, 3240, 2880, 3700];
  const events = knotTimes.map((hm, i) => {
    const [h, m] = hm.split(':').map(Number);
    const ts = Date.UTC(2026, 8, 30, h, m, 0);
    return { side: 'b' as const, timestampMs: ts, quantity: i === 0 ? values[0] : values[i] - values[i - 1], orderCount: 1 };
  });
  const knots = computeG1Knots(events, t0);
  const tauStarSec = 56 * 60; // 10:12, 56 minutes after 09:16
  const area = computeG1Area(knots, tauStarSec);
  assert.ok(Math.abs(area - 7_707_000) < 1, `expected ~7,707,000, got ${area}`);
});
