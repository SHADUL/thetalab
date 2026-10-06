/**
 * Direction confirmation: the 25-delta risk reversal (RR) alone must not be
 * read as a market forecast — NIFTY put IV is structurally richer than call
 * IV, so RR is negative on most sessions regardless of where the market is
 * heading (stored data: 81% of 47 positions had RR < -1.5%). This pure
 * selector takes the RR-derived bias PLUS the existing trend classifier's
 * state and decides which structure (if any) is eligible, BEFORE the
 * strike/wing optimizer runs. It never forces a bullish/bearish mix and
 * never reverses skew; when the two signals disagree it declines the
 * directional spread (Iron Condor candidate) or the trade entirely.
 *
 * The trend classifier itself (analytics/marketRegime.ts computeTrend) is
 * reused unchanged; this file only normalizes its output.
 */
import type { Bias } from './regimeSelect.ts';
import type { TrendAssessment, TrendState } from '../analytics/marketRegime.ts';

export type DirectionTrend = TrendState | 'UNKNOWN';
export type StructureLabel = 'Bull Put Spread' | 'Bear Call Spread' | 'Iron Condor';
export type ConfirmationDecision = 'CONFIRMED' | 'IC_CANDIDATE' | 'NO_TRADE';
export type ConfirmationAlignment = 'ALIGNED' | 'CONFLICT' | 'STRONG_CONFLICT' | 'NEUTRAL_RR' | 'UNEVALUATED';
export type ConfirmationReasonCode =
  | 'RR_TREND_ALIGNED' | 'RR_TREND_CONFLICT' | 'RR_TREND_STRONG_CONFLICT'
  | 'RR_NEUTRAL_TREND_STRONG' | 'RR_TREND_UNKNOWN' | 'RR_TREND_STALE' | 'IC_NOT_SUITABLE';

export type DirectionConfirmationMode = 'RR_ONLY' | 'RR_TREND_OBSERVE' | 'RR_TREND_ENFORCED';
export const DEFAULT_DIRECTION_CONFIRMATION_MODE: DirectionConfirmationMode = 'RR_TREND_OBSERVE';

export function parseDirectionConfirmationMode(value: unknown): DirectionConfirmationMode {
  return value === 'RR_ONLY' || value === 'RR_TREND_OBSERVE' || value === 'RR_TREND_ENFORCED'
    ? value : DEFAULT_DIRECTION_CONFIRMATION_MODE;
}

/** Newest daily close must be within this many calendar days (covers a long weekend plus a holiday) or the trend is stale. */
export const MAX_TREND_AGE_DAYS = 5;

export interface NormalizedTrend {
  state: DirectionTrend;
  stale: boolean;
  ageDays: number | null;
  asOfDate: string | null;
}

