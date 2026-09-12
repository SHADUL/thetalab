import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  trendScore, momentumScore, relativeStrengthScore, setupQualityScore, volumeScore, volatilityScore,
} from '../scoring/factors.ts';
import { computeTradePlan, riskRewardScore } from '../scoring/riskReward.ts';
import { computeSectorStrength, sectorScoreFor, type StockSectorInput } from '../scoring/sectorStrength.ts';
import { PRESETS } from '../scoring/presets.ts';
import { combineFactors, scoreSymbol } from '../scoring/swingScore.ts';
import { detectPatterns } from '../patterns/detect.ts';
import type { PatternResult } from '../patterns/types.ts';
import type { Bar } from '../indicators/types.ts';
import type { FactorScores } from '../scoring/types.ts';

/* ---------------- presets ---------------- */

test('every weight preset sums to exactly 1.0', () => {
  for (const [name, weights] of Object.entries(PRESETS)) {
    const sum = Object.values(weights).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `${name} sums to ${sum}, not 1.0`);
  }
});

/* ---------------- trend ---------------- */

test('trendScore rewards a fully bullish stack more than a partial one', () => {
  const full = trendScore({ price: 110, ema20: 108, ema50: 105, sma200: 100, ema20Rising: true });
  const partial = trendScore({ price: 102, ema20: 100, ema50: 105, sma200: 100, ema20Rising: false });
  assert.equal(full, 100);
  assert.ok(partial < full);
});

test('trendScore still gives credit for an emerging trend, not just a mature one', () => {
  // Price just crossed above EMA20, everything else still lagging — spec
  // §9's own "newly emerging trend" case, not a rigid stack requirement.
  const emerging = trendScore({ price: 101, ema20: 100, ema50: 103, sma200: 105, ema20Rising: true });
  assert.ok(emerging > 0 && emerging < 60);
});

/* ---------------- momentum ---------------- */

test('momentumScore peaks in the RSI 60-70 / ADX 25-35 sweet spot, not at the extremes', () => {
  const sweetSpot = momentumScore(65, 30);
  const overheated = momentumScore(85, 45);
  const weak = momentumScore(35, 10);
  assert.ok(sweetSpot > overheated, 'RSI 85 should not outscore RSI 65 — spec §10 warns overheated is not automatically better');
  assert.ok(sweetSpot > weak);
});

/* ---------------- relative strength ---------------- */

test('relativeStrengthScore centers on 50 for zero relative performance', () => {
  assert.equal(relativeStrengthScore({ rs5d: 0, rs20d: 0, rs60d: 0, rs120d: 0 }), 50);
});

test('relativeStrengthScore rewards genuine outperformance, per the spec §14 worked example direction', () => {
  const strong = relativeStrengthScore({ rs5d: 4, rs20d: 6, rs60d: 8, rs120d: 5 }); // stock beating NIFTY across the board
  const weak = relativeStrengthScore({ rs5d: -4, rs20d: -6, rs60d: -8, rs120d: -5 });
  assert.ok(strong > 50 && weak < 50);
  assert.ok(strong > weak);
});

test('relativeStrengthScore is neutral, not zero, when no RS data exists at all', () => {
  assert.equal(relativeStrengthScore({ rs5d: null, rs20d: null, rs60d: null, rs120d: null }), 50);
});

/* ---------------- setup quality ---------------- */

function emptyPattern(overrides: Partial<PatternResult> = {}): PatternResult {
  return {
    breakouts: [], breakoutQuality: null, volumeConfirmed: false, closingStrength: 0.5,
    consolidation: { inConsolidation: false, contractionRatio: null, rangePct: null },
    pullback: { toEma20: false, toEma50: false, breakoutRetest: false },
    gap: { type: 'NONE', gapPct: null }, extensionRisk: 'LOW', entryStatus: 'AVOID', setupTypes: [],
    ...overrides,
  };
}

test('setupQualityScore prefers an active breakout over a pullback over a bare consolidation over nothing', () => {
  const breakout = setupQualityScore(emptyPattern({ breakoutQuality: 80 }));
  const pullback = setupQualityScore(emptyPattern({ pullback: { toEma20: true, toEma50: false, breakoutRetest: false } }));
  const consolidating = setupQualityScore(emptyPattern({ consolidation: { inConsolidation: true, contractionRatio: 0.5, rangePct: 3 } }));
  const nothing = setupQualityScore(emptyPattern());
  assert.ok(breakout > pullback && pullback > consolidating && consolidating > nothing);
});

