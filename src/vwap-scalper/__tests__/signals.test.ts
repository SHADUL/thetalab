import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVwapBands } from '../vwapBands.ts';
import { detectVwapScalperSignals, computeEma } from '../signals.ts';
import type { Bar, VwapScalperParams } from '../types.ts';

/**
 * A controllable fixture: a long flat run (large volume, tight range) so
 * VWAP and stdev settle to a known, stable baseline — then one deliberate
 * "excursion" bar whose h/l/c can be set precisely to test touch/rejection
 * against the resulting 3σ band.
 */
function baselineBars(n: number, price: number, v: number): Bar[] {
  // Alternate the close by a tiny amount so stdev is a small, non-zero,
  // predictable number rather than exactly 0 (which would make "beyond 3σ"
  // trivially true for almost any excursion and not a meaningful test).
  return Array.from({ length: n }, (_, i) => {
    const c = price + (i % 2 === 0 ? 0.5 : -0.5);
    return { t: i, o: c, h: c, l: c, c, v };
  });
}

const BASE_PARAMS: VwapScalperParams = { stdevMultiplier: 1, entryMode: 'REJECTION', slopeFilter: null, trendFilter: null, stopLoss: null };

test('Touch mode fires a SHORT signal the instant a bar\'s high reaches the upper 3σ band, using the current close as entry', () => {
  const bars = baselineBars(30, 100, 1000);
  const bands = computeVwapBands(bars);
  const upper3 = bands[bands.length - 1].upper3;
  // Margin generous enough to clear the self-referential band shift this
  // one new (large, volume-weighted) bar itself causes — the excursion
  // bar's own price pulls VWAP/stdev slightly as it's included in the
  // cumulative sums, so upper3 AT this bar is not identical to upper3
  // computed from the bars strictly before it.
  const excursion: Bar = { t: 30, o: 100, h: upper3 + 2, l: 99.9, c: upper3 + 1.5, v: 1000 };
  const allBars = [...bars, excursion];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, { ...BASE_PARAMS, entryMode: 'TOUCH' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'SHORT');
  assert.equal(signals[0].barIndex, 30);
  assert.equal(signals[0].entryPrice, excursion.c);
});

test('Rejection mode does NOT fire when the bar touches 3σ but closes beyond it (no rejection yet)', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const excursion: Bar = { t: 30, o: 100, h: upper3 + 0.5, l: 99.9, c: upper3 + 0.2, v: 1000 }; // closes BEYOND upper3
  const allBars = [...bars, excursion];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS);
  assert.equal(signals.length, 0);
});

test('Rejection mode fires exactly when the bar touches 3σ and closes back inside it', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const excursion: Bar = { t: 30, o: 100, h: upper3 + 0.3, l: 99.9, c: upper3 - 0.1, v: 1000 }; // touches, closes back inside
  const allBars = [...bars, excursion];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'SHORT');
});

test('an unconfirmed (still-forming) last bar suppresses a Rejection-mode signal on that bar only', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const excursion: Bar = { t: 30, o: 100, h: upper3 + 0.3, l: 99.9, c: upper3 - 0.1, v: 1000 };
  const allBars = [...bars, excursion];
  const allBands = computeVwapBands(allBars);

  const suppressed = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS, /* lastBarUnconfirmed */ true);
  assert.equal(suppressed.length, 0);

  const confirmed = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS, false);
  assert.equal(confirmed.length, 1);
});

test('one signal per excursion: a second touch does not re-fire until price closes back inside the 2σ band', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper2 = bandsSoFar[bandsSoFar.length - 1].upper2;
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;

  // First excursion: touch+reject -> fires. Second bar: still outside 2σ
  // (no genuine retreat) but pokes 3σ again -> must NOT re-fire. Third
  // bar: closes back inside 2σ (re-arms). Fourth bar: touches 3σ again -> fires again.
  const bar1: Bar = { t: 30, o: 100, h: upper3 + 0.3, l: 99.9, c: upper3 - 0.1, v: 1000 };
  const bar2: Bar = { t: 31, o: 100, h: upper3 + 0.4, l: 99.9, c: upper3 - 0.05, v: 1000 }; // still outside 2σ, touches 3σ again
  const bar3: Bar = { t: 32, o: 100, h: upper2 - 0.5, l: 99, c: upper2 - 0.5, v: 1000 }; // closes back inside 2σ
  const bar4: Bar = { t: 33, o: 100, h: upper3 + 0.3, l: 99.9, c: upper3 - 0.1, v: 1000 }; // touches 3σ again

  const allBars = [...bars, bar1, bar2, bar3, bar4];
  const allBands = computeVwapBands(allBars);
  const signals = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS);

  assert.equal(signals.length, 2, `expected exactly 2 signals (re-arm gate working), got ${signals.length}`);
  assert.equal(signals[0].barIndex, 30);
  assert.equal(signals[1].barIndex, 33);
});

