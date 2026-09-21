/**
 * An INDEPENDENT expected-value model — the fix for the structural problem
 * this engine's original EV calculation had: `strikeOptimizer.ts`'s
 * `scoreExpectedValue()` computes `pop * maxProfit - (1-pop) * maxLoss`
 * using a POP that comes from the SAME Black-76 implied volatility that
 * priced the legs. That's close to a fair-value tautology — pricing model
 * agreeing with itself — not a genuine statistical edge.
 *
 * This module estimates the probability of breaching each short strike
 * from the underlying's own REALIZED return history instead, two ways:
 *
 *  - EMPIRICAL: the actual fraction of historical horizon-day windows that
 *    moved far enough to breach the strike. Makes no distributional
 *    assumption at all — just counts what really happened. Preferred
 *    whenever there's enough history to mean anything (a fat-tailed index
 *    return distribution is exactly the case a normal-model approximation
 *    underestimates).
 *  - NORMAL: a lognormal approximation from the SAME realized volatility
 *    number (not IV), for comparison when there's too little history for
 *    a reliable empirical read, and to expose disagreement between the
 *    two when both are available (Phase K's own "compare them" ask).
 *
 * Neither of these ever falls back to the option-implied POP — if there
 * isn't enough real historical data for either estimate, the independent
 * EV is excluded entirely (see computeIndependentExpectedValue), never
 * silently satisfied by the tautological number this module exists to
 * replace.
 */
import { normCdf } from '../math/normal.ts';
import { computeRealizedVolatility, MIN_RETURNS_FOR_RV, type HistoricalClose, type RealizedVolatilityResult } from './realizedVolatility.ts';

export type DistributionMethod = 'empirical' | 'normal-from-realized-vol';

export interface BreachProbability {
  /** Probability the underlying's horizon-day return breaches this strike (touches/closes beyond it, in this model's terms). */
  probability: number;
  method: DistributionMethod;
  /** Number of historical observations behind an empirical read; null for the normal-model read. */
  sampleCount: number | null;
}

/** Signed horizonDays-forward log returns from every overlapping historical window — the raw material for an empirical read. Unlike computeExpectedRealizedMove, this keeps sign and every observation, not just the median absolute value. */
export function buildEmpiricalReturns(closes: HistoricalClose[], horizonDays: number): number[] | null {
  if (!(horizonDays > 0)) return null;
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date));
  const returns: number[] = [];
  for (let i = 0; i + horizonDays < sorted.length; i++) {
    const a = sorted[i].close, b = sorted[i + horizonDays].close;
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  return returns.length >= MIN_RETURNS_FOR_RV ? returns : null;
}

/** What fraction of historical horizonDays-forward returns breached a strike on the given side. No distributional assumption — just counts what actually happened. */
export function empiricalBreachProbability(
  returns: number[],
  currentSpot: number,
  strike: number,
  side: 'upper' | 'lower',
): BreachProbability | null {
  if (!(currentSpot > 0) || !(strike > 0) || returns.length < MIN_RETURNS_FOR_RV) return null;
  const threshold = Math.log(strike / currentSpot);
  const breaches = side === 'upper'
    ? returns.filter((r) => r >= threshold).length
    : returns.filter((r) => r <= threshold).length;
  return { probability: breaches / returns.length, method: 'empirical', sampleCount: returns.length };
}

/** Lognormal approximation using REALIZED (not implied) volatility — a fallback/comparison point when there isn't enough history for an empirical read. */
export function normalBreachProbability(
  realizedVol: RealizedVolatilityResult,
  horizonDays: number,
  currentSpot: number,
  strike: number,
  side: 'upper' | 'lower',
): BreachProbability | null {
  if (!(realizedVol.annualizedVol > 0) || !(horizonDays > 0) || !(currentSpot > 0) || !(strike > 0)) return null;
  const sigmaHorizon = realizedVol.annualizedVol * Math.sqrt(horizonDays / 365);
  if (!(sigmaHorizon > 0)) return null;
  const threshold = Math.log(strike / currentSpot);
  const z = threshold / sigmaHorizon;
  const probability = side === 'upper' ? 1 - normCdf(z) : normCdf(z);
  return { probability, method: 'normal-from-realized-vol', sampleCount: null };
}

