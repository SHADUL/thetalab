/**
 * A single 0-100 quality score per priced candidate, composed from
 * components that can honestly be computed TODAY from this engine's own
 * data — premium edge (IV vs realized volatility), risk/reward, POP, IV
 * rank, strike safety (in expected-move sigmas), DTE suitability,
 * liquidity, and margin efficiency.
 *
 * premiumEdge and independentEv are the two primary signals, weighted
 * accordingly (see DEFAULT_TRADE_QUALITY_WEIGHTS). Before either existed,
 * POP was doing double duty as a stand-in for edge, but POP and a credit
 * structure's payoff are BOTH derived from the same Black-76 implied
 * volatility that priced the legs — comparing a structure against its own
 * pricing model is close to a zero-edge tautology, not a genuine
 * statistical edge read. POP's weight was reduced accordingly once these
 * two existed to do the real work:
 *  - premiumEdge (analytics/realizedVolatility.ts): is the underlying's
 *    IMPLIED move richer than what has actually realized historically —
 *    a property of the option's pricing, independent of which exact
 *    strikes get sold.
 *  - independentEv (analytics/distributionModel.ts): given THIS SPECIFIC
 *    structure's actual strikes/width/credit, does it have positive
 *    expected value under a probability model that does NOT come from
 *    the same IV that priced it (empirical historical-return distribution
 *    first, a realized-vol-based lognormal approximation as fallback).
 *    A rich-IV environment (good premiumEdge) does not by itself mean a
 *    particular structure was built well — this is what actually answers
 *    "would this trade make money," which premiumEdge alone cannot.
 *
 * Deliberately still excludes market regime (beyond skew), event risk,
 * and historical setup performance: no regime engine or event calendar
 * exists in this codebase yet. Fabricating those components with
 * invented numbers would look precise while meaning nothing — this scores
 * only what it can actually see, and the weights below are provisional
 * starting points, NOT validated. "Backtest and optimize them using
 * out-of-sample data" (the spec's own instruction) applies directly here —
 * these should be revisited using the backtest engine that now exists for
 * this module (src/options-auto/backtest/).
 *
 * A missing component (e.g. no IV-rank/realized-vol history yet, or
 * margin not fetched for this candidate) is excluded and the remaining
 * weights renormalize around what's actually available — never treated
 * as zero or worst-case.
 */
import { expectedMove } from '../analytics/expectedMove.ts';
import type { IndependentExpectedValue } from '../analytics/distributionModel.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { EnrichedQuote, EnrichedSlice } from '../types.ts';
import type { IronCondorResult } from './ironCondor.ts';
import type { CreditSpreadResult } from './creditSpread.ts';

export type PricedCandidate = IronCondorResult | CreditSpreadResult;

export interface TradeQualityWeights {
  premiumEdge: number;
  independentEv: number;
  riskReward: number;
  pop: number;
  ivRank: number;
  strikeSafety: number;
  dte: number;
  liquidity: number;
  marginEfficiency: number;
}

/**
 * Provisional — see this file's header. Sums to 100 when every component
 * is present. premiumEdge and independentEv together carry the largest
 * weight: "is the premium adequate for the expected risk" and "does this
 * specific structure have positive expected value under an independent
 * probability model" are the two questions this engine exists to answer.
 * pop's weight was cut from 20 to 7 now that both exist, since POP alone
 * was a near-tautological stand-in for edge (see header) — it's kept as a
 * minor secondary signal, not removed, because a structure can clear both
 * primary signals yet still carry an unacceptably low raw probability of
 * profit.
 */
export const DEFAULT_TRADE_QUALITY_WEIGHTS: TradeQualityWeights = {
  premiumEdge: 20,
  independentEv: 20,
  riskReward: 8,
  pop: 7,
  ivRank: 12,
  strikeSafety: 13,
  dte: 8,
  liquidity: 8,
  marginEfficiency: 4,
};

export interface TradeQualityComponents {
  premiumEdge: number | null;
  independentEv: number | null;
  riskReward: number | null;
  pop: number | null;
  ivRank: number | null;
  strikeSafety: number | null;
  dte: number;
  liquidity: number | null;
  marginEfficiency: number | null;
}

