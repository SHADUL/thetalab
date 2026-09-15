import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSessionVWAP, classifyVwapRelationship } from '../vwap.ts';
import { classifyMarketRegime, regimeAlignmentScore } from '../regime.ts';
import { intradayRelativeStrengthScore } from '../relativeStrength.ts';
import { momentumAccelerationScore } from '../momentum.ts';
import { estimateRVOL, classifyRVOL, sessionFractionElapsed } from '../rvol.ts';
import { ema, atr, istMinutesOfDay } from '../indicators.ts';
import { computeOpeningRange, detectORB, detectVwapPullback, detectEmaTrendContinuation, detectBreakout, detectBreakoutRetest } from '../setups.ts';
import { detectLiquidityGrab, liquidityGrabStop } from '../liquidityGrab.ts';
import { detectEma200Pullback, ema200PullbackStop } from '../ema200Pullback.ts';
import { computeExtension } from '../extension.ts';
import { computeIntradaySectorStrength, sectorScoreFor } from '../sector.ts';
import { classifyGap, detectPrevDayLevelEvents } from '../levels.ts';
import { combineIntradayFactors, signalConfidenceLabel, evaluateEntryChecklist, buildTradePlan, explainChecklist } from '../score.ts';
import { computePositionSize, checkDailyRiskLimits } from '../risk.ts';
import type { IntradayBar, EntryChecklist } from '../types.ts';

function istTime(dateStr: string, hh: number, mm: number): number {
  return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).getTime();
}
function bar(hh: number, mm: number, c: number, opts: Partial<IntradayBar> = {}): IntradayBar {
  return { t: istTime('2026-09-15', hh, mm), o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 100_000 };
}

/* ---------------- indicators.ts ---------------- */

test('istMinutesOfDay: converts an epoch timestamp to IST minutes-since-midnight', () => {
  assert.equal(istMinutesOfDay(istTime('2026-09-15', 9, 15)), 9 * 60 + 15);
  assert.equal(istMinutesOfDay(istTime('2026-09-15', 15, 30)), 15 * 60 + 30);
});

test('ema: matches a hand-computed 3-period EMA', () => {
  const values = [10, 11, 12, 13, 14];
  const result = ema(values, 3);
  assert.equal(result[1], null);
  assert.ok(Math.abs(result[2]! - 11) < 1e-9); // seed = SMA(10,11,12)
  const k = 2 / 4;
  assert.ok(Math.abs(result[3]! - (13 * k + 11 * (1 - k))) < 1e-9);
});

test('atr: needs `period` bars before producing a value', () => {
  const bars = [bar(9, 15, 100, { h: 101, l: 99 }), bar(9, 20, 101, { h: 102, l: 100 })];
  const result = atr(bars, 3);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
});

/* ---------------- vwap.ts ---------------- */

test('computeSessionVWAP: flat price/volume equals that price', () => {
  const bars = [bar(9, 15, 100), bar(9, 20, 100), bar(9, 25, 100)];
  const vwap = computeSessionVWAP(bars);
  for (const v of vwap) assert.ok(Math.abs(v - 100) < 1e-9);
});

test('classifyVwapRelationship: above and rising', () => {
  const vwapSeries = [100, 100.5, 101, 101.5, 102, 102.5, 103];
  assert.equal(classifyVwapRelationship(105, vwapSeries), 'ABOVE_RISING');
});

test('classifyVwapRelationship: below and falling', () => {
  const vwapSeries = [103, 102.5, 102, 101.5, 101, 100.5, 100];
  assert.equal(classifyVwapRelationship(95, vwapSeries), 'BELOW_FALLING');
});

test('classifyVwapRelationship: within tolerance reads as AT_VWAP', () => {
  const vwapSeries = [100, 100, 100, 100, 100, 100, 100];
  assert.equal(classifyVwapRelationship(100.001, vwapSeries), 'AT_VWAP');
});

/* ---------------- regime.ts ---------------- */

test('classifyMarketRegime: broad positive participation reads STRONG_BULLISH', () => {
  const { regime } = classifyMarketRegime({
    niftyReturnPct: 1.0, niftyAboveVwap: true, niftyAbove20Ema: true,
    bankNiftyReturnPct: 1.0, bankNiftyAboveVwap: true, pctStocksAboveVwap: 80,
  });
  assert.equal(regime, 'STRONG_BULLISH');
});

