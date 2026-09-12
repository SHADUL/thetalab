/**
 * The individual 0-100 factor scores (spec §22's ranking-engine inputs).
 * Every band here mirrors the classification the Indicator/Pattern Engine
 * already documents (spec §10/§11/§12/§13) rather than inventing new
 * thresholds — the score is a restatement of an already-justified
 * technical read, not a second, independently-tuned opinion of it. Per
 * spec §56: no parameter here was fitted against historical returns.
 */
import type { PatternResult } from '../patterns/types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Trend structure (spec §9) — partial credit for each piece of a bullish
 *  stack (price above each MA, the MAs themselves stacked, EMA20 rising),
 *  deliberately not an all-or-nothing "must be perfectly stacked" test:
 *  spec explicitly calls for catching an *emerging* trend too, not just a
 *  fully mature one. */
export function trendScore(input: {
  price: number; ema20: number | null; ema50: number | null; sma200: number | null; ema20Rising: boolean | null;
}): number {
  let score = 0;
  if (input.ema20 != null && input.price > input.ema20) score += 20;
  if (input.ema50 != null && input.price > input.ema50) score += 15;
  if (input.sma200 != null && input.price > input.sma200) score += 15;
  if (input.ema20 != null && input.ema50 != null && input.ema20 > input.ema50) score += 15;
  if (input.ema50 != null && input.sma200 != null && input.ema50 > input.sma200) score += 15;
  if (input.ema20Rising) score += 20;
  return clamp(score, 0, 100);
}

/** Momentum (spec §10/§11) — RSI is the direct read, ADX confirms whether
 *  the market is actually trending or just noisy (spec §11's own framing:
 *  "distinguish 'price is moving' from 'price is actually trending'"),
 *  so RSI is weighted higher but ADX still moves the number meaningfully. */
export function momentumScore(rsi14: number | null, adx14: number | null): number {
  let rsiPart = 40; // neutral default when RSI itself is unavailable
  if (rsi14 != null) {
    if (rsi14 >= 80) rsiPart = 50; // overheated — spec §10: "potentially overheated," not automatically rewarded further
    else if (rsi14 >= 70) rsiPart = 75; // very strong, some extension risk already
    else if (rsi14 >= 60) rsiPart = 90; // spec's own "strong momentum" band — the sweet spot
    else if (rsi14 >= 50) rsiPart = 60; // emerging
    else if (rsi14 >= 40) rsiPart = 35; // weakening / neutral
    else rsiPart = 15; // bearish momentum
  }
  let adxPart = 40;
  if (adx14 != null) {
    if (adx14 >= 35) adxPart = 75; // very strong, discounted slightly — often a late-stage, extended trend
    else if (adx14 >= 25) adxPart = 90; // spec's "strong" band
    else if (adx14 >= 20) adxPart = 65; // moderate
    else if (adx14 >= 15) adxPart = 45; // developing
    else adxPart = 20; // weak/no trend — price moving without actually trending
  }
  return Math.round(rsiPart * 0.6 + adxPart * 0.4);
}

/** Relative strength (spec §14) — a weighted blend across horizons rather
 *  than any single one, longer windows weighted more since they're less
 *  noisy, but the short window still counts (spec asks for 5/20/60/120d
 *  explicitly). RS values (percentage-point differences vs NIFTY) are
 *  clamped before scaling so one extreme outlier period can't dominate. */
export function relativeStrengthScore(rs: {
  rs5d: number | null; rs20d: number | null; rs60d: number | null; rs120d: number | null;
}): number {
  const weighted: [number | null, number][] = [[rs.rs5d, 0.15], [rs.rs20d, 0.25], [rs.rs60d, 0.35], [rs.rs120d, 0.25]];
  let sum = 0, weightUsed = 0;
  for (const [value, weight] of weighted) {
    if (value == null) continue;
    sum += clamp(value, -25, 25) * weight;
    weightUsed += weight;
  }
  if (weightUsed === 0) return 50; // no data at all — neutral, not a guess in either direction
  const avgRs = sum / weightUsed; // roughly -25..+25 percentage points
  return clamp(Math.round(50 + avgRs * 2), 0, 100);
}

/** Setup/breakout quality (spec §17) — reuses the Pattern Engine's own
 *  breakoutQuality when a breakout actually fired today; otherwise scores
 *  the next-best thing spec §18 calls a real setup (a valid pullback, or a
 *  base still building) rather than defaulting to zero for "no breakout
 *  yet," which would make every pre-breakout stock look identical to one
 *  with no setup at all. */
export function setupQualityScore(pattern: PatternResult): number {
  if (pattern.breakoutQuality != null) return pattern.breakoutQuality;
  if (pattern.pullback.toEma20 || pattern.pullback.toEma50 || pattern.pullback.breakoutRetest) return 65;
  if (pattern.consolidation.inConsolidation) return 55;
  return 30;
}

/** Volume (spec §12) — the classification bands, restated as a score.
 *  Capped just under 100 even for "exceptional" volume, since huge volume
 *  alone doesn't distinguish accumulation from panic (spec's own warning:
 *  "avoid blindly rewarding huge volume because panic selling can also
 *  produce huge volume") — that distinction is what closingStrength and
 *  breakoutQuality are for, not this factor alone. */
export function volumeScore(volRatio: number | null): number {
  if (volRatio == null) return 40;
  if (volRatio < 0.7) return 20;
  if (volRatio < 1.0) return 45;
  if (volRatio < 1.5) return 65;
  if (volRatio < 2.0) return 85;
  return 95;
}

/** Volatility / target potential (spec §13) — a sweet-spot band, not
 *  monotonic: too little ATR% and +10% realistically takes too long to
 *  reach; too much and the same target carries disproportionate risk (and
 *  is prone to violent give-back). Neither extreme scores as well as the
 *  middle. */
export function volatilityScore(atrPct: number | null): number {
  if (atrPct == null) return 40;
  if (atrPct < 1.0) return 30;
  if (atrPct < 1.5) return 55;
  if (atrPct < 2.5) return 90;
  if (atrPct < 3.5) return 70;
  return 40;
}
