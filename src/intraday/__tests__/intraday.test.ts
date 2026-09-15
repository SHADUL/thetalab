import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSessionVWAP, classifyVwapRelationship } from '../vwap.ts';
import { classifyMarketRegime, regimeAlignmentScore } from '../regime.ts';
import { intradayRelativeStrengthScore } from '../relativeStrength.ts';
import { momentumAccelerationScore } from '../momentum.ts';
import { estimateRVOL, classifyRVOL, sessionFractionElapsed } from '../rvol.ts';
import { ema, atr, istMinutesOfDay } from '../indicators.ts';
import { computeOpeningRange, detectORB, detectVwapPullback, detectEmaTrendContinuation } from '../setups.ts';
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