/**
 * The underlying numbers each 0-100 component was derived from, before
 * transformation — kept alongside the abstract scores specifically so an
 * explanation layer can cite "1.6σ from the forward" or "risk/reward 0.28"
 * instead of an opaque "strikeSafety: 80/100". Nothing here is recomputed
 * by a caller; these are exactly the values scoreTradeQuality() already
 * worked out internally.
 */
export interface TradeQualityRaw {
  /** IV/RV edge, in percent — see IvRvEdge.edgePct in analytics/realizedVolatility.ts. */
  premiumEdgePct: number | null;
  /** EV/maxLoss from the independent probability model — see IndependentExpectedValue.evPerUnitRisk in analytics/distributionModel.ts. */
  independentEvPerUnitRisk: number | null;
  /** The independent model's own stay-within-short-strikes probability and method, for the same reason POP's raw number is exposed alongside it. */
  independentPop: number | null;
  independentPopMethod: 'empirical' | 'normal-from-realized-vol' | null;
  /** The OTHER model's disagreement on that same probability, in percentage points, when both were computable — see IndependentPopResult.disagreementPct. */
  independentPopDisagreementPct: number | null;
  riskReward: number | null;
  pop: number | null;
  ivRank: number | null;
  strikeSafetySigma: number | null;
  dte: number;
  avgSpreadPct: number | null;
  minOpenInterest: number | null;
  minVolume: number | null;
  marginEfficiency: number | null;
}

export interface TradeQualityScore {
  /** 0-100, weighted average over whichever components had data. */
  score: number;
  components: TradeQualityComponents;
  /** The pre-transformation numbers behind `components` — see TradeQualityRaw. */
  raw: TradeQualityRaw;
  /** Component names excluded because their input was unavailable. */
  missingComponents: string[];
}

function clamp(x: number): number {
  return Math.max(0, Math.min(100, x));
}

function lerp(x: number, xLo: number, xHi: number, yLo = 0, yHi = 100): number {
  if (xHi === xLo) return clamp(yLo);
  const t = (x - xLo) / (xHi - xLo);
  return clamp(yLo + t * (yHi - yLo));
}

/**
 * The primary signal (see this file's header): is the market pricing more
 * movement than has historically realized over a comparable horizon.
 * edgePct <= -10 (implied move meaningfully UNDER what typically realizes
 * — a bad setup for a premium seller) -> 0; edgePct >= 20 (IV rich versus
 * history by 20%+) -> 100; edgePct = 0 (fair-priced, no edge either way)
 * lands at 33/100 — deliberately below the midpoint, since "no edge" is a
 * mediocre setup, not a neutral-good one, for a strategy whose entire
 * thesis is selling overpriced premium.
 */
function scorePremiumEdge(edgePct: number | null): number | null {
  return edgePct === null ? null : lerp(edgePct, -10, 20);
}

/**
 * The other primary signal (see this file's header): does THIS structure
 * have positive expected value under the independent probability model,
 * per unit of risk. Unlike premiumEdge, 0 (genuinely breakeven) is scored
 * as a true midpoint (50) rather than pulled below it — evPerUnitRisk is
 * already a direct EV read, not a richness-vs-history comparison, so
 * "breakeven" really is a neutral result here, not a mediocre one.
 * -0.15/+0.15 is a provisional band matching the rough magnitude this
 * engine's own live diagnostics have shown (see this file's header caveat
 * on all such bands).
 */
function scoreIndependentEv(evPerUnitRisk: number | null): number | null {
  return evPerUnitRisk === null ? null : lerp(evPerUnitRisk, -0.15, 0.15);
}

/** 0 -> 0, 0.5+ -> 100. Most defined-risk credit structures run 0.15-0.4; RR>=1 is rare by construction. */
function scoreRiskReward(rr: number | null): number | null {
  return rr === null ? null : lerp(rr, 0, 0.5);
}

/** A typical iron-condor/credit-spread target sits 0.65-0.85 POP; below 0.5 is a coin flip, not a credit-seller's edge. */
function scorePop(pop: number | null): number | null {
  return pop === null ? null : lerp(pop, 0.5, 0.9);
}

/** IV rank is already 0-100 (ivRankAndPercentile) — direct pass-through, higher rank = richer premium to sell. */
function scoreIvRank(ivRank: number | null): number | null {
  return ivRank === null ? null : clamp(ivRank);
}