test('classifyMarketRegime: broad weakness reads STRONG_BEARISH', () => {
  const { regime } = classifyMarketRegime({
    niftyReturnPct: -1.0, niftyAboveVwap: false, niftyAbove20Ema: false,
    bankNiftyReturnPct: -1.0, bankNiftyAboveVwap: false, pctStocksAboveVwap: 20,
  });
  assert.equal(regime, 'STRONG_BEARISH');
});

test('classifyMarketRegime: mixed signals read NEUTRAL', () => {
  const { regime } = classifyMarketRegime({
    niftyReturnPct: 0.02, niftyAboveVwap: true, niftyAbove20Ema: false,
    bankNiftyReturnPct: -0.02, bankNiftyAboveVwap: false, pctStocksAboveVwap: 50,
  });
  assert.equal(regime, 'NEUTRAL');
});

test('regimeAlignmentScore: a bullish regime favors LONG over SHORT', () => {
  assert.ok(regimeAlignmentScore('STRONG_BULLISH', 'LONG') > regimeAlignmentScore('STRONG_BULLISH', 'SHORT'));
});

/* ---------------- relativeStrength.ts ---------------- */

test('intradayRelativeStrengthScore: strong, consistent outperformance scores well above neutral', () => {
  // A steady 5pp outperformance across every window (clamped range is
  // +-10pp, so this is "strong but not maxed out") — scaled to land
  // clearly above 70, not just barely above the neutral 50.
  const score = intradayRelativeStrengthScore([
    { stockReturnPct: 5.3, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 5.3, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 5.3, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 5.3, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 5.3, niftyReturnPct: 0.3, weight: 0.2 },
  ]);
  assert.ok(score > 70, `expected > 70, got ${score}`);
});

test('intradayRelativeStrengthScore: modest outperformance scores above neutral but not extreme', () => {
  const score = intradayRelativeStrengthScore([
    { stockReturnPct: 1.8, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 1.5, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 1.2, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 1.0, niftyReturnPct: 0.3, weight: 0.2 },
    { stockReturnPct: 0.8, niftyReturnPct: 0.3, weight: 0.2 },
  ]);
  assert.ok(score > 50 && score < 70, `expected between 50 and 70, got ${score}`);
});

test('intradayRelativeStrengthScore: no windows returns neutral 50, not a guess', () => {
  assert.equal(intradayRelativeStrengthScore([]), 50);
});

/* ---------------- momentum.ts ---------------- */

test('momentumAccelerationScore: an accelerating uptrend outscores a decelerating one at the same level', () => {
  const flatThenAccel = [bar(10, 0, 100), bar(10, 5, 100.2), bar(10, 10, 100.4), bar(10, 15, 100.7), bar(10, 20, 101.2), bar(10, 25, 102), bar(10, 30, 103.2)];
  const strongThenFade = [bar(10, 0, 100), bar(10, 5, 101), bar(10, 10, 102), bar(10, 15, 102.7), bar(10, 20, 103.2), bar(10, 25, 103.4), bar(10, 30, 103.5)];
  const accelScore = momentumAccelerationScore(flatThenAccel, 'LONG');
  const fadeScore = momentumAccelerationScore(strongThenFade, 'LONG');
  assert.ok(accelScore > fadeScore, `expected accelerating (${accelScore}) > fading (${fadeScore})`);
});

test('momentumAccelerationScore: not enough bars returns neutral 50', () => {
  assert.equal(momentumAccelerationScore([bar(10, 0, 100), bar(10, 5, 101)], 'LONG'), 50);
});

/* ---------------- rvol.ts ---------------- */

test('sessionFractionElapsed: 0 at open, 1 at close', () => {
  assert.equal(sessionFractionElapsed(9 * 60 + 15), 0);
  assert.equal(sessionFractionElapsed(15 * 60 + 30), 1);
});

test('estimateRVOL: exactly at expectation reads 1.0x', () => {
  const nowMin = 9 * 60 + 15 + (15 * 60 + 30 - (9 * 60 + 15)) / 2; // halfway through the session
  const rvol = estimateRVOL(500_000, 1_000_000, nowMin);
  assert.ok(Math.abs(rvol! - 1.0) < 1e-6);
});

