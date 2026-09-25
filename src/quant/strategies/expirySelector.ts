/**
 * Chooses which expiry to trade by actually running the full pipeline
 * (skew -> strategy selection -> strike optimizer -> trade quality score)
 * ONCE PER AVAILABLE EXPIRY, then comparing the results — rather than a
 * separate "score an expiry" metric disconnected from the trade itself.
 * Every input this uses already exists in this engine; nothing here
 * fabricates a historical-behavior or event-exposure read that doesn't
 * have a real data source yet (same discipline as tradeQualityScore.ts's
 * header — that's what's still missing, not reinvented here).
 *
 * Ranked by the SAME expected-value-per-unit-of-risk metric
 * strikeOptimizer.ts already ranks candidates by within one expiry — using
 * a different metric to compare ACROSS expiries would make the pipeline
 * internally inconsistent. Trade quality score is attached per expiry as
 * diagnostic/threshold information (Phase 8's job), not used as the
 * cross-expiry sort key.
 *
 * DTE is filtered to a configurable band BEFORE candidates are even built:
 * near-zero DTE carries gamma risk this codebase has no backtest to
 * validate yet ("avoid excessive gamma exposure near expiry unless
 * explicitly validated" — the spec's own words), and very-far DTE ties up
 * capital for weak theta efficiency. Default band is a provisional
 * starting point, not a validated one — see tradeQualityScore.ts's DTE
 * scoring for the same caveat.
 */
import { atmIvOf } from '../analytics/atmIv.ts';
import { computeSkew } from '../analytics/skew.ts';
import { expectedMove } from '../analytics/expectedMove.ts';
import {
  computeRealizedVolatility,
  computeExpectedRealizedMove,
  computeIvRvEdge,
  type HistoricalClose,
  type IvRvEdge,
} from '../analytics/realizedVolatility.ts';
import { computeIndependentExpectedValue } from '../analytics/distributionModel.ts';
import { approxTradingSessionsFromCalendarDays } from '../analytics/timeConventions.ts';
import { classifyBias, type Bias } from './regimeSelect.ts';
import {
  generateCandidates,
  type OptimizerCandidate,
  type StrikeOptimizerParams,
} from './strikeOptimizer.ts';
import {
  scoreTradeQuality,
  DEFAULT_TRADE_QUALITY_WEIGHTS,
  type TradeQualityScore,
  type TradeQualityWeights,
} from './tradeQualityScore.ts';
import type { EnrichedChain, EnrichedSlice } from '../types.ts';

export interface ExpirySelectorParams {
  lotSize: number;
  entryPriceOverride?: StrikeOptimizerParams['entryPriceOverride'];
  deltaTargets?: number[];
  /** Required, same as strikeOptimizer.ts — strike-grid dependent, no sane universal default. */
  wingWidths: number[];
  skewThreshold?: number;
  /**
   * A single IV-rank reading applied to every expiry evaluated. The
   * existing history store (buildIvHistory.ts) tracks one near-term ATM IV
   * point per session, not one per future expiry, so there is no real
   * per-expiry IV-rank data source to look up separately — this is
   * intentional, not a simplification of something that actually exists.
   */
  ivRank?: number | null;
  /**
   * Real daily closes for the underlying index, oldest-first-or-not (this
   * module sorts), used to compute realized volatility and the IV/RV
   * premium edge (see analytics/realizedVolatility.ts) per expiry, matched
   * to that expiry's own DTE horizon. This module does NOT fetch history
   * itself — same "caller supplies it" pattern as ivRank above. Omitted or
   * too short a history (< MIN_RETURNS_FOR_RV usable returns) simply
   * excludes premiumEdge from the score; it is never fabricated or
   * defaulted to a "neutral" edge.
   */
  historicalCloses?: HistoricalClose[];
  /** Excludes expiries with fewer days to expiry than this. Default 2 — skips 0/1 DTE (expiry day and the day before) by default; see header. */
  minDte?: number;
  /** Excludes expiries with more days to expiry than this. Default 60. */
  maxDte?: number;
  weights?: TradeQualityWeights;
}

