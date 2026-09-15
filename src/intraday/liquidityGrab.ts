import type { IntradayBar, Direction } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const LEVEL_LOOKBACK = 20; // bars used to define the recent swing level, formed BEFORE the sweep
const SWEEP_MIN_PCT = 0.05; // minimum wick penetration beyond the level, as % of price — filters noise
const VOL_LOOKBACK = 10; // trailing bars used for the sweep bar's own volume-expansion check

export interface LiquidityGrabResult {
  fired: boolean;
  direction: Direction | null;
  quality: number; // 0-100
  sweptLevel: number | null;
  wickExtreme: number | null; // the sweep bar's own high (SHORT) or low (LONG) — the stop-placement anchor
  detail: string;
}

/**
 * Liquidity Grab / stop-run reversal (a genuinely separate strategy from
 * the 5 continuation/breakout setups — this is a FADE, not a momentum
 * or breakout-continuation play). A classic 2-bar pattern:
 *
 *   1. A "sweep" bar spikes beyond a recent swing high/low (formed by
 *      the `lookback` bars BEFORE it, so the level pre-dates the sweep
 *      rather than being an artifact of it) — this is where resting
 *      stop-loss/breakout orders get triggered, i.e. where the
 *      liquidity actually sits.
 *   2. A "confirm" bar (the very next one) rejects back through the
 *      level and closes counter to the sweep direction — the breakout
 *      failed, trapping whoever bought the high / sold the low.
 *
 * Direction is DERIVED from the sweep, not supplied by the caller — a
 * sweep-above-and-reject is bearish (SHORT), a sweep-below-and-reject
 * is bullish (LONG) — unlike the other 5 detectors, which test a
 * caller-given direction against price action. This is why liquidity
 * grab signals are evaluated as their own independent pathway rather
 * than folded into the return-sign-based direction the main ensemble
 * assigns each candidate (a stock already up on the day can still form
 * a bearish liquidity grab at a local high, and vice versa).
 *
 * Quality rewards how completely the sweep excursion got reversed (a
 * V-shaped snap-back scores higher than a bar that merely closed back
 * over the line) and volume expansion on the sweep bar itself vs its
 * own recent history (confirming a genuine stop-run, not just noise) —
 * deliberately NOT gated on level "freshness" (how many times the level
 * has already been tested) in this v1; a known, stated simplification.
 */
export function detectLiquidityGrab(bars: IntradayBar[], lookback = LEVEL_LOOKBACK): LiquidityGrabResult {
  const n = bars.length;
  if (n < lookback + 2) {
    return { fired: false, direction: null, quality: 0, sweptLevel: null, wickExtreme: null, detail: 'Not enough bars yet.' };
  }

  const levelBars = bars.slice(n - lookback - 2, n - 2);
  const swingHigh = Math.max(...levelBars.map((b) => b.h));
  const swingLow = Math.min(...levelBars.map((b) => b.l));
  const sweepBar = bars[n - 2];
  const confirmBar = bars[n - 1];
  const volBars = levelBars.slice(-VOL_LOOKBACK);
  const avgVol = volBars.length ? volBars.reduce((s, b) => s + b.v, 0) / volBars.length : 0;
  const volExpansion = avgVol > 0 ? sweepBar.v / avgVol : 1;

  const sweptAbove = ((sweepBar.h - swingHigh) / swingHigh) * 100 >= SWEEP_MIN_PCT;
  if (sweptAbove && confirmBar.c < swingHigh && confirmBar.c < confirmBar.o) {
    const excursion = sweepBar.h - swingHigh;
    const reversal = sweepBar.h - confirmBar.c;
    const rejectionRatio = excursion > 0 ? reversal / excursion : 0;
    const quality = Math.round(clamp(40 + Math.min(rejectionRatio, 2) * 20 + Math.min(volExpansion, 3) * 7, 0, 100));
    return {
      fired: true, direction: 'SHORT', quality, sweptLevel: swingHigh, wickExtreme: sweepBar.h,
      detail: `Swept above ${swingHigh.toFixed(2)} (high ${sweepBar.h.toFixed(2)}) then rejected, closing at ${confirmBar.c.toFixed(2)}.`,
    };
  }

  const sweptBelow = ((swingLow - sweepBar.l) / swingLow) * 100 >= SWEEP_MIN_PCT;
  if (sweptBelow && confirmBar.c > swingLow && confirmBar.c > confirmBar.o) {
    const excursion = swingLow - sweepBar.l;
    const reversal = confirmBar.c - sweepBar.l;
    const rejectionRatio = excursion > 0 ? reversal / excursion : 0;
    const quality = Math.round(clamp(40 + Math.min(rejectionRatio, 2) * 20 + Math.min(volExpansion, 3) * 7, 0, 100));
    return {
      fired: true, direction: 'LONG', quality, sweptLevel: swingLow, wickExtreme: sweepBar.l,
      detail: `Swept below ${swingLow.toFixed(2)} (low ${sweepBar.l.toFixed(2)}) then rejected, closing at ${confirmBar.c.toFixed(2)}.`,
    };
  }

  return { fired: false, direction: null, quality: 0, sweptLevel: null, wickExtreme: null, detail: 'No sweep-and-reject structure at the recent swing level.' };
}

const STOP_BUFFER_PCT = 0.0005; // 0.05% beyond the wick — a tight, deliberately small stop is the whole thesis

/** Stop sits just beyond the sweep bar's own extreme — if price takes
 *  that level out again, the "grab" thesis is simply wrong. */
export function liquidityGrabStop(direction: Direction, wickExtreme: number): number {
  return direction === 'SHORT' ? wickExtreme * (1 + STOP_BUFFER_PCT) : wickExtreme * (1 - STOP_BUFFER_PCT);
}