test('classifyRVOL: bands', () => {
  assert.equal(classifyRVOL(0.5), 'WEAK');
  assert.equal(classifyRVOL(0.9), 'NORMAL');
  assert.equal(classifyRVOL(1.2), 'POSITIVE');
  assert.equal(classifyRVOL(1.8), 'STRONG');
  assert.equal(classifyRVOL(2.5), 'EXCEPTIONAL');
  assert.equal(classifyRVOL(null), 'UNKNOWN');
});

/* ---------------- setups.ts: ORB ---------------- */

test('computeOpeningRange: high/low over the 09:15-09:30 window only', () => {
  const bars = [
    bar(9, 15, 100, { h: 101, l: 99 }),
    bar(9, 20, 102, { h: 103, l: 100 }),
    bar(9, 25, 101, { h: 102, l: 100 }),
    bar(9, 35, 150, { h: 160, l: 140 }), // outside the OR window — must not affect it
  ];
  const or = computeOpeningRange(bars)!;
  assert.equal(or.high, 103);
  assert.equal(or.low, 99);
});

test('detectORB: a tiny wick above OR high does not fire (needs a close beyond it)', () => {
  const or = { high: 100, low: 95, width: 5 };
  const bars = [bar(9, 35, 99.5, { h: 100.5, l: 99 })]; // wick pokes above, closes back under
  const signal = detectORB(bars, or, 'LONG');
  assert.equal(signal.fired, false);
});

test('detectORB: a confirmed close beyond OR high fires with quality > 0', () => {
  const or = { high: 100, low: 95, width: 5 };
  const bars = [bar(9, 35, 102, { o: 100.2, h: 102.5, l: 100 })];
  const signal = detectORB(bars, or, 'LONG');
  assert.equal(signal.fired, true);
  assert.ok(signal.quality > 0);
});

test('detectORB: SHORT direction breaks the OR low symmetrically', () => {
  const or = { high: 100, low: 95, width: 5 };
  const bars = [bar(9, 35, 93, { o: 94.8, h: 95, l: 92.5 })];
  const signal = detectORB(bars, or, 'SHORT');
  assert.equal(signal.fired, true);
});

/* ---------------- setups.ts: VWAP pullback ---------------- */

test('detectVwapPullback: extend-pullback-resume structure fires for LONG', () => {
  const bars = [
    bar(9, 30, 100, { o: 99, v: 200_000 }),
    bar(9, 35, 101.5, { o: 100, v: 180_000 }),
    bar(9, 40, 103, { o: 101.5, v: 220_000 }), // extended
    bar(9, 45, 102.5, { o: 103, v: 150_000 }),
    bar(9, 50, 102, { o: 102.5, v: 90_000 }), // pulling back, lighter volume
    bar(9, 55, 101.7, { o: 102, v: 70_000 }),
    bar(10, 0, 101.5, { o: 101.7, v: 60_000 }),
    bar(10, 5, 102.4, { o: 101.6, v: 150_000 }), // resumes higher
  ];
  const closes = bars.map((b) => b.c);
  const vwapSeries = closes.map(() => 100.5); // a steady VWAP the price extended away from and pulled back toward
  const signal = detectVwapPullback(bars, vwapSeries, 'LONG');
  assert.equal(signal.fired, true);
});

test('detectVwapPullback: no prior extension means no pullback setup', () => {
  const bars = Array.from({ length: 8 }, (_, i) => bar(9, 30 + i, 100 + i * 0.05, { o: 100 + i * 0.05 - 0.02 }));
  const vwapSeries = bars.map(() => 100);
  const signal = detectVwapPullback(bars, vwapSeries, 'LONG');
  assert.equal(signal.fired, false);
});

/* ---------------- setups.ts: EMA trend continuation ---------------- */

test('detectEmaTrendContinuation: stacked EMAs + intact structure + near EMA9 fires', () => {
  const bars = [
    bar(10, 0, 100, { h: 100.5, l: 99.5 }),
    bar(10, 5, 100.8, { h: 101.2, l: 100 }),
    bar(10, 10, 101.5, { h: 102, l: 100.9 }),
    bar(10, 15, 101.3, { h: 101.8, l: 101 }),
    bar(10, 20, 101.6, { h: 102.1, l: 101.2 }),
  ];
  const ema9 = bars.map((b) => b.c - 0.1); // price sitting just above EMA9
  const ema20 = bars.map(() => 99); // EMA9 well above EMA20 — clear bullish stack
  const signal = detectEmaTrendContinuation(bars, ema9, ema20, 'LONG');
  assert.equal(signal.fired, true);
});

