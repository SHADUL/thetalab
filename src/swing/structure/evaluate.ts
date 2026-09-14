import type { StructureGates, StructureFactorScores, StructureScoreResult } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const NEAR_52W_HIGH_PCT = 0.75;
const WEEKLY_RSI_CEILING = 75;
const LIQUIDITY_MIN_VOLUME = 70_000;
const PRICE_FLOOR = 20;

/**
 * Pure, point-in-time evaluation of the six gate conditions plus a 0-100
 * strength score for stocks that pass all of them. Every threshold here
 * is the user's own scan's threshold, not a fitted parameter — this
 * restates the scan's conditions, it doesn't reinterpret them.
 */
export function evaluateStructureSetup(input: {
  close: number;
  ema20: number | null;
  high52w: number | null;
  yesterdayVolume: number | null;
  weeklyRsi14: number | null;
  weeklyHigh: number | null;
  prevWeeklyHigh: number | null;
}): StructureScoreResult {
  const { close, ema20, high52w, yesterdayVolume, weeklyRsi14, weeklyHigh, prevWeeklyHigh } = input;

  const gates: StructureGates = {
    priceFloor: close > PRICE_FLOOR,
    liquidity: yesterdayVolume != null && yesterdayVolume > LIQUIDITY_MIN_VOLUME,
    near52wHigh: high52w != null && high52w > 0 && close >= high52w * NEAR_52W_HIGH_PCT,
    aboveDailyEma20: ema20 != null && close > ema20,
    weeklyRsiCeiling: weeklyRsi14 != null && weeklyRsi14 < WEEKLY_RSI_CEILING,
    weeklyHigherHigh: weeklyHigh != null && prevWeeklyHigh != null && weeklyHigh > prevWeeklyHigh,
  };
  const passesAll = Object.values(gates).every(Boolean);

  // Proximity to the 52w high: 0 right at the 75% gate, 100 at the high itself.
  const pctOf52wHigh = high52w != null && high52w > 0 ? close / high52w : null;
  const proximity = pctOf52wHigh != null
    ? Math.round(clamp(((pctOf52wHigh - NEAR_52W_HIGH_PCT) / (1 - NEAR_52W_HIGH_PCT)) * 100, 0, 100))
    : 0;

  // Trend strength: distance above the daily EMA20, scaled so +8% reads as fully strong.
  const pctAboveEma20 = ema20 != null && ema20 > 0 ? ((close - ema20) / ema20) * 100 : null;
  const trend = pctAboveEma20 != null ? Math.round(clamp(50 + (pctAboveEma20 / 8) * 50, 0, 100)) : 0;

  // Weekly momentum health — the same sweet-spot shape as the Momentum
  // Score's own RSI banding (55-65 is "strong," tapering as it nears this
  // scan's own 75 overbought ceiling rather than climbing further).
  let weeklyMomentum = 40;
  if (weeklyRsi14 != null) {
    if (weeklyRsi14 >= 75) weeklyMomentum = 20;
    else if (weeklyRsi14 >= 65) weeklyMomentum = 80;
    else if (weeklyRsi14 >= 55) weeklyMomentum = 95;
    else if (weeklyRsi14 >= 50) weeklyMomentum = 70;
    else weeklyMomentum = 40;
  }

  // Weekly breakout strength: magnitude of the new weekly high over the prior week's.
  const pctNewHigh = weeklyHigh != null && prevWeeklyHigh != null && prevWeeklyHigh > 0
    ? ((weeklyHigh - prevWeeklyHigh) / prevWeeklyHigh) * 100 : null;
  const weeklyBreakout = pctNewHigh != null ? Math.round(clamp(50 + (pctNewHigh / 5) * 50, 0, 100)) : 0;

  const factors: StructureFactorScores = { proximity, trend, weeklyMomentum, weeklyBreakout };
  const score = passesAll ? Math.round((proximity + trend + weeklyMomentum + weeklyBreakout) / 4) : null;

  return { gates, passesAll, factors, score };
}
