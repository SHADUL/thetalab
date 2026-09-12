/**
 * Risk Engine (spec §53's "Risk Engine" stage, spec §20's trade plan).
 * Picks a stop by the method spec §20 says fits the setup that's actually
 * present — below a fresh breakout level, below the EMA a pullback is
 * holding, or an ATR multiple when neither structural anchor exists —
 * rather than one flat percentage for every stock regardless of its own
 * volatility or setup.
 */
import type { PatternResult } from '../patterns/types.ts';
import type { TradePlan } from './types.ts';

const PRIMARY_TARGET_PCT = 0.10; // spec §20's primary target
const ATR_STOP_MULTIPLE = 2; // used only when no structural level applies
const BREAKOUT_STOP_BUFFER = 0.02; // stop sits just under the broken level, which should now act as support
const PULLBACK_STOP_ATR_BUFFER = 0.5;

export function computeTradePlan(input: {
  price: number; atr: number | null; ema20: number | null; ema50: number | null; pattern: PatternResult;
}): TradePlan {
  const { price, atr, ema20, ema50, pattern } = input;
  const entry = price;

  let stop: number | null = null;
  const freshBreakoutLevel = pattern.breakouts.find((b) => b.brokeOut)?.level ?? null;

  if (pattern.entryStatus === 'BREAKOUT_CONFIRMED' && freshBreakoutLevel != null) {
    stop = freshBreakoutLevel * (1 - BREAKOUT_STOP_BUFFER);
  } else if (pattern.pullback.toEma20 && ema20 != null) {
    stop = ema20 - (atr ?? 0) * PULLBACK_STOP_ATR_BUFFER;
  } else if (pattern.pullback.toEma50 && ema50 != null) {
    stop = ema50 - (atr ?? 0) * PULLBACK_STOP_ATR_BUFFER;
  } else if (atr != null && atr > 0) {
    stop = entry - atr * ATR_STOP_MULTIPLE;
  }
  // No structural anchor and no ATR at all: leave stop null rather than
  // inventing a flat percentage — an R:R computed from a made-up stop is
  // worse than admitting the plan can't be sized yet (spec §55: don't
  // display a misleading number when the underlying data is missing).

  const target = entry * (1 + PRIMARY_TARGET_PCT);
  let riskReward: number | null = null;
  if (stop != null && stop < entry) {
    const risk = entry - stop, reward = target - entry;
    riskReward = risk > 0 ? reward / risk : null;
  }

  return { entry, stop, target, riskReward };
}

/** Spec §20: "Reject or heavily penalize trades with poor risk/reward." */
export function riskRewardScore(rr: number | null): number {
  if (rr == null) return 30;
  if (rr < 1) return 20;
  if (rr < 1.5) return 50;
  if (rr < 2.5) return 80;
  return 95;
}