test('a SHORT signal firing does not block or reset the LONG side\'s readiness, and vice versa', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const lower3 = bandsSoFar[bandsSoFar.length - 1].lower3;

  const shortBar: Bar = { t: 30, o: 100, h: upper3 + 0.3, l: 99.9, c: upper3 - 0.1, v: 1000 };
  const longBar: Bar = { t: 31, o: 100, h: 100.1, l: lower3 - 0.3, c: lower3 + 0.1, v: 1000 };

  const allBars = [...bars, shortBar, longBar];
  const allBands = computeVwapBands(allBars);
  const signals = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS);

  assert.equal(signals.length, 2);
  assert.equal(signals[0].direction, 'SHORT');
  assert.equal(signals[1].direction, 'LONG');
});

test('the EMA trend filter blocks a SHORT signal when close is above the EMA (trend still up)', () => {
  // A steadily rising baseline so the EMA sits below the current close.
  const bars: Bar[] = Array.from({ length: 40 }, (_, i) => {
    const c = 100 + i * 0.5;
    return { t: i, o: c, h: c, l: c, c, v: 1000 };
  });
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  // A rising baseline already carries a lot of natural variance, so a
  // single new bar shifts the self-referential band further than the flat
  // baseline elsewhere in this file — margin sized generously to clear that.
  const excursion: Bar = { t: 40, o: 100, h: upper3 + 5, l: 119, c: upper3 - 2, v: 1000 };
  const allBars = [...bars, excursion];
  const allBands = computeVwapBands(allBars);

  const withFilter = detectVwapScalperSignals(allBars, allBands, { ...BASE_PARAMS, trendFilter: { emaLength: 20 } });
  assert.equal(withFilter.length, 0, 'SHORT should be blocked: close is above a rising EMA, filter requires close < EMA for SHORT');

  const withoutFilter = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS);
  assert.equal(withoutFilter.length, 1, 'sanity check: the same setup fires without the filter');
});

test('a degenerate zero-stdev bar (e.g. the very first bar, before any variance accumulates) never fires a spurious signal on either side', () => {
  // The very first bar: stdev is exactly 0 (see vwapBands.test.ts), so the
  // bands collapse to a single point equal to VWAP. Without the stdev>0
  // guard, a flat bar (h === l === c === vwap) would trivially "touch"
  // BOTH the upper and lower 3σ bands at once.
  const bars: Bar[] = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 1000 }];
  const bands = computeVwapBands(bars);
  const signals = detectVwapScalperSignals(bars, bands, { ...BASE_PARAMS, entryMode: 'TOUCH' });
  assert.deepEqual(signals, []);
});

test('computeEma warms up correctly: null before the period is reached, a real number at and after it', () => {
  const values = Array.from({ length: 30 }, (_, i) => 100 + i);
  const ema = computeEma(values, 10);
  for (let i = 0; i < 9; i++) assert.equal(ema[i], null);
  assert.notEqual(ema[9], null);
  assert.notEqual(ema[29], null);
});

test('stop price is computed per the selected mode and attached to the emitted signal', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const excursion: Bar = { t: 30, o: 100, h: upper3 + 0.3, l: 99.9, c: upper3 - 0.1, v: 1000 };
  const allBars = [...bars, excursion];
  const allBands = computeVwapBands(allBars);

  const noStop = detectVwapScalperSignals(allBars, allBands, BASE_PARAMS);
  assert.equal(noStop[0].stopPrice, null);

  const pctStop = detectVwapScalperSignals(allBars, allBands, {
    ...BASE_PARAMS, stopLoss: { mode: 'PERCENTAGE', percent: 0.5, sigmaBuffer: 0 },
  });
  assert.ok(Math.abs(pctStop[0].stopPrice! - excursion.c * 1.005) < 1e-9);

  const sigmaStop = detectVwapScalperSignals(allBars, allBands, {
    ...BASE_PARAMS, stopLoss: { mode: 'BEYOND_3SIGMA', percent: 0, sigmaBuffer: 0.5 },
  });
  const lastBand = allBands[allBands.length - 1];
  assert.ok(Math.abs(sigmaStop[0].stopPrice! - (lastBand.upper3 + 0.5 * lastBand.stdev)) < 1e-9);
});

test('CANDLE_REVERSAL fires SHORT: a green candle touches +3σ, the NEXT candle is red and closes back below it', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const touchBar: Bar = { t: 30, o: 100, h: upper3 + 4, l: 99.5, c: upper3 + 3, v: 1000 }; // green (c > o), touches well beyond +3σ
  const confirmBar: Bar = { t: 31, o: upper3 + 3, h: upper3 + 3.2, l: upper3 - 4, c: upper3 - 3, v: 1000 }; // red (c < o), closes well below +3σ
  const allBars = [...bars, touchBar, confirmBar];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, { ...BASE_PARAMS, entryMode: 'CANDLE_REVERSAL' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'SHORT');
  assert.equal(signals[0].barIndex, 31);
  assert.equal(signals[0].entryPrice, confirmBar.c);
});

