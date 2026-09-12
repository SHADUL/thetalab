import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectBreakouts, breakoutQuality, closingStrength, detectConsolidation,
  detectPullback, detectGap, detectExtensionRisk, detectPatterns,
} from '../patterns/detect.ts';
import type { Bar } from '../indicators/types.ts';

function bar(t: string, c: number, opts: Partial<Bar> = {}): Bar {
  return { t, o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 1_000_000 };
}
function seq(n: number, f: (i: number) => Partial<Bar> & { c: number }): Bar[] {
  return Array.from({ length: n }, (_, i) => { const { c, ...rest } = f(i); return bar(`d${i}`, c, rest); });
}

/* ---------------- breakouts ---------------- */

test('detectBreakouts fires only when close clears the PRIOR lookback high, not including today', () => {
  const bars = seq(25, (i) => ({ c: i < 24 ? 100 : 130 })); // flat at 100 for 24 days, then a clear break
  const signals = detectBreakouts(bars, 24);
  const b20 = signals.find((s) => s.lookback === 20)!;
  assert.equal(b20.level, 100);
  assert.equal(b20.brokeOut, true);
});

test('detectBreakouts requires enough history for a lookback — null level, no false breakout', () => {
  const bars = seq(10, (i) => ({ c: 100 + i }));
  const signals = detectBreakouts(bars, 9);
  const b252 = signals.find((s) => s.lookback === 252)!;
  assert.equal(b252.level, null);
  assert.equal(b252.brokeOut, false);
});

test('closingStrength reads 1 at the day high, 0 at the day low', () => {
  assert.equal(closingStrength(bar('d', 110, { h: 110, l: 100 })), 1);
  assert.equal(closingStrength(bar('d', 100, { h: 110, l: 100 })), 0);
  assert.equal(closingStrength(bar('d', 105, { h: 110, l: 100 })), 0.5);
});

test('breakoutQuality rewards volume confirmation and a strong close, not just clearing the level', () => {
  const bars = seq(25, (i) => ({ c: i < 24 ? 100 : 110, h: i < 24 ? 100 : 110, l: i < 24 ? 100 : 108 }));
  const signals = detectBreakouts(bars, 24);
  const weakVolume = breakoutQuality(bars, 24, signals, 0.6)!;
  const strongVolume = breakoutQuality(bars, 24, signals, 2.5)!;
  assert.ok(strongVolume > weakVolume, 'exceptional volume should score higher than weak volume for the same breakout');
});

test('breakoutQuality is null when nothing broke out', () => {
  const bars = seq(25, (i) => ({ c: 100 + Math.sin(i) }));
  const signals = detectBreakouts(bars, 24).map((s) => ({ ...s, brokeOut: false }));
  assert.equal(breakoutQuality(bars, 24, signals, 1.2), null);
});

/* ---------------- consolidation ---------------- */

test('detectConsolidation flags a tight recent range after a genuinely wider one', () => {
  const bars = [
    ...seq(50, (i) => ({ c: 100 + (i % 2 === 0 ? 5 : -5) })), // wide chop to set a real long-window ATR
    ...seq(10, (i) => ({ c: 100 + (i % 2 === 0 ? 0.3 : -0.3) })), // then tighten up sharply
  ];
  const result = detectConsolidation(bars, bars.length - 1);
  assert.equal(result.inConsolidation, true);
  assert.ok(result.contractionRatio! < 0.65);
});

test('detectConsolidation does not fire when recent volatility matches the longer window', () => {
  const bars = seq(70, (i) => ({ c: 100 + (i % 2 === 0 ? 5 : -5) })); // uniformly choppy throughout
  const result = detectConsolidation(bars, bars.length - 1);
  assert.equal(result.inConsolidation, false);
});

/* ---------------- pullback ---------------- */

test('detectPullback identifies a controlled pullback to the 20 EMA in an uptrend', () => {
  const bars: Bar[] = [];
  let price = 100;
  // A steady climb alone doesn't bring price back near its own EMA20 — a
  // sustained trend keeps EMA20 lagging well behind price. A pullback
  // setup needs the trend to first level off (letting the EMA catch up)
  // before a small dip actually reaches it. Real intraday range (not the
  // helper's h=l=c default) matters here too: the "near the EMA" check is
  // in ATR units, and h=l=c collapses true range down to close-to-close
  // only, making ATR artificially tiny and the tolerance artificially
  // tight.
  const wick = (c: number) => ({ h: c * 1.006, l: c * 0.994 });
  for (let i = 0; i < 60; i++) { bars.push(bar(`d${i}`, price, wick(price))); price *= 1.004; }
  for (let i = 0; i < 20; i++) bars.push(bar(`f${i}`, price, wick(price)));
  bars.push(bar('pullback', price * 0.99, wick(price * 0.99)));
  const result = detectPullback(bars, bars.length - 1);
  assert.equal(result.toEma20 || result.toEma50, true);
});