test('detectEmaTrendContinuation: EMA9 below EMA20 does not fire for LONG', () => {
  const bars = [bar(10, 0, 100), bar(10, 5, 101), bar(10, 10, 102), bar(10, 15, 103), bar(10, 20, 104)];
  const ema9 = bars.map((b) => b.c - 0.1);
  const ema20 = bars.map(() => 110); // EMA20 above EMA9 — bearish stack, not bullish
  const signal = detectEmaTrendContinuation(bars, ema9, ema20, 'LONG');
  assert.equal(signal.fired, false);
});

test('detectEmaTrendContinuation: a broken structure (lower high than prior low) does not fire', () => {
  const bars = [
    bar(10, 0, 100, { h: 100.5, l: 99.5 }),
    bar(10, 5, 101, { h: 101.5, l: 100 }),
    bar(10, 10, 90, { h: 91, l: 89 }), // sharp break lower — structure broken
    bar(10, 15, 90.5, { h: 91.2, l: 90 }),
    bar(10, 20, 90.8, { h: 91.4, l: 90.3 }),
  ];
  const ema9 = bars.map((b) => b.c + 0.2);
  const ema20 = [95, 95, 95, 95, 95];
  const signal = detectEmaTrendContinuation(bars, ema9, ema20, 'LONG');
  assert.equal(signal.fired, false);
});

/* ---------------- setups.ts: Breakout ---------------- */

function tightBase(n: number, mid = 100, halfWidth = 0.2, vol = 50_000): IntradayBar[] {
  return Array.from({ length: n }, (_, i) => bar(9, 30 + i * 5, mid, { h: mid + halfWidth, l: mid - halfWidth, o: mid, v: vol }));
}

test('detectBreakout: a confirmed close beyond a tight base fires with volume expansion', () => {
  const base = tightBase(12);
  const breakoutBar = bar(10, 30, 101, { o: 100.5, h: 101.2, l: 100.4, v: 200_000 });
  const signal = detectBreakout([...base, breakoutBar], 'LONG');
  assert.equal(signal.fired, true);
  assert.ok(signal.quality > 0);
});

test('detectBreakout: a wide/trending range does not count as a base', () => {
  const trending = Array.from({ length: 12 }, (_, i) => bar(9, 30 + i * 5, 95 + i, { h: 95 + i + 0.3, l: 95 + i - 0.3, v: 50_000 }));
  const breakoutBar = bar(10, 30, 108, { o: 107, h: 108.2, l: 106.8, v: 200_000 });
  const signal = detectBreakout([...trending, breakoutBar], 'LONG');
  assert.equal(signal.fired, false);
});

test('detectBreakout: a close still inside the base does not fire', () => {
  const base = tightBase(12);
  const insideBar = bar(10, 30, 100.1, { o: 100, h: 100.2, l: 99.9, v: 60_000 });
  const signal = detectBreakout([...base, insideBar], 'LONG');
  assert.equal(signal.fired, false);
});

/* ---------------- setups.ts: Breakout Retest ---------------- */

test('detectBreakoutRetest: breakout, pullback to the level, hold, and resume fires', () => {
  const filler = bar(9, 15, 100, { h: 100.1, l: 99.9, v: 50_000 });
  const base = tightBase(12); // base.high = 100.2, base.low = 99.8
  const retestWindow = [
    bar(10, 30, 101, { o: 100.3, h: 101.2, l: 100.25, v: 200_000 }),     // breakout bar
    bar(10, 35, 100.6, { o: 101, h: 101, l: 100.5, v: 80_000 }),          // pulling back
    bar(10, 40, 100.45, { o: 100.6, h: 100.65, l: 100.35, v: 60_000 }),   // touches the retest zone
    bar(10, 45, 100.5, { o: 100.45, h: 100.6, l: 100.3, v: 55_000 }),     // holding
    bar(10, 50, 100.55, { o: 100.5, h: 100.6, l: 100.32, v: 50_000 }),    // still holding
    bar(10, 55, 101.2, { o: 100.55, h: 101.3, l: 100.5, v: 150_000 }),    // resumes higher
  ];
  const signal = detectBreakoutRetest([filler, ...base, ...retestWindow], 'LONG');
  assert.equal(signal.fired, true);
  assert.ok(signal.quality >= 75);
});

