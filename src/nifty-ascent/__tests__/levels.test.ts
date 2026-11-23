import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGap, openingRange, williamsGapEligible, williamsLevels, itmStrike, strikeStep } from '../core/levels.ts';
import { RESEARCH_RULES_V1 as R, barStart } from '../core/rules.ts';
import { MinuteBarBuilder } from '../core/bars.ts';
import { buyFees, sellFees } from '../core/costs.ts';

const orCloses = (vals: number[]) => vals.map((close, i) => ({ label: R.orFirstBar + i, close }));

test('research rules v1 are frozen and match the specification', () => {
  assert.ok(Object.isFrozen(R));
  assert.equal(R.orLastBar - R.orFirstBar + 1, 31);
  assert.deepEqual([R.bandFraction, R.williamsFraction, R.fixedStopFactor, R.trailActivationFactor, R.trailStopFactor, R.itmPoints], [0.10, 0.5, 0.70, 1.05, 0.80, 150]);
  assert.deepEqual([R.gapGoFirstBar, R.gapGoLastBar, R.williamsLastBar, R.timeExitMinute, R.prevCloseBar], [586, 720, 869, 915, 915]);
  assert.throws(() => { (R as any).bandFraction = 0.2; });
});

test('opening range: exactly 31 CLOSES, 10% band example 24,000/24,100 → 24,110/23,990', () => {
  const vals = Array.from({ length: 31 }, (_, i) => 24050 + ((i * 13) % 50) - 25);
  vals[3] = 24100; vals[20] = 24000;
  const or = openingRange(orCloses(vals), R);
  assert.deepEqual([or.high, or.low, or.width, or.upsideBand, or.downsideBand], [24100, 24000, 100, 24110, 23990]);
  assert.throws(() => openingRange(orCloses(vals.slice(0, 30)), R), /31/);
  assert.throws(() => openingRange([...orCloses(vals.slice(1)), { label: R.orLastBar + 1, close: 24050 }], R), /outside/);
});

test('opening range ignores candle highs/lows: built from bar closes only', () => {
  const date = '2026-11-18';
  const b = new MinuteBarBuilder(date, 555, 929);
  for (let m = 555; m <= 585; m++) {
    const s = barStart(date, m);
    b.add(s, s + 1, 25000 + 500);       // spike high inside the minute
    b.add(s + 59_000, s + 59_001, 25000 + (m % 5)); // the close
  }
  const bars = b.confirmUntil(barStart(date, 586) + 1500, 1500);
  assert.equal(bars.length, 31);
  const or = openingRange(bars.map((x) => ({ label: x.label, close: x.close! })), R);
  assert.equal(or.high, 25004);
  assert.ok(bars.every((x) => x.high === 25500), 'highs exist but were not used');
});

test('gap direction, points and exact percentage', () => {
  assert.deepEqual([computeGap(25100, 25250).direction, computeGap(25100, 25250).points], ['UP', 150]);
  assert.equal(computeGap(25100, 24960).direction, 'DOWN');
  assert.equal(computeGap(25100, 25100).direction, 'NONE');
  assert.equal(computeGap(25100, 25150.2).pct.toFixed(4), '0.2000');
});

test('Williams gap-size boundaries are exact (both gap directions)', () => {
  const cases: Array<[number, boolean]> = [[10019.99, true], [10020, false], [10035, false], [10049.99, false], [10050, true], [10080, true], [10000.5, true]];
  for (const [open, ok] of cases) {
    assert.equal(williamsGapEligible(computeGap(10000, open), R), ok, `up ${open}`);
    assert.equal(williamsGapEligible(computeGap(10000, 20000 - open), R), ok, `down ${20000 - open}`);
  }
  // 0.2000% on a real NIFTY level: 25,100 → 25,150.20
  assert.equal(williamsGapEligible(computeGap(25100, 25150.2), R), false);
  assert.equal(williamsGapEligible(computeGap(25100, 25150.19), R), true);
});

test('Williams levels use previous-day CLOSES and exactly 50% of the range', () => {
  const w = williamsLevels(25130, [25150, 25260, 25010, 25100], R);
  assert.deepEqual([w.prevHighClose, w.prevLowClose, w.range, w.ceLevel, w.peLevel], [25260, 25010, 250, 25255, 25005]);
});

test('Q7/Q8: 150-point ITM strike from the signal close; halfway ties go deeper ITM', () => {
  assert.equal(itmStrike(25298.34, 'CE', 150, 50), 25150);
  assert.equal(itmStrike(24927.89, 'PE', 150, 50), 25100);
  assert.equal(itmStrike(25125, 'CE', 150, 50), 24950); // 24,975 is halfway → lower (deeper ITM call)
  assert.equal(itmStrike(25125, 'PE', 150, 50), 25300); // 25,275 is halfway → higher (deeper ITM put)
  assert.equal(itmStrike(25124.99, 'CE', 150, 50), 24950);
  assert.equal(itmStrike(25125.01, 'CE', 150, 50), 25000);
  assert.equal(strikeStep([24900, 24950, 25000, 25100, 25200], 25000), 50);
  assert.equal(strikeStep([], 25000), null);
});

test('bars: start-labelled, confirmed only after end + grace, late/duplicate/out-of-order dropped', () => {
  const date = '2026-11-18';
  const b = new MinuteBarBuilder(date, 555, 929);
  const s = barStart(date, 555);
  assert.equal(b.add(s + 59_999, s + 60_100, 25000), 'ok');          // 09:15:59.999 → bar 09:15
  assert.equal(b.add(s + 59_999, s + 60_100, 25000), 'duplicate');
  assert.equal(b.add(s + 59_000, s + 60_200, 25001), 'out_of_order');
  assert.equal(b.add(s + 60_000, s + 60_150, 25010), 'ok');          // 09:16:00 → bar 09:16
  assert.equal(b.confirmUntil(s + 61_499, 1500).length, 0, 'not before 09:16:01.5');
  const c = b.confirmUntil(s + 61_500, 1500);
  assert.deepEqual([c.length, c[0].label, c[0].close], [1, 555, 25000]);
  assert.equal(b.add(s + 30_000, s + 62_000, 24990), 'late');
  assert.equal(b.get(555)!.close, 25000, 'confirmed bar never changes');
  b.confirmUntil(barStart(date, 558) + 1500, 1500);
  assert.equal(b.get(557)!.status, 'MISSING');
});

test('cost model: buy and sell fees (brokerage, STT on sell, txn, SEBI, stamp, GST)', () => {
  const buy = buyFees(200, 65), sell = sellFees(250, 65);
  assert.ok(buy > 23 && buy < 30, `buy ${buy}`);
  assert.ok(sell > 44 && sell < 49, `sell ${sell}`); // includes ₹16.25 STT (0.1% of ₹16,250)
  assert.ok(sellFees(0, 65) >= 23.6);
});
