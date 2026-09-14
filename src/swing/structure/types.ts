/**
 * "Structure Score" — a second, independent scanning strategy alongside
 * the existing weighted "Momentum Score" (src/swing/scoring). Rule-based
 * rather than weighted: a stock either passes every gate or it doesn't
 * qualify at all (matches how the source scan — a Chartink screener —
 * actually works: a list of qualifiers, not a ranked universe of
 * everyone). Among stocks that DO qualify, a 0-100 score ranks them by
 * how strongly each condition is satisfied, not just that it was.
 */
export interface StructureGates {
  priceFloor: boolean;        // close > 20
  liquidity: boolean;         // yesterday's volume > 70,000
  near52wHigh: boolean;       // close >= 75% of the 250-day (52w) high
  aboveDailyEma20: boolean;   // close > daily EMA20
  weeklyRsiCeiling: boolean;  // weekly RSI14 < 75
  weeklyHigherHigh: boolean;  // this week's high > last week's high
}

export interface StructureFactorScores {
  proximity: number;      // 0-100: how close to the 52w high, from the 75% gate up to the high itself
  trend: number;           // 0-100: how far above the daily EMA20
  weeklyMomentum: number;  // 0-100: weekly RSI sweet-spot vs the 75 ceiling
  weeklyBreakout: number;  // 0-100: magnitude of the new weekly high over the prior week's
}

export interface StructureScoreResult {
  gates: StructureGates;
  passesAll: boolean;
  factors: StructureFactorScores;
  /** null when the stock doesn't pass every gate — there's no meaningful
   *  rank for a setup that isn't actually a qualifying setup. */
  score: number | null;
}
