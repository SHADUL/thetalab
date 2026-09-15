import type { IntradayBar, Direction } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const EMA_FAST = 20;
const EMA_SLOW = 200;
const PULLBACK_LOOKBACK = 15; // bars scanned (before the current one) for a genuine touch of the 200-EMA
const PULLBACK_TOLERANCE_PCT = 0.15; // how close price must get to the 200-EMA to count as a real pullback

export interface Ema200PullbackResult {
  fired: boolean;
  direction: Direction | null;
  quality: number; // 0-100
  ema20: number | null;
  ema200: number | null;
  detail: string;
}

/**
 * 200/20 EMA Trend Pullback — a third, independent Intraday strategy (a
 * trend-following pullback, distinct from both the 5-setup ensemble and
 * the Liquidity Grab reversal). Rules as given, stated precisely since
 * the original phrasing was compressed:
 *
 *   1. Directional bias comes from price vs the 200-EMA alone — price
 *      above it means LONG bias, below means SHORT — independent of the
 *      ensemble's own return-sign-based direction (same reasoning as
 *      Liquidity Grab: this strategy decides its own direction).
 *   2. Trend confirmation: the 20-EMA must be on the same side of the
 *      200-EMA as price (20-EMA > 200-EMA for LONG, 20-EMA < 200-EMA for
 *      SHORT) — the "execution" condition, confirming this is an
 *      established trend, not price merely poking across the 200-EMA
 *      once.
 *   3. Entry trigger: price must have PULLED BACK to (within
 *      PULLBACK_TOLERANCE_PCT of, or through) the 200-EMA within the
 *      last PULLBACK_LOOKBACK bars, and then resumed — closing back on
 *      the trend side of the 20-EMA. This is the "plan a LONG only
 *      after a pullback from the 200-EMA, price above the 20-EMA"
 *      requirement — a bare EMA stack without a real pullback+resume
 *      does not fire, matching this project's existing EMA Trend
 *      Continuation setup's own "EMA is context, not the signal" stance.
 *
 * The 200-EMA needs real warm-up (a naive 200-bar minimum is the bare
 * theoretical floor; this function requires meaningfully more so the
 * EMA has actually converged, not just been seeded) — on intraday bars
 * that means several trading DAYS of history, not just today's bars.
 * The caller is expected to supply that multi-day series; this module
 * has no opinion on how it was fetched.
 */
export function detectEma200Pullback(bars: IntradayBar[]): Ema200PullbackResult {
  const n = bars.length;
  const MIN_BARS = EMA_SLOW + PULLBACK_LOOKBACK + 50; // extra buffer so the 200-EMA has actually converged
  if (n < MIN_BARS) {
    return { fired: false, direction: null, quality: 0, ema20: null, ema200: null, detail: `Not enough bars for a converged 200-EMA yet (need ${MIN_BARS}, have ${n}).` };
  }

  const closes = bars.map((b) => b.c);
  const ema20Series = ema(closes, EMA_FAST);
  const ema200Series = ema(closes, EMA_SLOW);
  const i = n - 1;
  const e20 = ema20Series[i];
  const e200 = ema200Series[i];
  if (e20 == null || e200 == null) {
    return { fired: false, direction: null, quality: 0, ema20: e20, ema200: e200, detail: 'Not enough bars for a 200-EMA yet.' };
  }

  const last = bars[i];
  const direction: Direction = last.c > e200 ? 'LONG' : 'SHORT';

  const trendConfirmed = direction === 'LONG' ? e20 > e200 : e20 < e200;
  if (!trendConfirmed) {
    return { fired: false, direction, quality: 0, ema20: e20, ema200: e200, detail: `20-EMA is not ${direction === 'LONG' ? 'above' : 'below'} the 200-EMA — trend not confirmed.` };
  }

  const recentBars = bars.slice(-PULLBACK_LOOKBACK - 1, -1);
  const recentEma200 = ema200Series.slice(-PULLBACK_LOOKBACK - 1, -1);
  const pulledToEma200 = recentBars.some((b, idx) => {
    const level = recentEma200[idx];
    if (level == null) return false;
    const proximityPct = direction === 'LONG' ? ((b.l - level) / level) * 100 : ((level - b.h) / level) * 100;
    return proximityPct <= PULLBACK_TOLERANCE_PCT;
  });
  if (!pulledToEma200) {
    return { fired: false, direction, quality: 0, ema20: e20, ema200: e200, detail: 'No recent pullback to the 200-EMA yet.' };
  }

  const resumed = direction === 'LONG' ? last.c > e20 : last.c < e20;
  if (!resumed) {
    return { fired: false, direction, quality: 0, ema20: e20, ema200: e200, detail: `Pulled back to the 200-EMA but hasn't resumed back ${direction === 'LONG' ? 'above' : 'below'} the 20-EMA yet.` };
  }

  const distFromEma200Pct = Math.abs((last.c - e200) / e200) * 100;
  const distFromEma20Pct = Math.abs((last.c - e20) / e20) * 100;
  const quality = Math.round(clamp(55 + Math.min(distFromEma200Pct, 3) * 8 + clamp(3 - distFromEma20Pct, 0, 3) * 5, 0, 100));
  return {
    fired: true, direction, quality, ema20: e20, ema200: e200,
    detail: `Trend confirmed (20-EMA ${direction === 'LONG' ? 'above' : 'below'} 200-EMA), pulled back to the 200-EMA, resumed ${direction === 'LONG' ? 'above' : 'below'} the 20-EMA.`,
  };
}

/** Local EMA so this module has no import-order dependency on indicators.ts. */
function ema(values: number[], period: number): (number | null)[] {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let idx = period; idx < values.length; idx++) { prev = values[idx] * k + prev * (1 - k); out[idx] = prev; }
  return out;
}

const STOP_BUFFER_ATR_MULT = 0.25;

/** Stop anchored to the pullback's own extreme (the low/high reached
 *  while testing the 200-EMA) — if that gets taken out, the pullback
 *  failed, not just paused. */
export function ema200PullbackStop(bars: IntradayBar[], direction: Direction, atr14: number | null, lookback = PULLBACK_LOOKBACK): number {
  const recent = bars.slice(-lookback - 1, -1);
  const buffer = (atr14 ?? 0) * STOP_BUFFER_ATR_MULT;
  return direction === 'LONG'
    ? Math.min(...recent.map((b) => b.l)) - buffer
    : Math.max(...recent.map((b) => b.h)) + buffer;
}