test('detectBreakoutRetest: a straight-line breakout with no pullback does not fire', () => {
  const filler = bar(9, 15, 100, { h: 100.1, l: 99.9, v: 50_000 });
  const base = tightBase(12);
  const runAway = [
    bar(10, 30, 101, { o: 100.3, h: 101.2, l: 100.25, v: 200_000 }),
    bar(10, 35, 101.5, { o: 101, h: 101.6, l: 101, v: 180_000 }),
    bar(10, 40, 102, { o: 101.5, h: 102.1, l: 101.4, v: 170_000 }),
    bar(10, 45, 102.5, { o: 102, h: 102.6, l: 101.9, v: 160_000 }),
    bar(10, 50, 103, { o: 102.5, h: 103.1, l: 102.4, v: 150_000 }),
    bar(10, 55, 103.5, { o: 103, h: 103.6, l: 102.9, v: 140_000 }),
  ];
  const signal = detectBreakoutRetest([filler, ...base, ...runAway], 'LONG');
  assert.equal(signal.fired, false);
});

/* ---------------- liquidityGrab.ts ---------------- */

function levelBars(n: number, mid = 100, high = 101.5, low = 98.5, vol = 50_000): IntradayBar[] {
  return Array.from({ length: n }, (_, i) => bar(9, 30 + i, mid, { h: high, l: low, o: mid, v: vol }));
}

test('detectLiquidityGrab: sweep above a recent swing high then reject fires SHORT', () => {
  const level = levelBars(20); // swingHigh=101.5, swingLow=98.5
  const sweepBar = bar(10, 30, 100.5, { o: 100, h: 103, l: 100, v: 200_000 }); // breaks 101.5 by ~1.5%
  const confirmBar = bar(10, 31, 99, { o: 100.5, h: 100.6, l: 98.8, v: 90_000 }); // closes red, back below 101.5
  const result = detectLiquidityGrab([...level, sweepBar, confirmBar]);
  assert.equal(result.fired, true);
  assert.equal(result.direction, 'SHORT');
  assert.equal(result.sweptLevel, 101.5);
  assert.equal(result.wickExtreme, 103);
  assert.ok(result.quality > 0);
});

test('detectLiquidityGrab: sweep below a recent swing low then reject fires LONG', () => {
  const level = levelBars(20);
  const sweepBar = bar(10, 30, 99.5, { o: 100, h: 100, l: 97, v: 200_000 }); // breaks 98.5 by ~1.5%
  const confirmBar = bar(10, 31, 100, { o: 99.5, h: 100.2, l: 99.3, v: 90_000 }); // closes green, back above 98.5
  const result = detectLiquidityGrab([...level, sweepBar, confirmBar]);
  assert.equal(result.fired, true);
  assert.equal(result.direction, 'LONG');
  assert.equal(result.sweptLevel, 98.5);
  assert.equal(result.wickExtreme, 97);
});

test('detectLiquidityGrab: a sweep that continues (no rejection) does not fire', () => {
  const level = levelBars(20);
  const sweepBar = bar(10, 30, 102, { o: 101, h: 103, l: 101, v: 150_000 });
  const confirmBar = bar(10, 31, 103.5, { o: 102, h: 104, l: 102, v: 120_000 }); // closes green, ABOVE swingHigh — continuation, not rejection
  const result = detectLiquidityGrab([...level, sweepBar, confirmBar]);
  assert.equal(result.fired, false);
});

test('detectLiquidityGrab: price staying inside the range does not fire', () => {
  const level = levelBars(20);
  const bars = [...level, bar(10, 30, 100, { o: 99.8, h: 101, l: 99, v: 60_000 }), bar(10, 31, 100.2, { o: 100, h: 101.2, l: 99.5, v: 55_000 })];
  const result = detectLiquidityGrab(bars);
  assert.equal(result.fired, false);
});

test('detectLiquidityGrab: not enough bars returns fired:false with a clear reason', () => {
  const result = detectLiquidityGrab(levelBars(5));
  assert.equal(result.fired, false);
  assert.match(result.detail, /Not enough bars/);
});