/** Distance of the nearest short strike from the forward, in expected-move sigmas. 0 sigma (ATM) is dangerous; 2+ is a wide margin of safety. */
function scoreStrikeSafety(sigma: number | null): number | null {
  return sigma === null ? null : lerp(sigma, 0, 2);
}

/**
 * Penalizes both too-close (gamma risk ramps as expiry nears) and
 * too-far (capital tied up, weaker theta efficiency) — a plateau in
 * between, not a single ideal number.
 */
function scoreDte(dte: number, minDte = 7, idealMin = 14, idealMax = 45, maxDte = 90): number {
  if (dte <= 0) return 0;
  if (dte < minDte) return lerp(dte, 0, minDte, 0, 30);
  if (dte < idealMin) return lerp(dte, minDte, idealMin, 30, 100);
  if (dte <= idealMax) return 100;
  if (dte < maxDte) return lerp(dte, idealMax, maxDte, 100, 20);
  return 20;
}

/**
 * Spread quality plus a hard liquidity gate: a leg below this engine's own
 * configured minOpenInterest/minVolume thresholds (config.ts) is a real
 * execution-risk flag, not just a soft ding — halves the score rather than
 * linearly discounting it. (config.ts declared these thresholds from the
 * start but nothing enforced them as a gate until this scorer.)
 *
 * Spread and OI/volume are scored independently rather than gating on
 * spread alone: EOD/bhavcopy-style data (this engine's most common source
 * — see enrich.ts) has no bid/ask at all, so spreadPct is legitimately null
 * on every quote even when OI/volume are perfectly healthy. Discarding the
 * whole component whenever spread happens to be unavailable would silently
 * blind the score to real illiquidity on exactly the data this engine sees
 * most often.
 */
function scoreLiquidity(
  avgSpreadPct: number | null,
  minOpenInterest: number | null,
  minVolume: number | null,
  cfg = DEFAULT_CONFIG.dataQuality,
): number | null {
  if (avgSpreadPct === null && minOpenInterest === null && minVolume === null) return null;
  let score = avgSpreadPct !== null ? lerp(avgSpreadPct, 0, 0.1, 100, 0) : 100;
  if (minOpenInterest !== null && minOpenInterest < cfg.minOpenInterest) score *= 0.5;
  if (minVolume !== null && minVolume < cfg.minVolume) score *= 0.5;
  return clamp(score);
}

/** Credit collected per rupee of margin required — 0 -> 0, 15%+ -> 100. Only scored when a live margin figure was supplied. */
function scoreMarginEfficiency(totalCredit: number, marginRequired: number | null | undefined): number | null {
  if (marginRequired == null || !(marginRequired > 0)) return null;
  return lerp(totalCredit / marginRequired, 0, 0.15);
}

/**
 * @param candidate  A priced Iron Condor or Credit Spread result.
 * @param slice       The SAME EnrichedSlice the candidate was built from —
 *   needed to look up each leg's spread/OI/volume, which the priced result
 *   itself doesn't retain.
 * @param extras.ivRank        0-100, from ivRankAndPercentile() against real
 *   history — this module doesn't fetch history itself, the caller supplies it.
 * @param extras.marginRequired  Rupee margin from a live /margins/basket call,
 *   if the caller already fetched one for this exact candidate. Optional —
 *   fetching margin for every generated candidate would be far too many
 *   live calls; callers should fetch it only for finalists.
 * @param extras.premiumEdgePct  IV/RV edge in percent (IvRvEdge.edgePct from
 *   analytics/realizedVolatility.ts), computed by the caller from real
 *   historical closes for this expiry's horizon. This module doesn't fetch
 *   or compute realized volatility itself — same "caller supplies it"
 *   pattern as ivRank. Null/omitted when historical closes aren't
 *   available yet, in which case premiumEdge is excluded and the other
 *   weights renormalize (see this file's header) — never defaulted to 0
 *   or to a fabricated "neutral" edge.
 * @param extras.independentEv  The full result from
 *   analytics/distributionModel.ts's computeIndependentExpectedValue(),
 *   computed by the caller from this exact candidate's legs and real
 *   historical closes — same "caller supplies it" pattern as ivRank and
 *   premiumEdgePct. Null/omitted excludes independentEv (renormalized),
 *   never substituted with the candidate's own Black-76-derived
 *   expectedValue — that number is exactly what this component exists to
 *   NOT rely on (see this file's header).
 */