export interface ExpiryEvaluation {
  expiry: number;
  dte: number;
  bias: Bias;
  biasReason: string;
  strategyLabel: StrikeOptimizerParams['strategyLabel'];
  candidateCount: number;
  failureCount: number;
  /** The single best candidate for this expiry, ranked by evPerUnitRisk — null if none priced. */
  best: (OptimizerCandidate & { qualityScore: TradeQualityScore }) | null;
  /** Set when this expiry was excluded before candidate generation (DTE band) or had nothing priceable. */
  skipReason: string | null;
  /**
   * The full IV/RV edge read for THIS expiry's horizon, when historicalCloses
   * was supplied and there was enough history to compute it — null
   * otherwise (never fabricated). Same number that feeds
   * qualityScore.raw.premiumEdgePct on `best`, exposed here directly too
   * since it's computed per-expiry regardless of whether a candidate priced.
   */
  premiumEdge: IvRvEdge | null;
}

const DEFAULT_MIN_DTE = 2;
const DEFAULT_MAX_DTE = 60;

function evaluateOne(slice: EnrichedSlice, params: ExpirySelectorParams): ExpiryEvaluation {
  const dte = Math.round(slice.timeToExpiry * 365);
  const minDte = params.minDte ?? DEFAULT_MIN_DTE;
  const maxDte = params.maxDte ?? DEFAULT_MAX_DTE;

  if (dte < minDte) {
    return {
      expiry: slice.expiry, dte, bias: 'neutral', biasReason: '', strategyLabel: 'Iron Condor',
      candidateCount: 0, failureCount: 0, best: null, premiumEdge: null,
      skipReason: `${dte} DTE is inside the near-expiry gamma-risk window (< ${minDte}) — excluded by default, not validated by any backtest yet.`,
    };
  }
  if (dte > maxDte) {
    return {
      expiry: slice.expiry, dte, bias: 'neutral', biasReason: '', strategyLabel: 'Iron Condor',
      candidateCount: 0, failureCount: 0, best: null, premiumEdge: null,
      skipReason: `${dte} DTE is beyond the configured max (> ${maxDte}) — too much capital tied up for the theta efficiency this far out.`,
    };
  }

  const atmIv = atmIvOf(slice);
  const skew = computeSkew(slice, atmIv);
  const { bias, reason: biasReason } = classifyBias(skew, params.skewThreshold);
  const strategyLabel: StrikeOptimizerParams['strategyLabel'] =
    bias === 'bullish' ? 'Bull Put Spread' : bias === 'bearish' ? 'Bear Call Spread' : 'Iron Condor';

  const premiumEdge = computePremiumEdgeForExpiry(slice, atmIv, dte, params.historicalCloses);

  const { candidates, failures } = generateCandidates(slice, {
    strategyLabel, lotSize: params.lotSize, entryPriceOverride: params.entryPriceOverride,
    deltaTargets: params.deltaTargets, wingWidths: params.wingWidths,
  });

  if (candidates.length === 0) {
    const reasons = [...new Set(failures.map((f) => f.reason))].slice(0, 3).join('; ');
    return {
      expiry: slice.expiry, dte, bias, biasReason, strategyLabel,
      candidateCount: 0, failureCount: failures.length, best: null, premiumEdge,
      skipReason: `No candidate priced for this expiry${reasons ? ` (${reasons})` : ''}.`,
    };
  }

  const top = candidates[0];
  // Independent EV depends on the SPECIFIC selected candidate's own
  // strikes/credit (unlike premiumEdge, which is a property of the expiry
  // as a whole) — computed only once the top candidate is known, from the
  // same real historicalCloses, never from the candidate's own
  // Black-76-derived POP (see distributionModel.ts's header).
  // VOLATILITY_TIME_CONVENTION.md, Option B (implemented): historicalCloses
  // is one row per real TRADING session (Kite's daily candle feed has no
  // row at all for a weekend/holiday) — buildEmpiricalReturns/
  // computeIndependentPop step through it by ARRAY INDEX, i.e. in trading
  // sessions, not calendar days. `dte` is a CALENDAR-day count. Passing it
  // straight through (the pre-fix behavior) silently asked "what happened
  // over N trading sessions" while believing it was asking about N
  // calendar days — for a 30-calendar-day DTE that is a ~43-calendar-day
  // trading window, a real, systematic bias on both of the two highest-
  // weighted score components. Converted once, here, at the boundary.
  const tradingSessionHorizon = approxTradingSessionsFromCalendarDays(dte);
  const independentEv = params.historicalCloses && params.historicalCloses.length > 0
    ? computeIndependentExpectedValue(
        top.result.legs, top.result.maxProfit, top.result.maxLoss,
        params.historicalCloses, slice.forward, tradingSessionHorizon,
      )
    : null;
  const qualityScore = scoreTradeQuality(
    top.result, slice,
    { ivRank: params.ivRank ?? null, premiumEdgePct: premiumEdge?.edgePct ?? null, independentEv },
    params.weights ?? DEFAULT_TRADE_QUALITY_WEIGHTS,
  );

  return {
    expiry: slice.expiry, dte, bias, biasReason, strategyLabel,
    candidateCount: candidates.length, failureCount: failures.length,
    best: { ...top, qualityScore }, premiumEdge, skipReason: null,
  };
}