test('detectLiquidityGrab: higher sweep-bar volume scores a higher quality', () => {
  const level = levelBars(20);
  const confirmBar = bar(10, 31, 99, { o: 100.5, h: 100.6, l: 98.8, v: 90_000 });
  const lowVol = detectLiquidityGrab([...level, bar(10, 30, 100.5, { o: 100, h: 103, l: 100, v: 50_000 }), confirmBar]);
  const highVol = detectLiquidityGrab([...level, bar(10, 30, 100.5, { o: 100, h: 103, l: 100, v: 300_000 }), confirmBar]);
  assert.ok(highVol.quality > lowVol.quality);
});

test('liquidityGrabStop: SHORT stop sits just above the wick, LONG stop just below', () => {
  assert.ok(liquidityGrabStop('SHORT', 103) > 103);
  assert.ok(liquidityGrabStop('LONG', 98) < 98);
});

/* ---------------- ema200Pullback.ts ---------------- */

function seqBar(i: number, c: number, opts: Partial<IntradayBar> = {}): IntradayBar {
  return { t: istTime('2026-09-15', 9, 30) + i * 5 * 60_000, o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 50_000 };
}

/**
 * Builds a long, steady trend (so the 200-EMA has genuinely converged),
 * then derives — from the ACTUAL ema20/ema200 values at that point,
 * using the same ema() this suite already imports from indicators.ts —
 * a pullback that lands right at the 200-EMA, and a resumption bar that
 * closes back on the trend side of the 20-EMA. This keeps the fixture
 * mathematically consistent regardless of the exact drift chosen,
 * rather than guessing a hardcoded pullback depth by hand.
 */
function buildTrendThenPullback(direction: 'LONG' | 'SHORT', includeResumption = true): IntradayBar[] {
  const drift = direction === 'LONG' ? 0.05 : -0.05;
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < 260; i++) { price += drift; closes.push(price); }

  const ema200Series = ema(closes, 200);
  const ema20Series = ema(closes, 20);
  const e200 = ema200Series[closes.length - 1]!;
  const e20 = ema20Series[closes.length - 1]!;
  const lastPrice = closes[closes.length - 1];

  const pullbackBars = 8;
  const target = e200 + (direction === 'LONG' ? 1 : -1) * 0.05; // just past the 200-EMA, into "touched" territory
  for (let k = 1; k <= pullbackBars; k++) {
    closes.push(lastPrice + (target - lastPrice) * (k / pullbackBars));
  }
  if (includeResumption) {
    closes.push(direction === 'LONG' ? e20 + 0.3 : e20 - 0.3);
  }
  return closes.map((c, i) => seqBar(i, c, { h: c + 0.15, l: c - 0.15, o: c }));
}

test('detectEma200Pullback: LONG fires after a genuine trend + pullback + resumption', () => {
  const result = detectEma200Pullback(buildTrendThenPullback('LONG'));
  assert.equal(result.fired, true);
  assert.equal(result.direction, 'LONG');
});

test('detectEma200Pullback: SHORT fires symmetrically', () => {
  const result = detectEma200Pullback(buildTrendThenPullback('SHORT'));
  assert.equal(result.fired, true);
  assert.equal(result.direction, 'SHORT');
});

test('detectEma200Pullback: pulled back but has not resumed past the 20-EMA yet does not fire', () => {
  const result = detectEma200Pullback(buildTrendThenPullback('LONG', false));
  assert.equal(result.fired, false);
});

test('detectEma200Pullback: a straight trend with no pullback does not fire', () => {
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < 280; i++) { price += 0.05; closes.push(price); }
  const bars = closes.map((c, i) => seqBar(i, c, { h: c + 0.15, l: c - 0.15, o: c }));
  const result = detectEma200Pullback(bars);
  assert.equal(result.fired, false);
});

test('detectEma200Pullback: price crosses above the 200-EMA but the 20-EMA has not caught up does not fire (trend not confirmed)', () => {
  const closes: number[] = [];
  let price = 150;
  for (let i = 0; i < 270; i++) { price -= 0.05; closes.push(price); } // sustained downtrend
  closes.push(closes[closes.length - 1] + 8); // one sharp spike bar, not a real trend change
  const bars = closes.map((c, i) => seqBar(i, c, { h: c + 0.15, l: c - 0.15, o: c }));
  const result = detectEma200Pullback(bars);
  assert.equal(result.fired, false);
  assert.equal(result.direction, 'LONG'); // price is now above the 200-EMA, but the 20-EMA isn't yet — direction is still reported, just not confirmed
});