/** Normalizes the existing trend classifier output. A missing assessment is UNKNOWN — never NEUTRAL. */
export function normalizeTrend(
  trend: TrendAssessment | null | undefined,
  latestCloseDate: string | null,
  todayISO: string,
  maxAgeDays: number = MAX_TREND_AGE_DAYS,
): NormalizedTrend {
  const ageDays = latestCloseDate
    ? Math.round((Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${latestCloseDate}T00:00:00Z`)) / 86_400_000)
    : null;
  if (!trend) return { state: 'UNKNOWN', stale: false, ageDays, asOfDate: latestCloseDate };
  const stale = ageDays === null || ageDays > maxAgeDays;
  return { state: trend.state, stale, ageDays, asOfDate: latestCloseDate };
}

const isStrong = (t: DirectionTrend) => t === 'STRONG_BULLISH' || t === 'STRONG_BEARISH';
const trendSide = (t: DirectionTrend): 'bull' | 'bear' | 'neutral' | null =>
  t === 'BULLISH' || t === 'STRONG_BULLISH' ? 'bull'
  : t === 'BEARISH' || t === 'STRONG_BEARISH' ? 'bear'
  : t === 'NEUTRAL' ? 'neutral' : null;

/** Transparent strong-trend veto: an Iron Condor is a short-both-sides range bet, unsuitable against a strong trend. No other neutral/range suitability check exists in this codebase. */
export function isIronCondorSuitable(trend: DirectionTrend, strongTrendVeto: boolean): boolean {
  return !(strongTrendVeto && isStrong(trend));
}

export interface ConfirmationInput {
  /** RR-derived bias; null when no usable skew reading exists (missing data is not NEUTRAL). */
  rrBias: Bias | null;
  trend: DirectionTrend;
  trendStale: boolean;
  /** true = Version C (strong opposing/neutral-RR trend => NO_TRADE); false = Version B (those become IC candidates). */
  strongTrendVeto: boolean;
}

export interface ConfirmationOutput {
  decision: ConfirmationDecision;
  structure: StructureLabel | null;
  reasonCode: ConfirmationReasonCode;
  alignment: ConfirmationAlignment;
  reason: string;
}

function noTrade(code: ConfirmationReasonCode, alignment: ConfirmationAlignment, reason: string): ConfirmationOutput {
  return { decision: 'NO_TRADE', structure: null, reasonCode: code, alignment, reason };
}

function icCandidate(input: ConfirmationInput, code: ConfirmationReasonCode, alignment: ConfirmationAlignment, reason: string): ConfirmationOutput {
  if (!isIronCondorSuitable(input.trend, input.strongTrendVeto)) {
    return noTrade('IC_NOT_SUITABLE', alignment, `Iron Condor candidate rejected: ${input.trend} is a strong trend. (${reason})`);
  }
  return { decision: 'IC_CANDIDATE', structure: 'Iron Condor', reasonCode: code, alignment, reason };
}

export function selectDirectionConfirmed(input: ConfirmationInput): ConfirmationOutput {
  const { rrBias, trend, trendStale, strongTrendVeto } = input;
  if (rrBias === null) return noTrade('RR_TREND_UNKNOWN', 'UNEVALUATED', 'No usable 25-delta risk-reversal reading — not treated as neutral.');
  if (trend === 'UNKNOWN') return noTrade('RR_TREND_UNKNOWN', 'UNEVALUATED', 'Trend regime unavailable — not treated as NEUTRAL.');
  if (trendStale) return noTrade('RR_TREND_STALE', 'UNEVALUATED', `Trend regime ${trend} is stale — the underlying history is too old to trust.`);

  const side = trendSide(trend)!;
  const strong = isStrong(trend);

  if (rrBias === 'neutral') {
    if (side === 'neutral') return icCandidate(input, 'RR_TREND_ALIGNED', 'NEUTRAL_RR', 'Neutral skew and neutral trend — range-style structure.');
    if (strong) {
      return strongTrendVeto
        ? noTrade('RR_NEUTRAL_TREND_STRONG', 'NEUTRAL_RR', `Neutral skew but ${trend} — no directional or range structure is justified.`)
        : icCandidate(input, 'RR_NEUTRAL_TREND_STRONG', 'NEUTRAL_RR', `Neutral skew against ${trend}.`);
    }
    return icCandidate(input, 'RR_TREND_CONFLICT', 'NEUTRAL_RR', `Neutral skew with a mild ${trend} — range structure only, no directional edge.`);
  }

  const rrSide = rrBias === 'bullish' ? 'bull' : 'bear';
  const directional: StructureLabel = rrBias === 'bullish' ? 'Bull Put Spread' : 'Bear Call Spread';

  if (side === rrSide) {
    return { decision: 'CONFIRMED', structure: directional, reasonCode: 'RR_TREND_ALIGNED', alignment: 'ALIGNED',
      reason: `${rrBias} skew confirmed by ${trend} trend.` };
  }
  if (side === 'neutral') {
    return icCandidate(input, 'RR_TREND_CONFLICT', 'CONFLICT', `${rrBias} skew is unconfirmed by a NEUTRAL trend.`);
  }
  if (strong) {
    return strongTrendVeto
      ? noTrade('RR_TREND_STRONG_CONFLICT', 'STRONG_CONFLICT', `${rrBias} skew directly opposes a ${trend} trend.`)
      : icCandidate(input, 'RR_TREND_STRONG_CONFLICT', 'STRONG_CONFLICT', `${rrBias} skew opposes ${trend}.`);
  }
  return icCandidate(input, 'RR_TREND_CONFLICT', 'CONFLICT', `${rrBias} skew opposes a mild ${trend} trend.`);
}