/* ---------------- volume & volatility ---------------- */

test('volumeScore follows spec §12 bands monotonically', () => {
  assert.ok(volumeScore(0.5) < volumeScore(0.9) && volumeScore(0.9) < volumeScore(1.2)
    && volumeScore(1.2) < volumeScore(1.8) && volumeScore(1.8) < volumeScore(2.5));
});

test('volatilityScore peaks in the 1.5-2.5% ATR band, not at either extreme', () => {
  const tooSlow = volatilityScore(0.5);
  const sweetSpot = volatilityScore(2.0);
  const tooWild = volatilityScore(5.0);
  assert.ok(sweetSpot > tooSlow && sweetSpot > tooWild);
});

/* ---------------- risk/reward ---------------- */

function bar(t: string, c: number, opts: Partial<Bar> = {}): Bar {
  return { t, o: opts.o ?? c, h: opts.h ?? c, l: opts.l ?? c, c, v: opts.v ?? 1_000_000 };
}

test('computeTradePlan anchors the stop below a fresh breakout level when one just fired', () => {
  const pattern = emptyPattern({
    entryStatus: 'BREAKOUT_CONFIRMED',
    breakouts: [{ lookback: 20, level: 100, brokeOut: true }],
  });
  const plan = computeTradePlan({ price: 106, atr: 2, ema20: 103, ema50: 99, pattern });
  assert.ok(plan.stop! < 100 && plan.stop! > 95, `stop (${plan.stop}) should sit just under the 100 breakout level`);
  assert.equal(plan.target, 106 * 1.10);
  assert.ok(plan.riskReward! > 0);
});

test('computeTradePlan anchors the stop near the EMA a pullback is holding', () => {
  const pattern = emptyPattern({ pullback: { toEma20: true, toEma50: false, breakoutRetest: false } });
  const plan = computeTradePlan({ price: 101, atr: 2, ema20: 100, ema50: 95, pattern });
  assert.ok(plan.stop! < 100, 'the EMA-based stop should sit at or below the EMA itself');
});

test('computeTradePlan falls back to an ATR-based stop when no structural level applies', () => {
  const pattern = emptyPattern();
  const plan = computeTradePlan({ price: 100, atr: 3, ema20: null, ema50: null, pattern });
  assert.equal(plan.stop, 100 - 3 * 2);
});

test('computeTradePlan returns a null stop (and null R:R) rather than a guessed one when nothing is available', () => {
  const plan = computeTradePlan({ price: 100, atr: null, ema20: null, ema50: null, pattern: emptyPattern() });
  assert.equal(plan.stop, null);
  assert.equal(plan.riskReward, null);
});

test('riskRewardScore rewards better reward-to-risk and heavily penalizes poor R:R (spec §20)', () => {
  assert.ok(riskRewardScore(0.5) < riskRewardScore(1.2));
  assert.ok(riskRewardScore(1.2) < riskRewardScore(2.0));
  assert.ok(riskRewardScore(2.0) < riskRewardScore(3.0));
  assert.equal(riskRewardScore(null), 30);
});

/* ---------------- sector strength ---------------- */

test('computeSectorStrength ranks a genuinely outperforming sector above a lagging one', () => {
  const stocks: StockSectorInput[] = [
    { symbol: 'A1', sector: 'Leaders', return20d: 10, return60d: 15, aboveEma20: true, aboveEma50: true },
    { symbol: 'A2', sector: 'Leaders', return20d: 8, return60d: 12, aboveEma20: true, aboveEma50: true },
    { symbol: 'A3', sector: 'Leaders', return20d: 9, return60d: 14, aboveEma20: true, aboveEma50: false },
    { symbol: 'B1', sector: 'Laggards', return20d: -5, return60d: -8, aboveEma20: false, aboveEma50: false },
    { symbol: 'B2', sector: 'Laggards', return20d: -4, return60d: -6, aboveEma20: false, aboveEma50: false },
    { symbol: 'B3', sector: 'Laggards', return20d: -6, return60d: -7, aboveEma20: false, aboveEma50: false },
  ];
  const strengths = computeSectorStrength(stocks);
  assert.ok(strengths.get('Leaders')!.score > strengths.get('Laggards')!.score);
  assert.equal(strengths.get('Leaders')!.score, 100, 'the best sector present should hit the top of the 0-100 scale');
  assert.equal(strengths.get('Laggards')!.score, 0, 'the worst sector present should hit the bottom');
});

