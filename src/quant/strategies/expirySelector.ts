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
      candidateCount: 0, failureCount: 0, best: null,
      skipReason: `${dte} DTE is inside the near-expiry gamma-risk window (< ${minDte}) — excluded by default, not validated by any backtest yet.`,
    };
  }
  if (dte > maxDte) {
    return {
      expiry: slice.expiry, dte, bias: 'neutral', biasReason: '', strategyLabel: 'Iron Condor',
      candidateCount: 0, failureCount: 0, best: null,
      skipReason: `${dte} DTE is beyond the configured max (> ${maxDte}) — too much capital tied up for the theta efficiency this far out.`,
    };
  }

  const atmIv = atmIvOf(slice);
  const skew = computeSkew(slice, atmIv);
  const { bias, reason: biasReason } = classifyBias(skew, params.skewThreshold);
  const strategyLabel: StrikeOptimizerParams['strategyLabel'] =
    bias === 'bullish' ? 'Bull Put Spread' : bias === 'bearish' ? 'Bear Call Spread' : 'Iron Condor';

  const { candidates, failures } = generateCandidates(slice, {
    strategyLabel, lotSize: params.lotSize, entryPriceOverride: params.entryPriceOverride,
    deltaTargets: params.deltaTargets, wingWidths: params.wingWidths,
  });

  if (candidates.length === 0) {
    const reasons = [...new Set(failures.map((f) => f.reason))].slice(0, 3).join('; ');
    return {
      expiry: slice.expiry, dte, bias, biasReason, strategyLabel,
      candidateCount: 0, failureCount: failures.length, best: null,
      skipReason: `No candidate priced for this expiry${reasons ? ` (${reasons})` : ''}.`,
    };
  }

  const top = candidates[0];
  const qualityScore = scoreTradeQuality(top.result, slice, { ivRank: params.ivRank ?? null }, params.weights ?? DEFAULT_TRADE_QUALITY_WEIGHTS);

  return {
    expiry: slice.expiry, dte, bias, biasReason, strategyLabel,
    candidateCount: candidates.length, failureCount: failures.length,
    best: { ...top, qualityScore }, skipReason: null,
  };
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
