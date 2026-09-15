import type { IntradayBar, Direction } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Momentum Acceleration (spec §18) — velocity over the last few bars,
 * signed to the candidate's direction, not raw RSI/MACD. A stock whose
 * short-term rate of change is INCREASING should score higher than one
 * sitting at the same price level but decelerating — this compares the
 * most recent leg against the leg before it, not just the latest value.
 */
export function momentumAccelerationScore(bars: IntradayBar[], direction: Direction): number {
  const n = bars.length;
  if (n < 7) return 50;
  const recentRoc = ((bars[n - 1].c - bars[n - 4].c) / bars[n - 4].c) * 100;
  const priorRoc = ((bars[n - 4].c - bars[n - 7].c) / bars[n - 7].c) * 100;
  const signed = direction === 'LONG' ? recentRoc : -recentRoc;
  const signedPrior = direction === 'LONG' ? priorRoc : -priorRoc;
  const accelerating = signed > signedPrior;
  const base = clamp(50 + signed * 15, 0, 100);
  return Math.round(clamp(accelerating ? base + 10 : base - 10, 0, 100));
}
