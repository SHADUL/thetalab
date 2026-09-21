/**
 * A genuinely INDEPENDENT market-regime read, separate from skew.
 *
 * Before this file, `regimeSelect.ts`'s `classifyBias()` — a pure 25-delta
 * risk-reversal (skew) read — was the ONLY directional assessment this
 * engine ever produced, and it gets printed straight into the decision
 * explanation as "Bias: bearish". That conflates two different things: a
 * skew read says "options traders are paying up for downside protection
 * right now," which is NOT the same claim as "the underlying is in a
 * bearish trend." An index can be flat or even rallying while carrying
 * elevated put skew (crash-protection demand is not the same as directional
 * conviction), and vice versa. Calling that skew read "the market regime"
 * would be exactly the mistake this file exists to not make.
 *
 * This module builds a SEPARATE regime assessment from the underlying's
 * own real price history and (when the caller supplies them) real India
 * VIX and today's OHLC — never from skew, and never by reusing
 * classifyBias()'s output under a different name. `regimeSelect.ts` and
 * `skew.ts` are UNCHANGED and still drive strategy selection exactly as
 * before; this is an additional, independently-computed variable, meant
 * to be surfaced ALONGSIDE the skew read, not in place of it.
 *
 * Deliberately excludes market breadth and VWAP-relative-to-price: this
 * engine has no data source for either (breadth needs constituent-level
 * advance/decline data across the index's stocks; VWAP needs an intraday
 * tick series) — see MarketRegimeInputs' own comments. Left UNAVAILABLE
 * rather than faked with a plausible-looking number.
 */
import { computeRealizedVolatility, type HistoricalClose } from './realizedVolatility.ts';

export type TrendState = 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
export type VolatilityRegimeLabel = 'HIGH_VOLATILITY' | 'ELEVATED' | 'NORMAL' | 'LOW_VOLATILITY';
export type MarketRegimeLabel = TrendState | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY' | 'UNSTABLE' | 'NO_TRADE';

const MIN_CLOSES_FOR_TREND = 55; // enough for a 50-session slow EMA plus a few observations of its own trend

/** Standard exponential moving average — most recent close weighted most heavily. */
function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // seed with a simple average
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

export interface TrendAssessment {
  state: TrendState;
  emaFast: number;
  emaSlow: number;
  /** (emaFast - emaSlow) / emaSlow, as a percentage. Positive = fast above slow (uptrend structure). */
  emaFastVsSlowPct: number;
  /** (currentSpot - emaSlow) / emaSlow, as a percentage. */
  spotVsEmaSlowPct: number;
}

/**
 * A stated, arguable rule (same posture as every other threshold in this
 * codebase — see e.g. regimeSelect.ts's own header): EMA structure (fast
 * vs slow) sets direction, distance of spot from the slow EMA sets
 * strength. Provisional bands, not backtested/validated.
 */
export function computeTrend(
  closes: HistoricalClose[],
  currentSpot: number,
  fastPeriod = 20,
  slowPeriod = 50,
): TrendAssessment | null {
  if (!(currentSpot > 0) || closes.length < Math.max(slowPeriod, MIN_CLOSES_FOR_TREND)) return null;
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date)).map((c) => c.close);
  const emaFast = ema(sorted, fastPeriod);
  const emaSlow = ema(sorted, slowPeriod);
  if (emaFast === null || emaSlow === null || !(emaSlow > 0)) return null;

  const emaFastVsSlowPct = ((emaFast - emaSlow) / emaSlow) * 100;
  const spotVsEmaSlowPct = ((currentSpot - emaSlow) / emaSlow) * 100;

  let state: TrendState;
  if (emaFastVsSlowPct > 0 && spotVsEmaSlowPct > 2) state = 'STRONG_BULLISH';
  else if (emaFastVsSlowPct > 0 && spotVsEmaSlowPct > 0) state = 'BULLISH';
  else if (emaFastVsSlowPct < 0 && spotVsEmaSlowPct < -2) state = 'STRONG_BEARISH';
  else if (emaFastVsSlowPct < 0 && spotVsEmaSlowPct < 0) state = 'BEARISH';
  else state = 'NEUTRAL';

  return { state, emaFast, emaSlow, emaFastVsSlowPct, spotVsEmaSlowPct };
}

/**
 * Weekly-resampled trend (last close of each ISO week), same EMA logic
 * with shorter periods — a genuine "higher timeframe" read derived from
 * the same real daily closes, not a second data source.
 */