test('computeSectorStrength gives a neutral score to a sector with too few members to rank', () => {
  const stocks: StockSectorInput[] = [
    { symbol: 'X1', sector: 'TinySector', return20d: 50, return60d: 50, aboveEma20: true, aboveEma50: true },
    { symbol: 'Y1', sector: 'BigSector', return20d: 5, return60d: 5, aboveEma20: true, aboveEma50: true },
    { symbol: 'Y2', sector: 'BigSector', return20d: 6, return60d: 6, aboveEma20: true, aboveEma50: true },
    { symbol: 'Y3', sector: 'BigSector', return20d: 4, return60d: 4, aboveEma20: false, aboveEma50: true },
  ];
  const strengths = computeSectorStrength(stocks);
  assert.equal(strengths.get('TinySector')!.score, 50, 'one stock is not a sector breadth statistic');
});

test('sectorScoreFor is neutral for a stock with no sector on file', () => {
  const strengths = computeSectorStrength([{ symbol: 'A', sector: 'S', return20d: 10, return60d: 10, aboveEma20: true, aboveEma50: true }]);
  assert.equal(sectorScoreFor(null, strengths), 50);
  assert.equal(sectorScoreFor('NoSuchSector', strengths), 50);
});

/* ---------------- composite ---------------- */

function allFactors(v: number): FactorScores {
  return { trend: v, momentum: v, relativeStrength: v, setup: v, volume: v, sector: v, volatility: v, riskReward: v };
}

test('combineFactors returns the flat value itself when every factor agrees, regardless of preset', () => {
  for (const weights of Object.values(PRESETS)) {
    assert.equal(combineFactors(allFactors(70), weights), 70);
  }
});

test('combineFactors clamps to [0, 100]', () => {
  assert.equal(combineFactors(allFactors(0), PRESETS.BALANCED), 0);
  assert.equal(combineFactors(allFactors(100), PRESETS.BALANCED), 100);
});

test('scoreSymbol produces a high score for a genuinely strong, real-shaped setup', () => {
  // Build a real breakout scenario through the actual Pattern Engine,
  // exactly like production would, rather than hand-assembling a
  // PatternResult — this exercises the full factors -> composite path.
  const bars: Bar[] = [];
  for (let i = 0; i < 260; i++) {
    const c = 100 + (i % 10) * 0.3 + Math.sin(i / 7) * 1.5;
    bars.push(bar(`d${i}`, c, { h: c * 1.008, l: c * 0.992 }));
  }
  const prevClose = bars[bars.length - 1].c;
  bars.push(bar('breakout', prevClose * 1.025,
    { o: prevClose * 1.002, h: prevClose * 1.03, l: prevClose * 0.998, v: 4_000_000 }));
  const pattern = detectPatterns(bars);

  const result = scoreSymbol({
    price: bars[bars.length - 1].c, ema20: 101, ema50: 100.5, sma200: 100, ema20Rising: true,
    rsi14: 65, adx14: 28, rs5d: 3, rs20d: 5, rs60d: 6, rs120d: 4,
    volRatio: 2.2, atr: 1.5, atrPct: 1.5, sectorScore: 80, pattern,
  });

  assert.ok(result.score >= 65, `expected a strong composite score, got ${result.score}`);
  assert.equal(result.tradePlan.target, result.tradePlan.entry * 1.10);
});

test('scoreSymbol produces a low score for a genuinely weak setup', () => {
  const pattern = emptyPattern({ entryStatus: 'AVOID' });
  const result = scoreSymbol({
    price: 90, ema20: 95, ema50: 100, sma200: 105, ema20Rising: false,
    rsi14: 32, adx14: 12, rs5d: -6, rs20d: -8, rs60d: -10, rs120d: -7,
    volRatio: 0.5, atr: 1, atrPct: 1.1, sectorScore: 15, pattern,
  });
  assert.ok(result.score <= 35, `expected a weak composite score, got ${result.score}`);
});
