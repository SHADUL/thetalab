import type { Regime } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Market Regime Engine (spec §7) — a weighted composite of index return,
 * VWAP/EMA position, and breadth, not any single signal alone. Weights
 * chosen so no one input can single-handedly flip the classification
 * (index return capped at +-40 of a ~100-point scale, VWAP/EMA position
 * worth a fixed nudge each, breadth capped at +-20) — a defensible
 * starting allocation, not fitted against historical outcomes (spec §59).
 */
export function classifyMarketRegime(input: {
  niftyReturnPct: number;
  niftyAboveVwap: boolean;
  niftyAbove20Ema: boolean;
  bankNiftyReturnPct: number;
  bankNiftyAboveVwap: boolean;
  pctStocksAboveVwap: number | null; // breadth, 0-100
}): { regime: Regime; score: number } {
  let score = 0;
  score += clamp(input.niftyReturnPct * 20, -40, 40);
  score += input.niftyAboveVwap ? 15 : -15;
  score += input.niftyAbove20Ema ? 10 : -10;
  score += input.bankNiftyAboveVwap ? 10 : -10;
  score += clamp(input.bankNiftyReturnPct * 10, -15, 15);
  if (input.pctStocksAboveVwap != null) score += clamp((input.pctStocksAboveVwap - 50) * 0.4, -20, 20);

  let regime: Regime;
  if (score >= 40) regime = 'STRONG_BULLISH';
  else if (score >= 15) regime = 'BULLISH';
  else if (score > -15) regime = 'NEUTRAL';
  else if (score > -40) regime = 'BEARISH';
  else regime = 'STRONG_BEARISH';

  return { regime, score: Math.round(score) };
}

/** Spec §7's own example: don't take long breakouts aggressively unless
 *  the stock shows exceptional relative strength when the market itself
 *  is unsupportive. */
export function regimeAlignmentScore(regime: Regime, direction: 'LONG' | 'SHORT'): number {
  const bullishness: Record<Regime, number> = {
    STRONG_BULLISH: 100, BULLISH: 75, NEUTRAL: 50, BEARISH: 25, STRONG_BEARISH: 0,
  };
  const score = bullishness[regime];
  return direction === 'LONG' ? score : 100 - score;
}
