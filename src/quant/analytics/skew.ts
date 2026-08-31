/**
 * Volatility skew off the current session's own chain — no history needed,
 * unlike IV rank. Uses the standard 25-delta risk reversal convention
 * (25-delta put IV minus 25-delta call IV) rather than a fixed strike
 * distance, so it means the same thing across strike grids and vol regimes.
 *
 * NIFTY/SENSEX index options are almost always put-skewed (crash protection
 * bid), so a positive putSkew is the normal state, not a signal by itself —
 * what matters is how it compares to its own recent range, which needs the
 * same historical store IV rank uses and isn't attempted here.
 */
import { isUsable } from '../types.ts';
import type { EnrichedSlice, EnrichedQuote } from '../types.ts';

export interface SkewResult {
  atmIv: number;
  putIv: number;
  callIv: number;
  putStrike: number;
  callStrike: number;
  /** 25-delta put IV minus ATM IV. Positive = puts richer than ATM (typical). */
  putSkew: number;
  /** 25-delta call IV minus ATM IV. Positive = calls richer than ATM (unusual for an index). */
  callSkew: number;
  /** callIv - putIv. Negative = put-skewed (typical for an index), positive = call-skewed. */
  riskReversal: number;
}

function closestByAbsDelta(qs: EnrichedQuote[], target: number): EnrichedQuote | null {
  if (qs.length === 0) return null;
  return qs.reduce((best, q) =>
    Math.abs(Math.abs(q.greeks.delta ?? 0) - target) < Math.abs(Math.abs(best.greeks.delta ?? 0) - target)
      ? q
      : best,
  );
}

export function computeSkew(slice: EnrichedSlice, atmIv: number | null, targetDelta = 0.25): SkewResult | null {
  if (atmIv === null || !(atmIv > 0)) return null;

  const usable = slice.quotes.filter(isUsable);
  const puts = usable.filter((q) => q.quote.right === 'PE' && q.quote.strike < slice.forward && q.greeks.delta !== null && q.iv !== null);
  const calls = usable.filter((q) => q.quote.right === 'CE' && q.quote.strike > slice.forward && q.greeks.delta !== null && q.iv !== null);

  const put = closestByAbsDelta(puts, targetDelta);
  const call = closestByAbsDelta(calls, targetDelta);
  if (!put || !call || put.iv === null || call.iv === null) return null;

  return {
    atmIv,
    putIv: put.iv,
    callIv: call.iv,
    putStrike: put.quote.strike,
    callStrike: call.quote.strike,
    putSkew: put.iv - atmIv,
    callSkew: call.iv - atmIv,
    riskReversal: call.iv - put.iv,
  };
}
