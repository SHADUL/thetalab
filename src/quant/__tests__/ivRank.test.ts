import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ivRankAndPercentile, MIN_WINDOW_DAYS, type IvHistoryPoint } from '../analytics/ivRank.ts';

function history(values: number[]): IvHistoryPoint[] {
  return values.map((atmIv, i) => ({ date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10), atmIv }));
}

test('refuses to compute with fewer than MIN_WINDOW_DAYS usable observations', () => {
  const h = history([0.1, 0.11, 0.12]);
  assert.equal(ivRankAndPercentile(h, 0.11), null);
});

test('refuses a non-positive current IV', () => {
  const h = history(Array.from({ length: 30 }, (_, i) => 0.1 + i * 0.001));
  assert.equal(ivRankAndPercentile(h, 0), null);
  assert.equal(ivRankAndPercentile(h, -0.05), null);
});

test('rank is exactly 0 at the window min and 100 at the window max', () => {
  const values = Array.from({ length: 30 }, (_, i) => 0.10 + i * 0.005); // 0.10 .. 0.245
  const h = history(values);
  const atMin = ivRankAndPercentile(h, Math.min(...values));
  const atMax = ivRankAndPercentile(h, Math.max(...values));
  assert.ok(atMin && atMax);
  assert.equal(atMin!.rank, 0);
  assert.equal(atMax!.rank, 100);
});

test('rank lands at the linear midpoint for a value exactly between min and max', () => {
  const values = Array.from({ length: 25 }, (_, i) => 0.10 + i * 0.01); // 0.10 .. 0.34
  const h = history(values);
  const mid = (Math.min(...values) + Math.max(...values)) / 2;
  const result = ivRankAndPercentile(h, mid);
  assert.ok(result);
  assert.ok(Math.abs(result!.rank - 50) < 1e-9);
});

test('a flat history (min === max) reports rank 50 rather than dividing by zero', () => {
  const h = history(Array.from({ length: 25 }, () => 0.12));
  const result = ivRankAndPercentile(h, 0.12);
  assert.ok(result);
  assert.equal(result!.rank, 50);
});

test('percentile counts strictly-lower historical observations, robust to one outlier unlike rank', () => {
  // 24 calm days at 0.10, one spike at 0.50 — current IV of 0.11 is barely
  // above the calm baseline but the spike distorts rank toward the floor.
  const values = [...Array.from({ length: 24 }, () => 0.10), 0.50];
  const h = history(values);
  const result = ivRankAndPercentile(h, 0.11);
  assert.ok(result);
  // rank is dragged near 0 by the outlier (0.11 is only slightly above the 0.10 floor of a 0.10-0.50 range)...
  assert.ok(result!.rank < 5, `rank should be distorted low by the spike: ${result!.rank}`);
  // ...but percentile correctly reports "higher than all 24 calm days" (96%), unaffected by the spike's magnitude.
  assert.ok(result!.percentile > 90, `percentile should be robust to the outlier's magnitude: ${result!.percentile}`);
});

test('null atmIv observations are excluded from the window, not treated as zero', () => {
  const values = Array.from({ length: 25 }, (_, i) => 0.10 + i * 0.01);
  const h: IvHistoryPoint[] = history(values);
  h.push({ date: '2025-02-15', atmIv: null }); // an expiry-day session with no usable IV
  const result = ivRankAndPercentile(h, values[10]);
  assert.ok(result);
  assert.equal(result!.windowDays, 25); // the null observation must not count toward the window
});

test('lookbackDays restricts to the trailing window, not the whole history', () => {
  // 300 calm days at 0.10, then 30 richer days spanning 0.18 -> 0.235 — the
  // SAME current IV (0.20, mid-way through the rich regime) should rank very
  // differently depending on which window it's measured against: modestly
  // rich against its own recent regime, but rich against a long window still
  // anchored to the calm 0.10 floor.
  const calm = Array.from({ length: 300 }, () => 0.10);
  const rich = Array.from({ length: 30 }, (_, i) => 0.18 + i * 0.0019); // 0.18 .. 0.235
  const h = history([...calm, ...rich]);
  const current = 0.20;
  const shortLookback = ivRankAndPercentile(h, current, 29); // window = rich regime only
  const longLookback = ivRankAndPercentile(h, current, 329); // window = calm + rich
  assert.ok(shortLookback && longLookback);
  assert.equal(shortLookback!.windowDays, 29);
  assert.equal(longLookback!.windowDays, 329);
  assert.ok(longLookback!.rank > shortLookback!.rank, 'the same IV should rank higher against a window still anchored to the calm floor');
});

test('exactly MIN_WINDOW_DAYS observations is the boundary: one fewer refuses, exactly enough computes', () => {
  const justEnough = history(Array.from({ length: MIN_WINDOW_DAYS }, (_, i) => 0.10 + i * 0.001));
  const oneShort = history(Array.from({ length: MIN_WINDOW_DAYS - 1 }, (_, i) => 0.10 + i * 0.001));
  assert.notEqual(ivRankAndPercentile(justEnough, 0.105), null);
  assert.equal(ivRankAndPercentile(oneShort, 0.105), null);
});
