import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mondayOf, aggregateWeekly } from '../indicators/weekly.ts';
import type { Bar } from '../indicators/types.ts';

function bar(t: string, c: number, opts: Partial<Bar> = {}): Bar {
  return { t, o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 1000 };
}

test('mondayOf: mid-week date resolves to that week\'s Monday', () => {
  assert.equal(mondayOf('2026-03-12'), '2026-03-09'); // Thursday -> Monday
});
test('mondayOf: a Monday maps to itself', () => {
  assert.equal(mondayOf('2026-03-09'), '2026-03-09');
});
test('mondayOf: a Sunday maps back to that week\'s Monday, not forward', () => {
  assert.equal(mondayOf('2026-03-15'), '2026-03-09');
});

test('aggregateWeekly: merges Mon-Fri into one bar with correct OHLCV rollup', () => {
  const bars: Bar[] = [
    bar('2026-03-09', 100, { o: 100, h: 102, l: 99, v: 10 }),  // Mon
    bar('2026-03-10', 101, { o: 100, h: 103, l: 98, v: 20 }),  // Tue
    bar('2026-03-11', 105, { o: 101, h: 106, l: 100, v: 30 }), // Wed (week high)
    bar('2026-03-13', 97, { o: 105, h: 105, l: 95, v: 40 }),   // Fri (week low, week close)
  ];
  const weekly = aggregateWeekly(bars);
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].o, 100);
  assert.equal(weekly[0].h, 106);
  assert.equal(weekly[0].l, 95);
  assert.equal(weekly[0].c, 97);
  assert.equal(weekly[0].v, 100);
  assert.equal(weekly[0].t, '2026-03-13'); // last day actually seen
});

test('aggregateWeekly: separate weeks produce separate bars, in order', () => {
  const bars: Bar[] = [
    bar('2026-03-09', 100), bar('2026-03-13', 105), // week 1
    bar('2026-03-16', 106), bar('2026-03-20', 110),  // week 2
  ];
  const weekly = aggregateWeekly(bars);
  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].c, 105);
  assert.equal(weekly[1].c, 110);
});

test('aggregateWeekly: a week missing some days (holiday) still rolls up correctly', () => {
  const bars: Bar[] = [bar('2026-03-09', 100, { o: 100 }), bar('2026-03-12', 108, { h: 110 })]; // Mon, Thu only
  const weekly = aggregateWeekly(bars);
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].h, 110);
  assert.equal(weekly[0].c, 108);
});
