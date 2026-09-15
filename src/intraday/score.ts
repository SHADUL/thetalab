import type { IntradayFactorScores, EntryChecklist, TradePlan, Direction } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Spec §9's suggested initial weighting — configurable, not exposed to
 *  the end user as dozens of knobs. */
export const INTRADAY_FACTOR_WEIGHTS: Record<keyof IntradayFactorScores, number> = {
  relativeStrength: 0.20, momentum: 0.15, volume: 0.15, setup: 0.15,
  vwapPosition: 0.10, regimeAlignment: 0.10, sectorStrength: 0.10, liquidity: 0.05,
};

export function combineIntradayFactors(factors: IntradayFactorScores): number {
  let sum = 0;
  for (const key of Object.keys(INTRADAY_FACTOR_WEIGHTS) as (keyof IntradayFactorScores)[]) {
    sum += factors[key] * INTRADAY_FACTOR_WEIGHTS[key];
  }
  return Math.round(clamp(sum, 0, 100));
}

export type SignalConfidence = 'A_PLUS' | 'A' | 'B' | 'WATCH' | 'IGNORE';

/** Spec §24's bands. */
export function signalConfidenceLabel(score: number): SignalConfidence {
  if (score >= 90) return 'A_PLUS';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'WATCH';
  return 'IGNORE';
}

/**
 * A pure AND-gate over pre-resolved conditions (spec §23's 13-point
 * checklist, minus the purely mechanical ones like "no data issue" that
 * belong at the API layer, not in scoring logic). The caller resolves
 * each boolean using its own context (settings thresholds, live data) —
 * this function's only job is to aggregate them honestly into one
 * checklist record and one allPass verdict, never re-deriving them.
 */
export function evaluateEntryChecklist(input: EntryChecklist): { checklist: EntryChecklist; allPass: boolean } {
  const allPass = Object.values(input).every(Boolean);
  return { checklist: input, allPass };
}

/**
 * Trade plan (spec §25). target1/target2 are the fixed 1R/2R scale-out
 * ladder the spec asks for; `structuralTarget` is a SEPARATE, caller-
 * supplied "realistic target" (e.g. a measured-move projection or the
 * next resistance/support) used only to compute the pre-entry R:R gate
 * (spec §1/§23's "target produces acceptable R:R") — conflating the two
 * would mean every trade's R:R is trivially 1.0 or 2.0 by construction,
 * which defeats the point of the R:R filter.
 */
export function buildTradePlan(direction: Direction, entry: number, stop: number, structuralTarget: number): TradePlan {
  const riskPerShare = Math.abs(entry - stop);
  const rewardPerShare = Math.abs(structuralTarget - entry);
  const riskReward = riskPerShare > 0 ? rewardPerShare / riskPerShare : null;
  const target1 = direction === 'LONG' ? entry + riskPerShare : entry - riskPerShare;
  const target2 = direction === 'LONG' ? entry + riskPerShare * 2 : entry - riskPerShare * 2;
  return { direction, entry, stop, target1, target2, riskPerShare, riskReward };
}

const CHECKLIST_LABEL: Record<keyof EntryChecklist, string> = {
  regimeSupportive: 'Market regime supportive',
  sectorSupportive: 'Sector supportive',
  relativeStrengthStrong: 'Strong relative strength',
  liquid: 'Liquid enough for clean execution',
  vwapAligned: 'Price aligned with VWAP',
  trendAligned: 'Intraday trend aligned',
  validSetup: 'Valid setup structure',
  rvolConfirms: 'Relative volume confirms',
  triggerOccurred: 'Entry trigger occurred',
  stopLogical: 'Stop placed at a logical structural level',
  rrAcceptable: 'Risk/reward acceptable',
  notExtended: 'Not excessively extended',
};

/** Spec §54's machine-readable, auditable explanation — every confirmed
 *  condition becomes one line; nothing here is prose generated after
 *  the fact, it's a direct restatement of the checklist that decided
 *  the trade. */
export function explainChecklist(checklist: EntryChecklist): { confirmations: string[]; failures: string[] } {
  const confirmations: string[] = [];
  const failures: string[] = [];
  for (const key of Object.keys(checklist) as (keyof EntryChecklist)[]) {
    (checklist[key] ? confirmations : failures).push(CHECKLIST_LABEL[key]);
  }
  return { confirmations, failures };
}