test('CANDLE_REVERSAL fires LONG: a red candle touches -3σ, the NEXT candle is green and closes back above it', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const lower3 = bandsSoFar[bandsSoFar.length - 1].lower3;
  const touchBar: Bar = { t: 30, o: 100, h: 100.5, l: lower3 - 4, c: lower3 - 3, v: 1000 }; // red (c < o), touches well beyond -3σ
  const confirmBar: Bar = { t: 31, o: lower3 - 3, h: lower3 + 4, l: lower3 - 3.2, c: lower3 + 3, v: 1000 }; // green (c > o), closes well above -3σ
  const allBars = [...bars, touchBar, confirmBar];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, { ...BASE_PARAMS, entryMode: 'CANDLE_REVERSAL' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'LONG');
  assert.equal(signals[0].barIndex, 31);
  assert.equal(signals[0].entryPrice, confirmBar.c);
});

test('CANDLE_REVERSAL does NOT fire SHORT when the touch candle is red instead of green, even if its wick reaches +3σ', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const touchBar: Bar = { t: 30, o: upper3 + 3, h: upper3 + 4, l: 99.5, c: 100, v: 1000 }; // RED (c < o) despite the high reaching +3σ
  const confirmBar: Bar = { t: 31, o: 100, h: upper3 + 3.2, l: upper3 - 4, c: upper3 - 3, v: 1000 };
  const allBars = [...bars, touchBar, confirmBar];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, { ...BASE_PARAMS, entryMode: 'CANDLE_REVERSAL' });
  assert.equal(signals.length, 0);
});

test('CANDLE_REVERSAL does NOT fire SHORT when the confirming candle does not close back below the band', () => {
  const bars = baselineBars(30, 100, 1000);
  const bandsSoFar = computeVwapBands(bars);
  const upper3 = bandsSoFar[bandsSoFar.length - 1].upper3;
  const touchBar: Bar = { t: 30, o: 100, h: upper3 + 4, l: 99.5, c: upper3 + 3, v: 1000 };
  const confirmBar: Bar = { t: 31, o: upper3 + 3, h: upper3 + 3.5, l: upper3 + 1, c: upper3 + 2, v: 1000 }; // red, but STILL closes above +3σ
  const allBars = [...bars, touchBar, confirmBar];
  const allBands = computeVwapBands(allBars);

  const signals = detectVwapScalperSignals(allBars, allBands, { ...BASE_PARAMS, entryMode: 'CANDLE_REVERSAL' });
  assert.equal(signals.length, 0);
});

test('CANDLE_REVERSAL never fires on the very first bar (no prior bar to have touched anything)', () => {
  const bars: Bar[] = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 1000 }];
  const bands = computeVwapBands(bars);
  const signals = detectVwapScalperSignals(bars, bands, { ...BASE_PARAMS, entryMode: 'CANDLE_REVERSAL' });
  assert.equal(signals.length, 0);
});

test('CANDLE_REVERSAL respects the same one-signal-per-excursion re-arm rule as the other entry modes', () => {
  // Each touch bar is itself a large excursion, which shifts VWAP/stdev
  // meaningfully for every bar after it (unlike the single-excursion tests
  // elsewhere in this file) — so each confirm bar's target close is
  // computed from the ACTUAL bands including its own touch bar, not a
  // stale precomputed estimate, to reliably land it above +2σ (no
  // accidental same-bar re-arm) but below +3σ (a valid confirmation).
  let bars = baselineBars(30, 100, 1000);

  function addTouchAndConfirm(t: number) {
    const upper3Before = computeVwapBands(bars).at(-1)!.upper3;
    bars = [...bars, { t, o: 100, h: upper3Before + 4, l: 99.5, c: upper3Before + 3, v: 1000 }];

    const afterTouch = computeVwapBands(bars).at(-1)!;
    const gap = afterTouch.upper3 - afterTouch.upper2;
    const confirmClose = afterTouch.upper3 - gap * 0.3; // comfortably between +2σ and +3σ
    bars = [...bars, { t: t + 1, o: afterTouch.upper3 + 3, h: afterTouch.upper3 + 3.2, l: confirmClose - 0.2, c: confirmClose, v: 1000 }];
  }

  addTouchAndConfirm(30); // fires SHORT #1 at index 31
  addTouchAndConfirm(32); // no genuine retreat since #1 — must NOT fire again
  bars = [...bars, { t: 34, o: 100, h: 100.5, l: 99.5, c: 100, v: 1000 }]; // unambiguous retreat to baseline — re-arms
  addTouchAndConfirm(35); // fires SHORT #2 at index 36

  const allBands = computeVwapBands(bars);
  const signals = detectVwapScalperSignals(bars, allBands, { ...BASE_PARAMS, entryMode: 'CANDLE_REVERSAL' });

  assert.equal(signals.length, 2, `expected exactly 2 signals, got ${signals.length}`);
  assert.equal(signals[0].barIndex, 31);
  assert.equal(signals[1].barIndex, 36);
});