test('detectEma200Pullback: not enough bars returns fired:false with a clear reason', () => {
  const bars = Array.from({ length: 50 }, (_, i) => seqBar(i, 100 + i * 0.01));
  const result = detectEma200Pullback(bars);
  assert.equal(result.fired, false);
  assert.match(result.detail, /Not enough bars/);
});

test('ema200PullbackStop: LONG stop sits at/below the pullback low, SHORT stop sits at/above the pullback high', () => {
  const longBars = buildTrendThenPullback('LONG');
  const stopLong = ema200PullbackStop(longBars, 'LONG', 1);
  const recentLows = longBars.slice(-16, -1).map((b) => b.l);
  assert.ok(stopLong <= Math.min(...recentLows));

  const shortBars = buildTrendThenPullback('SHORT');
  const stopShort = ema200PullbackStop(shortBars, 'SHORT', 1);
  const recentHighs = shortBars.slice(-16, -1).map((b) => b.h);
  assert.ok(stopShort >= Math.max(...recentHighs));
});

/* ---------------- extension.ts ---------------- */

test('computeExtension: far from VWAP/EMA in ATR terms is flagged extended', () => {
  const result = computeExtension(110, 100, 100, 2); // 5 ATRs from VWAP
  assert.equal(result.extended, true);
});

test('computeExtension: close to VWAP/EMA is not extended', () => {
  const result = computeExtension(101, 100, 100.5, 2);
  assert.equal(result.extended, false);
});

test('computeExtension: no ATR available defaults to not-extended rather than a guess', () => {
  const result = computeExtension(110, 100, 100, null);
  assert.equal(result.extended, false);
});

/* ---------------- sector.ts ---------------- */

test('computeIntradaySectorStrength: ranks the outperforming sector highest', () => {
  const stocks = [
    { symbol: 'A', sector: 'IT', intradayReturnPct: 2, aboveVwap: true },
    { symbol: 'B', sector: 'IT', intradayReturnPct: 1.8, aboveVwap: true },
    { symbol: 'C', sector: 'IT', intradayReturnPct: 1.5, aboveVwap: true },
    { symbol: 'D', sector: 'Bank', intradayReturnPct: -1, aboveVwap: false },
    { symbol: 'E', sector: 'Bank', intradayReturnPct: -0.8, aboveVwap: false },
    { symbol: 'F', sector: 'Bank', intradayReturnPct: -1.2, aboveVwap: false },
  ];
  const strengths = computeIntradaySectorStrength(stocks);
  assert.equal(strengths.get('IT')!.score, 100);
  assert.equal(strengths.get('Bank')!.score, 0);
});

test('sectorScoreFor: unknown/no sector defaults to neutral 50', () => {
  const strengths = computeIntradaySectorStrength([]);
  assert.equal(sectorScoreFor(null, strengths), 50);
  assert.equal(sectorScoreFor('Nonexistent', strengths), 50);
});

/* ---------------- levels.ts ---------------- */

test('classifyGap: bands', () => {
  assert.equal(classifyGap(105, 100).type, 'GAP_UP');
  assert.equal(classifyGap(95, 100).type, 'GAP_DOWN');
  assert.equal(classifyGap(100.1, 100).type, 'NONE');
});

test('detectPrevDayLevelEvents: flags breakout/breakdown correctly', () => {
  const levels = { high: 110, low: 90, close: 100 };
  assert.deepEqual(detectPrevDayLevelEvents(111, levels), { aboveHigh: true, belowLow: false, aboveClose: true });
  assert.deepEqual(detectPrevDayLevelEvents(89, levels), { aboveHigh: false, belowLow: true, aboveClose: false });
});

/* ---------------- score.ts ---------------- */

test('combineIntradayFactors: all-100 factors score 100', () => {
  const score = combineIntradayFactors({
    relativeStrength: 100, momentum: 100, volume: 100, setup: 100,
    vwapPosition: 100, regimeAlignment: 100, sectorStrength: 100, liquidity: 100,
  });
  assert.equal(score, 100);
});

test('signalConfidenceLabel: boundaries', () => {
  assert.equal(signalConfidenceLabel(95), 'A_PLUS');
  assert.equal(signalConfidenceLabel(85), 'A');
  assert.equal(signalConfidenceLabel(75), 'B');
  assert.equal(signalConfidenceLabel(65), 'WATCH');
  assert.equal(signalConfidenceLabel(50), 'IGNORE');
});

