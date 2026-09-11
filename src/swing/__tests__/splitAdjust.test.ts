import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adjustForSplits } from '../indicators/splitAdjust.ts';
import { computeSymbolIndicators } from '../scripts/computeIndicators.ts';
import type { Bar } from '../indicators/types.ts';

function bar(t: string, c: number, v = 1_000_000): Bar {
  return { t, o: c, h: c, l: c, c, v };
}

test('adjustForSplits makes a 1:1-bonus-style series continuous', () => {
  // 200 -> 210 (normal day) -> 100 (bonus halves it) -> 105 -> 110
  const bars = [bar('2026-01-01', 200), bar('2026-01-02', 210), bar('2026-01-03', 100), bar('2026-01-04', 105), bar('2026-01-05', 110)];
  const adjusted = adjustForSplits(bars);
  assert.ok(Math.abs(adjusted[0].c - 95.238) < 0.01, '200 * (100/210) ≈ 95.24');
  assert.ok(Math.abs(adjusted[1].c - 100) < 0.01, '210 * (100/210) = 100 — continuous with the post-split close');
  assert.equal(adjusted[2].c, 100, 'the split date and everything after stay untouched');
  assert.equal(adjusted[3].c, 105);
  assert.equal(adjusted[4].c, 110);
});

test('adjustForSplits handles two splits in the same series (cumulative)', () => {
  // 400 -> 200 is a pure split (no real move) -> 210 is a genuine +5% day
  // -> 100 is a second pure split. Adjusted, the two split boundaries
  // should become non-events while the real 5% move survives.
  const bars = [bar('2026-01-01', 400), bar('2026-01-02', 200), bar('2026-01-03', 210), bar('2026-01-04', 100)];
  const adjusted = adjustForSplits(bars);
  assert.ok(Math.abs(adjusted[3].c - 100) < 1e-9, 'the most recent bar is never adjusted');
  assert.ok(Math.abs(adjusted[2].c - 100) < 1e-9, 'continuous across the second split boundary');
  assert.ok(Math.abs(adjusted[0].c - adjusted[1].c) < 0.01,
    'the pure-split jump (400 -> 200) becomes a non-event once adjusted');
  assert.ok(adjusted[1].c < adjusted[2].c,
    'the genuine +5% move between bars 1 and 2 (unrelated to either split) is preserved, not erased');
});

test('adjustForSplits leaves ordinary trading days (even a big one) untouched', () => {
  const bars = [bar('2026-01-01', 100), bar('2026-01-02', 120), bar('2026-01-03', 115)]; // +20% day, well under threshold
  const adjusted = adjustForSplits(bars);
  assert.deepEqual(adjusted.map((b) => b.c), [100, 120, 115]);
});

test('adjustForSplits scales pre-split volume up so vol_ratio stays comparable across the event', () => {
  const bars = [bar('2026-01-01', 200, 500_000), bar('2026-01-02', 100, 500_000)]; // split day doubles share count
  const adjusted = adjustForSplits(bars);
  assert.equal(adjusted[1].v, 500_000, 'post-split volume is untouched');
  assert.ok(adjusted[0].v > 500_000, 'pre-split volume should scale up to match the new, larger share count');
});

test('computeSymbolIndicators produces a sane 52w-high/ATH across a split, not a 2x discontinuity', () => {
  // Reproduces the RELIANCE-shaped bug this was built to fix: a real uptrend,
  // a 1:1-style bonus that halves the price, then a continued (milder) uptrend
  // that never quite reclaims the adjusted pre-bonus peak.
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 40; i++) { bars.push(bar(`d${i}`, price)); price *= 1.01; } // trend up to ~148
  const preBonusRawPeak = bars[39].c;
  bars.push(bar('d40', preBonusRawPeak * 0.5)); // the bonus
  const postBonusFlatPrice = bars[40].c;
  // Flat afterward, deliberately — the point of this test is that ATH
  // should sit at the adjusted PRE-bonus peak, so the post-bonus segment
  // must stay clear of it rather than genuinely making a new high.
  for (let i = 41; i < 60; i++) bars.push(bar(`d${i}`, postBonusFlatPrice));

  const rows = computeSymbolIndicators(bars, new Map());
  const last = rows[rows.length - 1];
  const adjustedPreBonusPeak = preBonusRawPeak * 0.5; // what the peak becomes after adjustment
  assert.ok(Math.abs(last.high_ath! - adjustedPreBonusPeak) < adjustedPreBonusPeak * 0.02,
    `ATH (${last.high_ath}) should track the adjusted pre-bonus peak (~${adjustedPreBonusPeak.toFixed(2)}), not the raw unadjusted one`);
  // The bug this reproduces: on the RAW series, dist_ath_pct would read
  // roughly -50% (price sitting at half the unadjusted "peak"). Adjusted,
  // it should be a small, plausible distance instead.
  assert.ok(last.dist_ath_pct! > -10,
    `dist_ath_pct (${last.dist_ath_pct}) should be small and plausible, not ~-50% from an unadjusted 2x peak`);
});
