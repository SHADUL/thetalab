/**
 * Chooses which structure to build from the session's own skew reading,
 * rather than always reaching for the same neutral shape. This is the
 * literal thing the spec asked for: "if greeks look bullish, sell PE (and
 * vice versa)" — implemented as a real, stated decision rule off a
 * genuine volatility-surface signal (25-delta risk reversal), not price
 * momentum. RSI/MACD/moving-average style indicators are deliberately not
 * used anywhere in this decision; that was true before this file and stays
 * true here.
 *
 * The threshold matters more than it looks. Every index option chain
 * carries SOME put skew by default — crash protection is a permanent bid,
 * not a signal. Reading ordinary put skew as "bearish" would flip this
 * engine bearish on almost every session, which is not a market read, it's
 * a data artefact. The default threshold (1.5 vol points of risk reversal)
 * is a plain, stated number specifically so it can be argued with — not a
 * tuned model the reasoning is invisible on.
 */
import { buildCreditSpread, isCreditSpreadFailure, type CreditSpreadFailure, type CreditSpreadResult } from './creditSpread.ts';
import { buildIronCondor, isIronCondorFailure, type IronCondorFailure, type IronCondorResult } from './ironCondor.ts';
import type { SkewResult } from '../analytics/skew.ts';
import type { EnrichedSlice, Right } from '../types.ts';

export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface BiasClassification {
  bias: Bias;
  reason: string;
}

export const DEFAULT_SKEW_THRESHOLD = 0.015;

export function classifyBias(skew: SkewResult | null, threshold = DEFAULT_SKEW_THRESHOLD): BiasClassification {
  if (!skew) {
    return { bias: 'neutral', reason: 'No usable skew reading this session — defaulting to a neutral structure.' };
  }
  const rr = skew.riskReversal;
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

  if (rr > threshold) {
    return {
      bias: 'bullish',
      reason: `25-delta risk reversal is ${pct(rr)} — calls are pricing richer than puts, beyond the ` +
        `${(threshold * 100).toFixed(1)}% baseline put-skew every index chain normally carries the other ` +
        `way. That's a genuine call-side bid, not the usual crash-protection floor.`,
    };
  }
  if (rr < -threshold) {
    return {
      bias: 'bearish',
      reason: `25-delta risk reversal is ${pct(rr)} — puts are pricing richer than the normal index ` +
        `baseline, signalling demand for downside protection beyond the ordinary level.`,
    };
  }
  return {
    bias: 'neutral',
    reason: `25-delta risk reversal is ${pct(rr)}, within the ±${(threshold * 100).toFixed(1)}% band every ` +
      `index chain normally sits in — no directional edge from skew this session.`,
  };
}

export interface RegimeStrategyParams {
  targetShortDelta: number;
  wingWidth: number;
  lotSize: number;
  entryPriceOverride?: (strike: number, right: Right) => number | null;
  skewThreshold?: number;
}

export type RegimeOutcome =
  | { strategyLabel: 'Bull Put Spread'; result: CreditSpreadResult | CreditSpreadFailure }
  | { strategyLabel: 'Bear Call Spread'; result: CreditSpreadResult | CreditSpreadFailure }
  | { strategyLabel: 'Iron Condor'; result: IronCondorResult | IronCondorFailure };

export interface RegimeStrategyResult {
  bias: Bias;
  biasReason: string;
}

export function selectStrategy(
  slice: EnrichedSlice,
  skew: SkewResult | null,
  params: RegimeStrategyParams,
): RegimeStrategyResult & RegimeOutcome {
  const { bias, reason } = classifyBias(skew, params.skewThreshold);
  const base = { targetShortDelta: params.targetShortDelta, wingWidth: params.wingWidth, lotSize: params.lotSize,
    entryPriceOverride: params.entryPriceOverride };

  if (bias === 'bullish') {
    return { bias, biasReason: reason, strategyLabel: 'Bull Put Spread',
      result: buildCreditSpread(slice, { ...base, right: 'PE' }) };
  }
  if (bias === 'bearish') {
    return { bias, biasReason: reason, strategyLabel: 'Bear Call Spread',
      result: buildCreditSpread(slice, { ...base, right: 'CE' }) };
  }
  return { bias, biasReason: reason, strategyLabel: 'Iron Condor', result: buildIronCondor(slice, base) };
}

export function isRegimeFailure(outcome: RegimeOutcome): boolean {
  return outcome.strategyLabel === 'Iron Condor'
    ? isIronCondorFailure(outcome.result)
    : isCreditSpreadFailure(outcome.result);
}