function fullChecklist(overrides: Partial<EntryChecklist> = {}): EntryChecklist {
  return {
    regimeSupportive: true, sectorSupportive: true, relativeStrengthStrong: true, liquid: true,
    vwapAligned: true, trendAligned: true, validSetup: true, rvolConfirms: true,
    triggerOccurred: true, stopLogical: true, rrAcceptable: true, notExtended: true,
    ...overrides,
  };
}

test('evaluateEntryChecklist: all true passes', () => {
  const { allPass } = evaluateEntryChecklist(fullChecklist());
  assert.equal(allPass, true);
});

test('evaluateEntryChecklist: a single false fails the whole signal', () => {
  const { allPass } = evaluateEntryChecklist(fullChecklist({ notExtended: false }));
  assert.equal(allPass, false);
});

test('buildTradePlan: 1R/2R ladder and structural R:R are computed separately', () => {
  const plan = buildTradePlan('LONG', 500, 485, 522.5); // structural target gives 1.5R
  assert.equal(plan.riskPerShare, 15);
  assert.equal(plan.target1, 515); // +1R
  assert.equal(plan.target2, 530); // +2R
  assert.ok(Math.abs(plan.riskReward! - 1.5) < 1e-9);
});

test('explainChecklist: splits confirmations and failures without inventing text', () => {
  const { confirmations, failures } = explainChecklist(fullChecklist({ rvolConfirms: false }));
  assert.ok(confirmations.includes('Strong relative strength'));
  assert.ok(failures.includes('Relative volume confirms'));
});

/* ---------------- risk.ts ---------------- */

test('computePositionSize: matches the spec worked example exactly', () => {
  const result = computePositionSize({ capital: 1_000_000, riskPct: 0.5, entry: 500, stop: 485, maxCapitalAllocationPct: 20 });
  assert.equal(result.riskAmount, 5000);
  assert.equal(result.shares, 333); // floor(5000/15)
});

test('computePositionSize: capital limit can bind tighter than the risk limit', () => {
  // Risk allows a huge share count, but the 20% capital cap should bind instead.
  const result = computePositionSize({ capital: 100_000, riskPct: 5, entry: 1000, stop: 999, maxCapitalAllocationPct: 20 });
  assert.equal(result.limitedBy, 'CAPITAL');
  assert.equal(result.shares, 20); // floor(20,000 / 1000)
});

test('computePositionSize: zero risk-per-share (bad stop) returns zero shares, not Infinity', () => {
  const result = computePositionSize({ capital: 100_000, riskPct: 1, entry: 500, stop: 500, maxCapitalAllocationPct: 20 });
  assert.equal(result.shares, 0);
});

test('checkDailyRiskLimits: max daily loss locks trading', () => {
  const result = checkDailyRiskLimits({ dailyPnl: -2100, capital: 100_000, maxDailyLossPct: 2, tradesToday: 2, maxTrades: 5, consecutiveLosses: 1, maxConsecutiveLosses: 3 });
  assert.equal(result.locked, true);
  assert.equal(result.reason, 'MAX_DAILY_LOSS');
});

test('checkDailyRiskLimits: max trades locks even with positive P&L', () => {
  const result = checkDailyRiskLimits({ dailyPnl: 500, capital: 100_000, maxDailyLossPct: 2, tradesToday: 5, maxTrades: 5, consecutiveLosses: 0, maxConsecutiveLosses: 3 });
  assert.equal(result.locked, true);
  assert.equal(result.reason, 'MAX_TRADES');
});

test('checkDailyRiskLimits: max consecutive losses locks to prevent revenge trading', () => {
  const result = checkDailyRiskLimits({ dailyPnl: -100, capital: 100_000, maxDailyLossPct: 2, tradesToday: 3, maxTrades: 5, consecutiveLosses: 3, maxConsecutiveLosses: 3 });
  assert.equal(result.locked, true);
  assert.equal(result.reason, 'MAX_CONSECUTIVE_LOSSES');
});

test('checkDailyRiskLimits: within all limits does not lock', () => {
  const result = checkDailyRiskLimits({ dailyPnl: -300, capital: 100_000, maxDailyLossPct: 2, tradesToday: 2, maxTrades: 5, consecutiveLosses: 1, maxConsecutiveLosses: 3 });
  assert.equal(result.locked, false);
  assert.equal(result.reason, null);
});