export interface ShortStrike {
  strike: number;
  side: 'upper' | 'lower';
}

export interface IndependentPopResult {
  /** Probability the underlying stays within ALL short strikes through expiry — this model's replacement for Black-76 POP. */
  probability: number;
  method: DistributionMethod;
  sampleCount: number | null;
  /** The OTHER model's read on the same probability, when computable — Phase K's "compare them, flag material disagreement." */
  comparison: { probability: number; method: DistributionMethod } | null;
  /** (primary - comparison) as percentage points, when both are available. */
  disagreementPct: number | null;
}

/**
 * Combines per-side breach probabilities into "stays within every short
 * strike." Treats breaches on different sides as mutually exclusive (a
 * simplification also made by strikeOptimizer.ts's own two-outcome EV —
 * not double-counting tail overlap, since a single expiry cannot close
 * both far above AND far below).
 */
export function computeIndependentPop(
  historicalCloses: HistoricalClose[],
  currentSpot: number,
  horizonDays: number,
  shortStrikes: ShortStrike[],
): IndependentPopResult | null {
  if (shortStrikes.length === 0) return null;
  const returns = buildEmpiricalReturns(historicalCloses, horizonDays);
  const realizedVol = computeRealizedVolatility(historicalCloses);

  const empiricalBreaches = returns
    ? shortStrikes.map((s) => empiricalBreachProbability(returns, currentSpot, s.strike, s.side))
    : null;
  const normalBreaches = realizedVol
    ? shortStrikes.map((s) => normalBreachProbability(realizedVol, horizonDays, currentSpot, s.strike, s.side))
    : null;

  const empiricalOk = empiricalBreaches?.every((b): b is BreachProbability => b !== null) ? empiricalBreaches : null;
  const normalOk = normalBreaches?.every((b): b is BreachProbability => b !== null) ? normalBreaches : null;

  const empiricalPop = empiricalOk ? 1 - empiricalOk.reduce((sum, b) => sum + b.probability, 0) : null;
  const normalPop = normalOk ? 1 - normalOk.reduce((sum, b) => sum + b.probability, 0) : null;

  // Empirical is primary whenever there's enough real history — it makes
  // no distributional assumption, which matters most exactly where a
  // normal approximation is weakest (fat tails). Normal is the fallback,
  // never the option-implied POP.
  let primary: { probability: number; method: DistributionMethod; sampleCount: number | null } | null = null;
  let comparison: { probability: number; method: DistributionMethod } | null = null;
  if (empiricalPop !== null) {
    primary = { probability: empiricalPop, method: 'empirical', sampleCount: empiricalOk![0].sampleCount };
    if (normalPop !== null) comparison = { probability: normalPop, method: 'normal-from-realized-vol' };
  } else if (normalPop !== null) {
    primary = { probability: normalPop, method: 'normal-from-realized-vol', sampleCount: null };
  }
  if (!primary) return null;

  const disagreementPct = comparison ? (primary.probability - comparison.probability) * 100 : null;
  return { ...primary, comparison, disagreementPct };
}

export interface IndependentExpectedValue {
  expectedValue: number;
  evPerUnitRisk: number;
  pop: IndependentPopResult;
}

/** Mirrors strikeOptimizer.ts's own scoreExpectedValue formula shape exactly — the only change is WHERE the probability comes from. */
export function computeIndependentExpectedValue(
  legs: Array<{ side: 'BUY' | 'SELL'; right: 'CE' | 'PE'; strike: number }>,
  maxProfit: number,
  maxLoss: number,
  historicalCloses: HistoricalClose[],
  currentSpot: number,
  horizonDays: number,
): IndependentExpectedValue | null {
  if (!(maxLoss > 0)) return null;
  const shortStrikes: ShortStrike[] = legs
    .filter((l) => l.side === 'SELL')
    .map((l) => ({ strike: l.strike, side: l.right === 'CE' ? 'upper' as const : 'lower' as const }));
  const pop = computeIndependentPop(historicalCloses, currentSpot, horizonDays, shortStrikes);
  if (!pop) return null;
  const expectedValue = pop.probability * maxProfit - (1 - pop.probability) * maxLoss;
  return { expectedValue, evPerUnitRisk: expectedValue / maxLoss, pop };
}
