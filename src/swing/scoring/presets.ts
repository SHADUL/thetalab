/**
 * Weight presets (spec §22/§57) — the same 8 factors, reweighted for a
 * different hunting style, rather than separate scoring logic per mode.
 * BALANCED is spec §22's own suggested weighting verbatim. Every other
 * preset is a deliberate emphasis shift (more setup+volume for breakout
 * hunting, more trend+risk/reward for a defensive pullback approach), not
 * a value fitted against backtest results — per spec §56, this is the
 * "robustness over overfitting" rule applied to the weights themselves.
 * Each preset's weights sum to 1.0, checked by a test rather than left to
 * eyeballing arithmetic in a comment.
 */
import type { WeightPreset } from './types.ts';

export const PRESETS = {
  BALANCED: { trend: 0.15, momentum: 0.15, relativeStrength: 0.15, setup: 0.15, volume: 0.10, sector: 0.10, volatility: 0.10, riskReward: 0.10 },
  MOMENTUM: { trend: 0.10, momentum: 0.25, relativeStrength: 0.20, setup: 0.10, volume: 0.15, sector: 0.05, volatility: 0.10, riskReward: 0.05 },
  BREAKOUT: { trend: 0.10, momentum: 0.10, relativeStrength: 0.10, setup: 0.30, volume: 0.20, sector: 0.05, volatility: 0.10, riskReward: 0.05 },
  EARLY_BREAKOUT: { trend: 0.15, momentum: 0.10, relativeStrength: 0.20, setup: 0.20, volume: 0.15, sector: 0.10, volatility: 0.05, riskReward: 0.05 },
  PULLBACK: { trend: 0.20, momentum: 0.10, relativeStrength: 0.15, setup: 0.20, volume: 0.05, sector: 0.10, volatility: 0.05, riskReward: 0.15 },
  AGGRESSIVE: { trend: 0.05, momentum: 0.25, relativeStrength: 0.15, setup: 0.15, volume: 0.15, sector: 0.05, volatility: 0.15, riskReward: 0.05 },
} satisfies Record<string, WeightPreset>;

export type PresetName = keyof typeof PRESETS;
export const DEFAULT_PRESET: PresetName = 'BALANCED';