/**
 * Computes the IV/RV edge for this specific expiry's horizon (dte), or
 * null when historical closes weren't supplied or there wasn't enough
 * usable history — never fabricated (see ExpirySelectorParams.historicalCloses).
 */
function computePremiumEdgeForExpiry(
  slice: EnrichedSlice,
  atmIv: number | null,
  dte: number,
  historicalCloses: HistoricalClose[] | undefined,
): IvRvEdge | null {
  if (!historicalCloses || historicalCloses.length === 0 || atmIv === null) return null;
  // impliedMove is genuinely a CALENDAR-time question ("how far can the
  // underlying move by this calendar expiry date") — dte/365 here is
  // correct and unrelated to the trading-session fix below.
  const impliedMove = expectedMove(slice.forward, atmIv, dte / 365);
  if (!impliedMove) return null;
  const realizedVol = computeRealizedVolatility(historicalCloses);
  // computeExpectedRealizedMove steps through historicalCloses by TRADING
  // session (see the tradingSessionHorizon comment in evaluateOne above)
  // — convert dte (calendar) before this call, not after.
  const expectedRealizedMove = computeExpectedRealizedMove(historicalCloses, approxTradingSessionsFromCalendarDays(dte), slice.forward);
  if (!realizedVol || !expectedRealizedMove) return null;
  return computeIvRvEdge(atmIv, realizedVol, impliedMove.pct * 100, expectedRealizedMove);
}

/** Evaluates every expiry slice in the chain independently. Does not pick a winner — see selectBestExpiry. */
export function evaluateExpiries(chain: EnrichedChain, params: ExpirySelectorParams): ExpiryEvaluation[] {
  return chain.slices.map((slice) => evaluateOne(slice, params));
}

/**
 * Picks the expiry whose best candidate has the highest expected value per
 * unit of risk — the same metric strikeOptimizer.ts ranks candidates by
 * within one expiry, applied consistently across expiries. Returns null
 * when nothing survived the DTE band or every expiry's chain was too
 * sparse to price anything — a genuine "no eligible expiry today", not an
 * error.
 */
export function selectBestExpiry(evaluations: ExpiryEvaluation[]): ExpiryEvaluation | null {
  const eligible = evaluations.filter((e): e is ExpiryEvaluation & { best: NonNullable<ExpiryEvaluation['best']> } => e.best !== null);
  if (eligible.length === 0) return null;
  return eligible.reduce((bestSoFar, e) =>
    (e.best.evPerUnitRisk ?? -Infinity) > (bestSoFar.best.evPerUnitRisk ?? -Infinity) ? e : bestSoFar,
  );
}