test('detectPullback does not fire in a downtrend just because price is near an EMA', () => {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) { bars.push(bar(`d${i}`, price)); price *= 0.99; } // steady downtrend
  const result = detectPullback(bars, bars.length - 1);
  assert.equal(result.toEma20, false);
  assert.equal(result.toEma50, false);
});

/* ---------------- gaps ---------------- */

test('detectGap classifies a real overnight gap but not ordinary noise', () => {
  const bars = [bar('d0', 100, { h: 101, l: 99 }), bar('d1', 105, { o: 104, h: 106, l: 103 })];
  const gapUp = detectGap(bars, 1);
  assert.equal(gapUp.type, 'GAP_UP');

  const smallMove = [bar('d0', 100), bar('d1', 100.5, { o: 100.5 })];
  assert.equal(detectGap(smallMove, 1).type, 'NONE');
});

test('detectGap on the first bar of a series is never a gap (nothing to gap from)', () => {
  assert.equal(detectGap([bar('d0', 100)], 0).type, 'NONE');
});

/* ---------------- extension risk ---------------- */

test('detectExtensionRisk is LOW for price sitting near its own moving average', () => {
  // A small back-and-forth, not a perfectly flat line (a truly flat series
  // has zero losses ever, which pushes Wilder RSI to a degenerate 100 —
  // avgLoss divides by zero) and not a smooth sine wave either (its long,
  // gradual monotonic stretches rack up an unrealistic streak of
  // consecutive up-days no real stock's daily noise would produce). A
  // small alternating zigzag is closer to what "quiet, unextended trading"
  // actually looks like day to day. Real intraday range matters here too,
  // same reason as the pullback test above.
  const bars = seq(60, (i) => {
    const c = 100 + (i % 2 === 0 ? 0.4 : -0.3);
    return { c, h: c * 1.006, l: c * 0.994 };
  });
  assert.equal(detectExtensionRisk(bars, 59), 'LOW');
});

test('detectExtensionRisk rises for a stock that has run far above its 20 EMA on a streak of green days', () => {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 40; i++) { bars.push(bar(`d${i}`, price)); price *= 1.001; }
  for (let i = 40; i < 48; i++) { bars.push(bar(`d${i}`, price)); price *= 1.06; } // sharp vertical run
  const risk = detectExtensionRisk(bars, bars.length - 1);
  assert.notEqual(risk, 'LOW');
});

/* ---------------- end-to-end / no-look-ahead ---------------- */

test('detectPatterns never looks past asOfIdx — appending future bars changes nothing about a past read', () => {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) { bars.push(bar(`d${i}`, price)); price *= 1.01; }
  const asOf = 40;
  const resultBefore = detectPatterns(bars, asOf);
  // Simulate the backtest engine calling this on a truncated series for the same date.
  const resultTruncated = detectPatterns(bars.slice(0, asOf + 1), asOf);
  assert.deepEqual(resultBefore, resultTruncated,
    'result for a historical date must be identical whether or not future bars exist in the array');
});

test('detectPatterns tags a fresh, realistically-sized breakout with strong volume as BREAKOUT_CONFIRMED', () => {
  // A full year of ordinary daily noise (~1.5-2% true range, the kind any
  // real liquid stock has), then a breakout day that opens near the prior
  // close and rallies ~2.5% through the session on volume — clears the
  // 20-day high decisively without the kind of one-day gap that would make
  // "just broke out" and "already extended" the same thing by construction.
  const bars: Bar[] = [];
  for (let i = 0; i < 260; i++) {
    const c = 100 + (i % 10) * 0.3 + Math.sin(i / 7) * 1.5;
    bars.push(bar(`d${i}`, c, { h: c * 1.008, l: c * 0.992 }));
  }
  const prevClose = bars[bars.length - 1].c;
  bars.push(bar('breakout', prevClose * 1.025,
    { o: prevClose * 1.002, h: prevClose * 1.03, l: prevClose * 0.998, v: 4_000_000 }));

  const result = detectPatterns(bars, bars.length - 1);
  assert.equal(result.entryStatus, 'BREAKOUT_CONFIRMED');
  assert.ok(result.setupTypes.includes('BREAKOUT'));
});

test('detectPatterns marks a heavily extended stock EXTENDED regardless of an otherwise-good setup', () => {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 40; i++) { bars.push(bar(`d${i}`, price)); price *= 1.001; }
  for (let i = 40; i < 50; i++) { bars.push(bar(`d${i}`, price, { h: price, l: price * 0.99 })); price *= 1.07; }
  const result = detectPatterns(bars, bars.length - 1);
  assert.equal(result.extensionRisk, 'HIGH');
  assert.equal(result.entryStatus, 'EXTENDED');
  assert.ok(result.setupTypes.includes('EXTENDED'));
});
