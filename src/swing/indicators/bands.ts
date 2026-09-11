/** Bollinger Bands — population standard deviation over the same window
 *  the middle band's SMA uses, so the three lines are always internally
 *  consistent (upper ≥ middle ≥ lower by construction). */
import { sma } from './movingAverages.ts';

export interface BollingerPoint {
  middle: number;
  upper: number;
  lower: number;
  bandwidthPct: number;
}

export function bollinger(closes: number[], period = 20, stdDevMult = 2): (BollingerPoint | null)[] {
  if (period <= 0) throw new Error('period must be positive');
  const mid = sma(closes, period);
  return closes.map((_, i) => {
    const mean = mid[i];
    if (mean == null) return null;
    const window = closes.slice(i - period + 1, i + 1);
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = mean + stdDevMult * sd;
    const lower = mean - stdDevMult * sd;
    return { middle: mean, upper, lower, bandwidthPct: mean === 0 ? 0 : ((upper - lower) / mean) * 100 };
  });
}