export function computeHigherTimeframeTrend(closes: HistoricalClose[], currentSpot: number): TrendAssessment | null {
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date));
  const weekly: HistoricalClose[] = [];
  let lastWeekKey: string | null = null;
  for (const c of sorted) {
    const d = new Date(`${c.date}T00:00:00Z`);
    const weekKey = `${d.getUTCFullYear()}-${Math.floor((d.getUTCDate() + d.getUTCDay()) / 7)}-${d.getUTCMonth()}`;
    if (weekKey !== lastWeekKey) { weekly.push(c); lastWeekKey = weekKey; }
    else weekly[weekly.length - 1] = c; // keep overwriting until the last close of that week
  }
  return computeTrend(weekly, currentSpot, 4, 10);
}

export interface VolatilityRegimeAssessment {
  label: VolatilityRegimeLabel;
  currentRv20d: number;
  /** Percentile of today's trailing-20d realized vol against its own rolling history — the RV-analog of ivRank.ts's IV percentile. */
  percentile: number;
  windowDays: number;
}

const MIN_ROLLING_RV_POINTS = 20;

/** Ranks today's short-window realized vol against its own rolling history — genuinely computable from close data alone, the same way ivRank.ts ranks IV without a second data source. */
export function computeVolatilityRegime(
  closes: HistoricalClose[],
  rvWindowDays = 20,
  rankLookbackDays = 252,
): VolatilityRegimeAssessment | null {
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date));
  const rollingRv: number[] = [];
  for (let end = rvWindowDays + 1; end <= sorted.length; end++) {
    const windowSlice = sorted.slice(Math.max(0, end - (rvWindowDays + 1)), end);
    const rv = computeRealizedVolatility(windowSlice, rvWindowDays);
    if (rv) rollingRv.push(rv.annualizedVol);
  }
  if (rollingRv.length < MIN_ROLLING_RV_POINTS) return null;

  const windowed = rollingRv.slice(-rankLookbackDays);
  const current = windowed[windowed.length - 1];
  const below = windowed.filter((v) => v < current).length;
  const percentile = (below / windowed.length) * 100;

  let label: VolatilityRegimeLabel;
  if (percentile >= 80) label = 'HIGH_VOLATILITY';
  else if (percentile >= 60) label = 'ELEVATED';
  else if (percentile <= 20) label = 'LOW_VOLATILITY';
  else label = 'NORMAL';

  return { label, currentRv20d: current, percentile, windowDays: windowed.length };
}

export interface WhipsawAssessment {
  /** Fraction of consecutive daily returns that flipped sign, over the trailing window. 0.5 is the random-walk baseline; materially above it is genuine day-to-day direction instability. */
  signFlipRatio: number;
  windowDays: number;
}

/** A real, computable instability signal: how often the underlying reverses direction day-to-day, not a proxy or a guess. */
export function computeWhipsaw(closes: HistoricalClose[], windowDays = 20): WhipsawAssessment | null {
  const sorted = closes.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < windowDays + 2) return null;
  const recent = sorted.slice(-(windowDays + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].close > 0 && recent[i].close > 0) returns.push(Math.log(recent[i].close / recent[i - 1].close));
  }
  if (returns.length < windowDays - 1) return null;
  let flips = 0;
  for (let i = 1; i < returns.length; i++) {
    if ((returns[i] > 0) !== (returns[i - 1] > 0)) flips++;
  }
  return { signFlipRatio: flips / (returns.length - 1), windowDays: returns.length };
}

export interface GapAndRange {
  /** (today's open - previous close) / previous close, as a percentage. */
  gapPct: number;
  /** (today's high - today's low) / today's open, as a percentage. */
  intradayRangePct: number;
}

export interface MarketRegimeInputs {
  historicalCloses: HistoricalClose[];
  currentSpot: number;
  /** Real India VIX last price (NSE:INDIA VIX), when the caller fetched one this session. Optional — excluded, not fabricated, when absent. */
  indiaVix?: number | null;
  /** From the SAME live index quote already fetched for spot (Kite's own `ohlc` field) — no extra call needed. Optional — excluded when absent (e.g. an EOD/backtest replay with no live quote). */
  gapAndRange?: GapAndRange | null;
}

