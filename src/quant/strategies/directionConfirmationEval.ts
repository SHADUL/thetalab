/**
 * Runs the existing per-expiry optimizer twice — once exactly as before
 * (RR-only) and once with the direction-confirmation policy applied BEFORE
 * the optimizer — and assembles per-expiry telemetry. Pure: no I/O. Which of
 * the two evaluation sets the rest of the pipeline acts on is decided by the
 * mode: only RR_TREND_ENFORCED hands over the confirmed set; RR_ONLY and
 * RR_TREND_OBSERVE always hand over the untouched original.
 */
import { evaluateExpiries, type ExpiryEvaluation, type ExpirySelectorParams } from './expirySelector.ts';
import {
  selectDirectionConfirmed, type ConfirmationOutput, type DirectionConfirmationMode, type NormalizedTrend, type StructureLabel,
} from './directionConfirmation.ts';
import type { EnrichedChain } from '../types.ts';

export interface OptimizerSummary {
  strategyLabel: string;
  targetShortDelta: number;
  wingWidth: number;
  netCredit: number;
  maxProfit: number;
  maxLoss: number;
  pop: number | null;
  expectedValue: number | null;
  evPerUnitRisk: number | null;
  liquidityTier: string;
  score: number;
}

export function summarizeBest(e: ExpiryEvaluation): OptimizerSummary | null {
  const b = e.best;
  if (!b) return null;
  return {
    strategyLabel: e.strategyLabel, targetShortDelta: b.targetShortDelta, wingWidth: b.wingWidth,
    netCredit: b.result.netCredit, maxProfit: b.result.maxProfit, maxLoss: b.result.maxLoss, pop: b.result.pop,
    expectedValue: b.expectedValue, evPerUnitRisk: b.evPerUnitRisk, liquidityTier: b.liquidity.tier, score: b.qualityScore.score,
  };
}

export interface ConfirmationTelemetry {
  expiry: number;
  dte: number;
  rawRiskReversal: number | null;
  rrDirection: string;
  trendState: string;
  trendStale: boolean;
  trendAgeDays: number | null;
  trendAsOfDate: string | null;
  /** Detail of the existing trend classifier's reading (not a new indicator). */
  trendValue: { spotVsEmaSlowPct: number; emaFastVsSlowPct: number } | null;
  trendSource: string;
  alignment: string;
  originalStructure: string;
  /** Version C (full matrix incl. strong-trend veto) — what ENFORCED would do. */
  proposedStructure: StructureLabel | 'NO_TRADE';
  /** Version B (agreement, otherwise Iron Condor candidate; no strong-trend veto) — comparison only. */
  proposedStructureB: StructureLabel | 'NO_TRADE';
  decision: ConfirmationOutput['decision'];
  reasonCode: string;
  reason: string;
  optimizerOriginal: OptimizerSummary | null;
  optimizerProposed: OptimizerSummary | null;
  scoreOriginal: number | null;
  scoreProposed: number | null;
}

export interface ConfirmationContext {
  mode: DirectionConfirmationMode;
  trend: NormalizedTrend;
  trendDetail: { spotVsEmaSlowPct: number; emaFastVsSlowPct: number } | null;
}

export interface ConfirmedEvaluations {
  /** What the rest of the pipeline (decideTrade, sizing, execution) must use. */
  evaluations: ExpiryEvaluation[];
  original: ExpiryEvaluation[];
  proposed: ExpiryEvaluation[] | null;
  telemetry: ConfirmationTelemetry[];
}

export function evaluateExpiriesWithConfirmation(
  chain: EnrichedChain, params: ExpirySelectorParams, ctx: ConfirmationContext,
): ConfirmedEvaluations {
  const original = evaluateExpiries(chain, params);
  if (ctx.mode === 'RR_ONLY') return { evaluations: original, original, proposed: null, telemetry: [] };

  const decisions = new Map<number, { c: ConfirmationOutput; b: ConfirmationOutput; rr: number | null }>();
  const proposed = evaluateExpiries(chain, {
    ...params,
    strategyLabelPolicy: ({ expiry, bias, riskReversal }) => {
      const rrBias = riskReversal === null ? null : bias;
      const base = { rrBias, trend: ctx.trend.state, trendStale: ctx.trend.stale };
      const c = selectDirectionConfirmed({ ...base, strongTrendVeto: true });
      const b = selectDirectionConfirmed({ ...base, strongTrendVeto: false });
      decisions.set(expiry, { c, b, rr: riskReversal });
      return c.structure ? { label: c.structure } : { label: null, reason: `${c.reasonCode}: ${c.reason}` };
    },
  });

  const telemetry: ConfirmationTelemetry[] = [];
  original.forEach((orig, i) => {
    const d = decisions.get(orig.expiry);
    if (!d) return; // excluded by the DTE band before any candidate was evaluated
    const prop = proposed[i];
    const optimizerOriginal = summarizeBest(orig);
    const optimizerProposed = summarizeBest(prop);
    telemetry.push({
      expiry: orig.expiry, dte: orig.dte, rawRiskReversal: d.rr, rrDirection: d.rr === null ? 'UNAVAILABLE' : orig.bias,
      trendState: ctx.trend.state, trendStale: ctx.trend.stale, trendAgeDays: ctx.trend.ageDays, trendAsOfDate: ctx.trend.asOfDate,
      trendValue: ctx.trendDetail, trendSource: 'computeTrend: 20/50-session EMA of real daily closes (analytics/marketRegime.ts)',
      alignment: d.c.alignment, originalStructure: orig.strategyLabel,
      proposedStructure: d.c.structure ?? 'NO_TRADE', proposedStructureB: d.b.structure ?? 'NO_TRADE',
      decision: d.c.decision, reasonCode: d.c.reasonCode, reason: d.c.reason,
      optimizerOriginal, optimizerProposed,
      scoreOriginal: optimizerOriginal?.score ?? null, scoreProposed: optimizerProposed?.score ?? null,
    });
  });

  return { evaluations: ctx.mode === 'RR_TREND_ENFORCED' ? proposed : original, original, proposed, telemetry };
}
