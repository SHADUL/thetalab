/**
 * Ranking Engine (spec §53) — combines the 8 factor scores into the
 * composite Swing Score (spec §22) under whichever preset weighting is
 * active. This file only combines; every factor's own logic lives in
 * factors.ts / riskReward.ts / sectorStrength.ts so the weighting scheme
 * can change without touching how any individual factor is computed.
 */
import type { PatternResult } from '../patterns/types.ts';
import type { FactorScores, WeightPreset, SwingScoreResult, TradePlan } from './types.ts';
import { trendScore, momentumScore, relativeStrengthScore, setupQualityScore, volumeScore, volatilityScore } from './factors.ts';
import { computeTradePlan, riskRewardScore } from './riskReward.ts';
import { PRESETS, DEFAULT_PRESET, type PresetName } from './presets.ts';

export function combineFactors(factors: FactorScores, weights: WeightPreset): number {
  const sum = factors.trend * weights.trend + factors.momentum * weights.momentum
    + factors.relativeStrength * weights.relativeStrength + factors.setup * weights.setup
    + factors.volume * weights.volume + factors.sector * weights.sector
    + factors.volatility * weights.volatility + factors.riskReward * weights.riskReward;
  return Math.round(Math.max(0, Math.min(100, sum)));
}

export interface ScoreSymbolInput {
  price: number;
  ema20: number | null; ema50: number | null; sma200: number | null; ema20Rising: boolean | null;
  rsi14: number | null; adx14: number | null;
  rs5d: number | null; rs20d: number | null; rs60d: number | null; rs120d: number | null;
  volRatio: number | null;
  atr: number | null; atrPct: number | null;
  sectorScore: number;
  pattern: PatternResult;
}

export interface ScoreSymbolResult extends SwingScoreResult {
  tradePlan: TradePlan;
}

export function scoreSymbol(input: ScoreSymbolInput, presetName: PresetName = DEFAULT_PRESET): ScoreSymbolResult {
  const tradePlan = computeTradePlan({ price: input.price, atr: input.atr, ema20: input.ema20, ema50: input.ema50, pattern: input.pattern });

  const factors: FactorScores = {
    trend: trendScore({ price: input.price, ema20: input.ema20, ema50: input.ema50, sma200: input.sma200, ema20Rising: input.ema20Rising }),
    momentum: momentumScore(input.rsi14, input.adx14),
    relativeStrength: relativeStrengthScore({ rs5d: input.rs5d, rs20d: input.rs20d, rs60d: input.rs60d, rs120d: input.rs120d }),
    setup: setupQualityScore(input.pattern),
    volume: volumeScore(input.volRatio),
    sector: input.sectorScore,
    volatility: volatilityScore(input.atrPct),
    riskReward: riskRewardScore(tradePlan.riskReward),
  };

  const weights = PRESETS[presetName];
  const score = combineFactors(factors, weights);

  return { factors, score, presetName, tradePlan };
}

export { PRESETS, DEFAULT_PRESET };
export type { PresetName };
