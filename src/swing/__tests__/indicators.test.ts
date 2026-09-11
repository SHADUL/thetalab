import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sma, ema } from '../indicators/movingAverages.ts';
import { rsi, macd } from '../indicators/oscillators.ts';
import { atr, adx, classifyADX } from '../indicators/trend.ts';
import { bollinger } from '../indicators/bands.ts';
import { volumeRatio, classifyVolumeRatio } from '../indicators/volume.ts';
import type { Bar } from '../indicators/types.ts';

/** A flat series with no range at all — every indicator has a known,
 *  checkable answer here without needing to trust a memorised reference
 *  table for a real price series. */
function flatBars(price: number, n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: `2026-01-${String(i + 1).padStart(2, '0')}`, o: price, h: price, l: price, c: price, v: 1_000_000,
  }));
}

function trendingBars(start: number, step: number, n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + step * i;
    return { t: `2026-01-${String(i + 1).padStart(2, '0')}`, o: c - step, h: c + Math.abs(step) * 0.2, l: c - Math.abs(step) * 0.2, c, v: 1_000_000 };
  });
}

function sidewaysBars(mid: number, amplitude: number, n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = mid + (i % 2 === 0 ? amplitude : -amplitude);
    return { t: `2026-01-${String(i + 1).padStart(2, '0')}`, o: mid, h: mid + amplitude, l: mid - amplitude, c, v: 1_000_000 };
  });
}

/* ---------------- moving averages ---------------- */

test('SMA and EMA of a constant series equal that constant', () => {
  const closes = flatBars(100, 40).map((b) => b.c);
  const s = sma(closes, 20);
  const e = ema(closes, 20);
  for (let i = 19; i < closes.length; i++) {
    assert.ok(Math.abs(s[i]! - 100) < 1e-9);
    assert.ok(Math.abs(e[i]! - 100) < 1e-9);
  }
  assert.equal(s[18], null);
  assert.equal(e[18], null);
});

test('EMA reacts faster than SMA to a step change', () => {
  const closes = [...flatBars(100, 20).map((b) => b.c), ...flatBars(120, 5).map((b) => b.c)];
  const s = sma(closes, 20)[closes.length - 1]!;
  const e = ema(closes, 20)[closes.length - 1]!;
  assert.ok(e > s, `EMA (${e}) should have moved further toward 120 than SMA (${s})`);
});

/* ---------------- RSI ---------------- */

test('RSI is 100 for a strictly rising series (no losses ever)', () => {
  const closes = trendingBars(100, 1, 30).map((b) => b.c);
  const r = rsi(closes, 14);
  assert.equal(r[14], 100);
  assert.equal(r[r.length - 1], 100);
});

test('RSI is 0 for a strictly falling series (no gains ever)', () => {
  const closes = trendingBars(100, -1, 30).map((b) => b.c);
  const r = rsi(closes, 14);
  assert.equal(r[14], 0);
});

test('RSI stays within [0, 100] and is null before the lookback', () => {
  const closes = sidewaysBars(100, 3, 40).map((b) => b.c);
  const r = rsi(closes, 14);
  assert.equal(r[13], null);
  for (const v of r) if (v != null) assert.ok(v >= 0 && v <= 100);
});

/* ---------------- ATR ---------------- */

test('ATR is 0 for a series with zero true range every session', () => {
  const bars = flatBars(500, 30);
  const a = atr(bars, 14);
  assert.equal(a[14], 0);
  assert.equal(a[a.length - 1], 0);
});

test('ATR is positive once there is real range, and null before period+1 bars', () => {
  const bars = trendingBars(500, 5, 30);
  const a = atr(bars, 14);
  assert.equal(a[13], null);
  assert.ok(a[14]! > 0);
});

/* ---------------- ADX ---------------- */

test('ADX distinguishes a clean trend from a sideways chop', () => {
  const trend = adx(trendingBars(500, 4, 60), 14);
  const chop = adx(sidewaysBars(500, 4, 60), 14);
  const trendLast = trend[trend.length - 1];
  const chopLast = chop[chop.length - 1];
  assert.ok(trendLast, 'trending series should produce a defined ADX');
  assert.ok(chopLast, 'sideways series should produce a defined ADX');
  assert.ok(trendLast!.adx > chopLast!.adx,
    `trending ADX (${trendLast!.adx}) should exceed chop ADX (${chopLast!.adx})`);
  assert.ok(trendLast!.plusDI > trendLast!.minusDI, 'an uptrend should show +DI dominant');
});

test('ADX classification bands match spec §11', () => {
  assert.equal(classifyADX(10), 'weak');
  assert.equal(classifyADX(17), 'developing');
  assert.equal(classifyADX(22), 'moderate');
  assert.equal(classifyADX(30), 'strong');
  assert.equal(classifyADX(40), 'very-strong');
  assert.equal(classifyADX(null), null);
});

test('ADX is null until there are enough bars to seed both smoothings', () => {
  const short = adx(trendingBars(500, 4, 20), 14);
  assert.ok(short.every((v) => v == null));
});

/* ---------------- MACD ---------------- */

test('MACD histogram is ~0 for a flat series (fast EMA == slow EMA == price)', () => {
  const closes = flatBars(100, 60).map((b) => b.c);
  const m = macd(closes);
  const last = m[m.length - 1]!;
  assert.ok(Math.abs(last.macd) < 1e-6);
  assert.ok(Math.abs(last.histogram) < 1e-6);
});

test('MACD is positive when the fast EMA has pulled above the slow EMA', () => {
  const closes = [...flatBars(100, 40).map((b) => b.c), ...trendingBars(100, 3, 30).map((b) => b.c)];
  const m = macd(closes);
  const last = m[m.length - 1]!;
  assert.ok(last.macd > 0, 'a sustained rally should leave the fast EMA above the slow EMA');
});

/* ---------------- Bollinger ---------------- */

test('Bollinger bands collapse to the price for a zero-variance series', () => {
  const closes = flatBars(200, 30).map((b) => b.c);
  const b = bollinger(closes, 20);
  const last = b[b.length - 1]!;
  assert.equal(last.middle, 200);
  assert.equal(last.upper, 200);
  assert.equal(last.lower, 200);
  assert.equal(last.bandwidthPct, 0);
});

test('Bollinger upper is always >= middle >= lower', () => {
  const closes = sidewaysBars(200, 8, 40).map((b) => b.c);
  const b = bollinger(closes, 20);
  for (const p of b) if (p) {
    assert.ok(p.upper >= p.middle);
    assert.ok(p.middle >= p.lower);
  }
});

/* ---------------- volume ---------------- */

test('volume ratio classification matches spec §12 bands', () => {
  assert.equal(classifyVolumeRatio(0.5), 'weak');
  assert.equal(classifyVolumeRatio(0.85), 'normal');
  assert.equal(classifyVolumeRatio(1.2), 'positive');
  assert.equal(classifyVolumeRatio(1.8), 'strong');
  assert.equal(classifyVolumeRatio(2.5), 'exceptional');
  assert.equal(classifyVolumeRatio(null), null);
});

test('volume ratio of a constant-volume series is 1', () => {
  const volumes = flatBars(100, 30).map((b) => b.v);
  const r = volumeRatio(volumes, 20);
  assert.ok(Math.abs(r[r.length - 1]! - 1) < 1e-9);
});