export interface MarketRegimeResult {
  regime: MarketRegimeLabel;
  reason: string;
  trend: TrendAssessment | null;
  higherTimeframeTrend: TrendAssessment | null;
  volatility: VolatilityRegimeAssessment | null;
  whipsaw: WhipsawAssessment | null;
  indiaVix: number | null;
  gapAndRange: GapAndRange | null;
  /** Real signals this engine has no data source for — explicitly UNAVAILABLE, never fabricated. */
  unavailable: string[];
}

const WHIPSAW_UNSTABLE_THRESHOLD = 0.65;

/**
 * Combines trend, volatility regime and whipsaw into ONE composite label —
 * a stated, arguable priority rule, not a validated model (same posture
 * as everywhere else in this codebase): a volatility regime that's
 * genuinely extreme (or a whipsaw pattern) says more about what's safe to
 * do right now than the trend direction does, so those take priority;
 * otherwise the composite IS the trend read.
 */
export function classifyMarketRegime(inputs: MarketRegimeInputs): MarketRegimeResult {
  const unavailable = ['market breadth (no constituent-level advance/decline data source)', 'VWAP-relative-to-price (no intraday tick series captured)'];

  const trend = computeTrend(inputs.historicalCloses, inputs.currentSpot);
  const higherTimeframeTrend = computeHigherTimeframeTrend(inputs.historicalCloses, inputs.currentSpot);
  const volatility = computeVolatilityRegime(inputs.historicalCloses);
  const whipsaw = computeWhipsaw(inputs.historicalCloses);
  const indiaVix = inputs.indiaVix ?? null;
  const gapAndRange = inputs.gapAndRange ?? null;

  if (!trend || !volatility) {
    return {
      regime: 'NO_TRADE', reason: 'Not enough real historical closes to form a genuine trend/volatility-regime read — a data gap, not a market view.',
      trend, higherTimeframeTrend, volatility, whipsaw, indiaVix, gapAndRange, unavailable,
    };
  }

  if (whipsaw && whipsaw.signFlipRatio >= WHIPSAW_UNSTABLE_THRESHOLD) {
    return {
      regime: 'UNSTABLE',
      reason: `Direction flipped on ${(whipsaw.signFlipRatio * 100).toFixed(0)}% of the last ${whipsaw.windowDays} sessions — genuinely choppy, not a readable trend.`,
      trend, higherTimeframeTrend, volatility, whipsaw, indiaVix, gapAndRange, unavailable,
    };
  }
  if (volatility.label === 'HIGH_VOLATILITY') {
    return {
      regime: 'HIGH_VOLATILITY',
      reason: `20-day realized vol is at the ${volatility.percentile.toFixed(0)}th percentile of its own trailing range — an elevated-volatility regime dominates the trend read for risk purposes.`,
      trend, higherTimeframeTrend, volatility, whipsaw, indiaVix, gapAndRange, unavailable,
    };
  }
  if (volatility.label === 'LOW_VOLATILITY' && trend.state === 'NEUTRAL') {
    return {
      regime: 'LOW_VOLATILITY',
      reason: `20-day realized vol is at the ${volatility.percentile.toFixed(0)}th percentile of its own trailing range with no directional trend — a genuinely calm, range-bound regime.`,
      trend, higherTimeframeTrend, volatility, whipsaw, indiaVix, gapAndRange, unavailable,
    };
  }

  const reasonByState: Record<TrendState, string> = {
    STRONG_BULLISH: `Spot is ${trend.spotVsEmaSlowPct.toFixed(1)}% above its 50-session EMA with the 20-session EMA above it — a strong uptrend structure.`,
    BULLISH: `Spot is above its 50-session EMA (${trend.spotVsEmaSlowPct.toFixed(1)}%) with the 20-session EMA above it — a mild uptrend.`,
    NEUTRAL: `Spot is within a normal band of its 50-session EMA (${trend.spotVsEmaSlowPct.toFixed(1)}%) — no clear directional trend.`,
    BEARISH: `Spot is below its 50-session EMA (${trend.spotVsEmaSlowPct.toFixed(1)}%) with the 20-session EMA below it — a mild downtrend.`,
    STRONG_BEARISH: `Spot is ${Math.abs(trend.spotVsEmaSlowPct).toFixed(1)}% below its 50-session EMA with the 20-session EMA below it — a strong downtrend structure.`,
  };
  return {
    regime: trend.state, reason: reasonByState[trend.state],
    trend, higherTimeframeTrend, volatility, whipsaw, indiaVix, gapAndRange, unavailable,
  };
}