export function scoreTradeQuality(
  candidate: PricedCandidate,
  slice: EnrichedSlice,
  extras: {
    ivRank: number | null;
    marginRequired?: number | null;
    premiumEdgePct?: number | null;
    independentEv?: IndependentExpectedValue | null;
  },
  weights: TradeQualityWeights = DEFAULT_TRADE_QUALITY_WEIGHTS,
): TradeQualityScore {
  const riskRewardRaw = candidate.maxLoss > 0 ? candidate.maxProfit / candidate.maxLoss : null;

  const legLookup = new Map(slice.quotes.map((q) => [`${q.quote.strike}:${q.quote.right}`, q]));
  const legQuotes = candidate.legs
    .map((l) => legLookup.get(`${l.strike}:${l.right}`))
    .filter((q): q is EnrichedQuote => q != null);

  const spreadPcts = legQuotes.map((q) => q.spreadPct).filter((v): v is number => v != null);
  const avgSpreadPct = spreadPcts.length ? spreadPcts.reduce((a, b) => a + b, 0) / spreadPcts.length : null;
  const ois = legQuotes.map((q) => q.quote.openInterest).filter((v): v is number => v != null);
  const minOpenInterest = ois.length ? Math.min(...ois) : null;
  const volumes = legQuotes.map((q) => q.quote.volume).filter((v): v is number => v != null);
  const minVolume = volumes.length ? Math.min(...volumes) : null;

  const shortLegs = candidate.legs.filter((l) => l.side === 'SELL');
  const move = candidate.atmIv !== null ? expectedMove(candidate.forward, candidate.atmIv, candidate.dte / 365) : null;
  let strikeSafetySigma: number | null = null;
  if (move && move.points > 0 && shortLegs.length > 0) {
    strikeSafetySigma = Math.min(...shortLegs.map((l) => Math.abs(l.strike - candidate.forward) / move.points));
  }

  const premiumEdgePct = extras.premiumEdgePct ?? null;
  const independentEv = extras.independentEv ?? null;

  const components: TradeQualityComponents = {
    premiumEdge: scorePremiumEdge(premiumEdgePct),
    independentEv: scoreIndependentEv(independentEv?.evPerUnitRisk ?? null),
    riskReward: scoreRiskReward(riskRewardRaw),
    pop: scorePop(candidate.pop),
    ivRank: scoreIvRank(extras.ivRank),
    strikeSafety: scoreStrikeSafety(strikeSafetySigma),
    dte: scoreDte(candidate.dte),
    liquidity: scoreLiquidity(avgSpreadPct, minOpenInterest, minVolume),
    marginEfficiency: scoreMarginEfficiency(candidate.maxProfit, extras.marginRequired),
  };

  let weightedSum = 0;
  let weightTotal = 0;
  const missingComponents: string[] = [];
  for (const key of Object.keys(components) as (keyof TradeQualityComponents)[]) {
    const value = components[key];
    const weight = weights[key as keyof TradeQualityWeights];
    if (value === null) {
      missingComponents.push(key);
      continue;
    }
    weightedSum += value * weight;
    weightTotal += weight;
  }

  const raw: TradeQualityRaw = {
    premiumEdgePct,
    independentEvPerUnitRisk: independentEv?.evPerUnitRisk ?? null,
    independentPop: independentEv?.pop.probability ?? null,
    independentPopMethod: independentEv?.pop.method ?? null,
    independentPopDisagreementPct: independentEv?.pop.disagreementPct ?? null,
    riskReward: riskRewardRaw,
    pop: candidate.pop,
    ivRank: extras.ivRank,
    strikeSafetySigma,
    dte: candidate.dte,
    avgSpreadPct,
    minOpenInterest,
    minVolume,
    marginEfficiency: extras.marginRequired != null && extras.marginRequired > 0
      ? candidate.maxProfit / extras.marginRequired : null,
  };

  return {
    score: weightTotal > 0 ? clamp(weightedSum / weightTotal) : 0,
    components,
    raw,
    missingComponents,
  };
}
