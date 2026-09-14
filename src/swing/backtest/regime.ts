import { sma } from '../indicators/movingAverages.ts';
import type { Regime } from './types.ts';

/**
 * A simple, standard trend-following regime label off NIFTY's own close
 * vs its own SMA50/SMA200 — not a claim about "the market," just a
 * defensible, reproducible slice for the backtest's regime-aware
 * breakdown. SMA at index i only reads closes[0..i], so this is
 * point-in-time correct by construction — no separate care needed.
 */
export function classifyRegimeSeries(dates: string[], closes: number[]): Map<string, Regime> {
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const out = new Map<string, Regime>();
  for (let i = 0; i < dates.length; i++) {
    const c = closes[i], s50 = sma50[i], s200 = sma200[i];
    if (c == null || s50 == null || s200 == null) continue;
    let regime: Regime;
    if (c > s50 && s50 > s200) regime = 'BULLISH';
    else if (c < s50 && s50 < s200) regime = 'BEARISH';
    else regime = 'NEUTRAL';
    out.set(dates[i], regime);
  }
  return out;
}
