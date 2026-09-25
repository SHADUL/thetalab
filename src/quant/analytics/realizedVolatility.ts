/**
 * Realized volatility and the IV/RV edge — the genuine statistical-edge
 * signal that was missing from this engine until now. The prior
 * `expectedValue` calculation in strikeOptimizer.ts computes POP and
 * payoff both from the SAME Black-76 implied volatility that priced the
 * legs — which is close to a zero-edge, fair-value tautology by
 * construction, not a real edge read. A genuine edge can only come from
 * comparing implied volatility against what the underlying has ACTUALLY
 * realized historically — exactly what this file computes.
 *
 * Refuses to compute anything from too little history to mean anything,
 * matching ivRank.ts's own MIN_WINDOW_DAYS discipline — a number built
 * from 5 data points is worse than no number at all.
 */

export interface HistoricalClose {
  date: string;
  close: number;
}

export const MIN_RETURNS_FOR_RV = 20;

export interface RealizedVolatilityResult {
  /** Annualized, e.g. 0.12 = 12%. */
  annualizedVol: number;
  windowDays: number;
}

/** Standard close-to-close annualized realized volatility (stdev of daily log returns * sqrt(252)). */
export function computeRealizedVolatility(closes: HistoricalClose[], lookbackDays = 252): RealizedVolatilityResult | null {
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-(lookbackDays + 1));
  const logReturns: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].close > 0 && sorted[i].close > 0) logReturns.push(Math.log(sorted[i].close / sorted[i - 1].close));
  }
  if (logReturns.length < MIN_RETURNS_FOR_RV) return null;

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return { annualizedVol: Math.sqrt(variance) * Math.sqrt(252), windowDays: logReturns.length };
}

export interface ExpectedRealizedMoveResult {
  /** Median absolute horizonSessions-forward log return across all historical overlapping windows, converted to points at currentSpot. */
  points: number;
  pct: number;
  sampleCount: number;
}

/**
 * "What has this underlying actually done, historically, over a window
 * this long" — directly comparable (same horizon, same units) to the
 * option's own implied expected move, rather than needing an
 * annualize-then-de-annualize round trip through a fixed-window RV
 * number. Uses the MEDIAN of overlapping horizon windows, not the
 * mean, so one historical outlier (a single crash day) doesn't dominate
 * the read the way a mean would.
 *
 * @param horizonSessions Trading SESSIONS, not calendar days — `closes` has
 *   one row per real trading session (see distributionModel.ts's
 *   buildEmpiricalReturns for the full rationale; the same fix applies
 *   here). A caller holding a calendar DTE must convert first via
 *   analytics/timeConventions.ts.
 */
export function computeExpectedRealizedMove(closes: HistoricalClose[], horizonSessions: number, currentSpot: number): ExpectedRealizedMoveResult | null {
  if (!(horizonSessions > 0) || !(currentSpot > 0)) return null;
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date));
  const absReturns: number[] = [];
  for (let i = 0; i + horizonSessions < sorted.length; i++) {
    const a = sorted[i].close, b = sorted[i + horizonSessions].close;
    if (a > 0 && b > 0) absReturns.push(Math.abs(Math.log(b / a)));
  }
  if (absReturns.length < MIN_RETURNS_FOR_RV) return null;

  absReturns.sort((a, b) => a - b);
  const median = absReturns[Math.floor(absReturns.length / 2)];
  return { points: currentSpot * median, pct: median * 100, sampleCount: absReturns.length };
}

export interface IvRvEdge {
  /** annualizedIv / annualizedRealizedVol. 1.0 = priced exactly at what has realized; >1 = IV richer than history, the condition a premium seller wants. */
  annualizedRatio: number;
  /** impliedMovePct / expectedRealizedMovePct for THIS specific expiry's horizon — the more decision-relevant of the two ratios, since it's horizon-matched to the actual trade. */
  horizonMatchedRatio: number;
  /** (horizonMatchedRatio - 1) * 100 — positive means the market is pricing more movement than has typically happened over a comparable window. */
  edgePct: number;
}

export function computeIvRvEdge(
  annualizedIv: number,
  realizedVol: RealizedVolatilityResult,
  impliedMovePct: number,
  expectedRealizedMove: ExpectedRealizedMoveResult,
): IvRvEdge | null {
  if (!(realizedVol.annualizedVol > 0) || !(expectedRealizedMove.pct > 0)) return null;
  const horizonMatchedRatio = impliedMovePct / expectedRealizedMove.pct;
  return {
    annualizedRatio: annualizedIv / realizedVol.annualizedVol,
    horizonMatchedRatio,
    edgePct: (horizonMatchedRatio - 1) * 100,
  };
}
