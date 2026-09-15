function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Intraday Relative Strength (spec §10) — a weighted blend across
 * multiple lookback windows, longer windows weighted more (less noisy),
 * matching the same "blend across horizons" philosophy as the Swing
 * Scanner's own relativeStrengthScore. RS values (percentage-point
 * outperformance vs NIFTY) are clamped before scaling so one noisy
 * 1-minute reading can't dominate.
 */
export function intradayRelativeStrengthScore(windows: Array<{ stockReturnPct: number; niftyReturnPct: number; weight: number }>): number {
  let sum = 0, weightUsed = 0;
  for (const w of windows) {
    const rs = clamp(w.stockReturnPct - w.niftyReturnPct, -10, 10);
    sum += rs * w.weight;
    weightUsed += w.weight;
  }
  if (weightUsed === 0) return 50;
  const avgRs = sum / weightUsed;
  return clamp(Math.round(50 + avgRs * 5), 0, 100);
}

/** Default window weights spec §10 asks for (1m/5m/15m/30m/1h/session),
 *  longer windows weighted more. */
export const DEFAULT_RS_WINDOW_WEIGHTS = {
  min1: 0.05, min5: 0.15, min15: 0.20, min30: 0.20, hour1: 0.20, session: 0.20,
} as const;
