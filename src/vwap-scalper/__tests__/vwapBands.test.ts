import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVwapBands } from '../vwapBands.ts';
import type { Bar } from '../types.ts';

function flatBar(t: number, price: number, v: number): Bar {
  return { t, o: price, h: price, l: price, c: price, v };
}

test('a single bar: VWAP equals its own price, stdev is exactly 0', () => {
  const bars = [flatBar(0, 100, 500)];
  const [point] = computeVwapBands(bars);
  assert.equal(point.vwap, 100);
  assert.equal(point.stdev, 0);
  assert.equal(point.upper1, 100);
  assert.equal(point.lower3, 100);
});

test('a flat market (identical price every bar): stdev stays exactly 0 throughout', () => {
  const bars = Array.from({ length: 10 }, (_, i) => flatBar(i, 250, 1000 + i * 50));
  const points = computeVwapBands(bars);
  for (const p of points) {
    assert.equal(p.vwap, 250);
    assert.equal(p.stdev, 0);
    assert.equal(p.upper3, 250);
    assert.equal(p.lower3, 250);
  }
});

test('VWAP and volume-weighted variance match a hand-computed two-price case', () => {
  // Two bars, equal volume, prices 100 and 200 — a textbook 50/50 volume-weighted mix.
  const bars = [flatBar(0, 100, 1000), flatBar(1, 200, 1000)];
  const points = computeVwapBands(bars);
  const last = points[1];

  const expectedVwap = (100 * 1000 + 200 * 1000) / 2000; // = 150
  const expectedVariance = (100 * 100 * 1000 + 200 * 200 * 1000) / 2000 - expectedVwap * expectedVwap; // = 2500
  const expectedStdev = Math.sqrt(expectedVariance); // = 50

  assert.ok(Math.abs(last.vwap - expectedVwap) < 1e-9);
  assert.ok(Math.abs(last.stdev - expectedStdev) < 1e-9);
  assert.ok(Math.abs(last.upper1 - (expectedVwap + expectedStdev)) < 1e-9);
  assert.ok(Math.abs(last.upper2 - (expectedVwap + expectedStdev * 2)) < 1e-9);
  assert.ok(Math.abs(last.upper3 - (expectedVwap + expectedStdev * 3)) < 1e-9);
  assert.ok(Math.abs(last.lower3 - (expectedVwap - expectedStdev * 3)) < 1e-9);
});

test('a heavier-volume bar pulls VWAP toward its own price more than an equal-price-distance lighter bar', () => {
  const heavyFirst = computeVwapBands([flatBar(0, 100, 10_000), flatBar(1, 200, 100)]);
  const lightFirst = computeVwapBands([flatBar(0, 100, 100), flatBar(1, 200, 10_000)]);
  assert.ok(heavyFirst[1].vwap < lightFirst[1].vwap, 'VWAP should sit closer to whichever price carried the heavier volume');
});

test('stdevMultiplier scales the band distance from VWAP linearly, without changing VWAP itself', () => {
  const bars = [flatBar(0, 100, 1000), flatBar(1, 200, 1000)];
  const base = computeVwapBands(bars, 1.0);
  const doubled = computeVwapBands(bars, 2.0);
  assert.equal(base[1].vwap, doubled[1].vwap);
  assert.ok(Math.abs((doubled[1].upper3 - doubled[1].vwap) - 2 * (base[1].upper3 - base[1].vwap)) < 1e-9);
});

test('computeVwapBands is point-in-time: an early bar\'s VWAP never reflects a later bar\'s price', () => {
  const bars = [flatBar(0, 100, 1000), flatBar(1, 500, 1000), flatBar(2, 900, 1000)];
  const points = computeVwapBands(bars);
  assert.equal(points[0].vwap, 100); // unaffected by the 500/900 bars that come after
});

test('a custom source function (e.g. close-only) is honored instead of the hlc3 default', () => {
  const bars: Bar[] = [{ t: 0, o: 90, h: 120, l: 80, c: 95, v: 1000 }]; // hlc3 = (120+80+95)/3 = 98.33, deliberately != close
  const withHlc3 = computeVwapBands(bars); // default source
  const withClose = computeVwapBands(bars, 1.0, (b) => b.c);
  assert.notEqual(withHlc3[0].vwap, withClose[0].vwap);
  assert.equal(withClose[0].vwap, 95);
});
