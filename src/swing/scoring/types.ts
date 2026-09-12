/** The 8 factors spec §22 weights into the composite Swing Score, each
 *  independently 0-100 so they can be inspected on their own (spec §29's
 *  technical scorecard) as well as combined. */
export interface FactorScores {
  trend: number;
  momentum: number;
  relativeStrength: number;
  setup: number;
  volume: number;
  sector: number;
  volatility: number;
  riskReward: number;
}

/** Sums to 1.0. Enforced by a test, not just a comment — a preset that
 *  silently drifts off 1.0 would quietly under- or over-weight every score
 *  computed with it. */
export type WeightPreset = FactorScores;

export interface TradePlan {
  entry: number;
  /** Null when no stop could be derived at all (e.g., zero ATR and no
   *  other structure to anchor on) — never a guessed flat percentage, per
   *  spec §55: don't display a number when the underlying data is missing. */
  stop: number | null;
  target: number;
  /** Reward-to-risk to the primary +10% target — null whenever stop is. */
  riskReward: number | null;
}

export interface SwingScoreResult {
  factors: FactorScores;
  score: number; // 0-100, the weighted composite
  presetName: string;
}
