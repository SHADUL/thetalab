import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSymbolIndicators } from '../scripts/computeIndicators.ts';
import type { Bar } from '../indicators/types.ts';

function bar(t: string, c: number, h = c, l = c, o = c, v = 1_000_000): Bar {
  return { t, o, h, l, c, v };
}

test('relative strength vs NIFTY matches the spec §14 worked example', () => {
  // Stock +12% over 5 sessions, NIFTY +4% over the same window -> RS +8.
  const bars: Bar[] = [
    bar('2026-01-01', 100), bar('2026-01-02', 102), bar('2026-01-03', 104),
    bar('2026-01-04', 108), bar('2026-01-05', 110), bar('2026-01-06', 112),
  ];
  const nifty = new Map<string, number>([
    ['2026-01-01', 20000], ['2026-01-02', 20100], ['2026-01-03', 20300],
    ['2026-01-04', 20500], ['2026-01-05', 20600], ['2026-01-06', 20800],
  ]);
  const rows = computeSymbolIndicators(bars, nifty);
  const last = rows[rows.length - 1];
  const stockReturn = ((112 - 100) / 100) * 100; // 12%
  const niftyReturn = ((20800 - 20000) / 20000) * 100; // 4%
  assert.ok(Math.abs(last.rs_vs_nifty_5d! - (stockReturn - niftyReturn)) < 1e-9);
});

test('52-week distance and ATH track a rolling high correctly', () => {
  const bars: Bar[] = [
    bar('2026-01-01', 100, 100), bar('2026-01-02', 120, 120), bar('2026-01-03', 90, 95),
  ];
  const rows = computeSymbolIndicators(bars, new Map());
  assert.equal(rows[1].high_52w, 120);
  assert.equal(rows[1].high_ath, 120);
  assert.equal(rows[2].high_52w, 120, '52w high stays at the prior peak even after a pullback');
  assert.equal(rows[2].high_ath, 120);
  assert.ok(Math.abs(rows[2].dist_52w_high_pct! - ((90 - 120) / 120) * 100) < 1e-9);
});

test('ATH only ever rises, never falls back with price', () => {
  // Kept within a single day's realistic trading range on purpose — a
  // 100->150 jump would trip the split-adjustment threshold in
  // computeSymbolIndicators and this test would stop testing what it says
  // it tests.
  const bars: Bar[] = [bar('2026-01-01', 100), bar('2026-01-02', 140), bar('2026-01-03', 120), bar('2026-01-04', 145)];
  const rows = computeSymbolIndicators(bars, new Map());
  assert.deepEqual(rows.map((r) => r.high_ath), [100, 140, 140, 145]);
});

test('missing NIFTY data for a date degrades relative strength to null, not a wrong number', () => {
  const bars: Bar[] = [bar('2026-01-01', 100), bar('2026-01-02', 105), bar('2026-01-03', 110), bar('2026-01-04', 115), bar('2026-01-05', 120), bar('2026-01-06', 125)];
  const rows = computeSymbolIndicators(bars, new Map()); // no NIFTY data at all
  assert.equal(rows[rows.length - 1].rs_vs_nifty_5d, null);
});

test('every row carries the moving-average and momentum fields once the lookback is satisfied', () => {
  const bars: Bar[] = Array.from({ length: 60 }, (_, i) => bar(`2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, 100 + i));
  const rows = computeSymbolIndicators(bars, new Map());
  const last = rows[rows.length - 1];
  assert.ok(last.ema20 != null);
  assert.ok(last.rsi14 != null);
  assert.ok(last.atr14 != null);
  assert.equal(last.rs_vs_sector_20d, null, 'sector RS is deliberately deferred to a later pass, not fabricated');
});
