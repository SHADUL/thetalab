import type { IntradayBar, OpeningRange, SetupSignal, Direction } from './types.ts';
import { istMinutesOfDay } from './indicators.ts';

const OR_START_MIN = 9 * 60 + 15;
const OR_END_MIN = 9 * 60 + 30;

/** Opening Range (spec §3/§13) — high/low/width over the 09:15-09:30 window. */
export function computeOpeningRange(bars: IntradayBar[], startMin = OR_START_MIN, endMin = OR_END_MIN): OpeningRange | null {
  const orBars = bars.filter((b) => { const m = istMinutesOfDay(b.t); return m >= startMin && m < endMin; });
  if (orBars.length === 0) return null;
  const high = Math.max(...orBars.map((b) => b.h));
  const low = Math.min(...orBars.map((b) => b.l));
  return { high, low, width: high - low };
}

/**
 * ORB (spec §13) — requires a confirmed candle CLOSE beyond the range,
 * not a wick poke ("avoid taking a trade on a tiny wick above the
 * opening range"). Quality rewards breakout distance and how strongly
 * the breakout candle closed within its own range, not just that price
 * crossed the level.
 */
export function detectORB(bars: IntradayBar[], or: OpeningRange, direction: Direction): SetupSignal {
  const last = bars[bars.length - 1];
  if (!last) return { type: 'ORB', direction, fired: false, quality: 0, detail: 'No bar data.' };

  const breakoutLevel = direction === 'LONG' ? or.high : or.low;
  const fired = direction === 'LONG' ? last.c > breakoutLevel : last.c < breakoutLevel;
  if (!fired) {
    return { type: 'ORB', direction, fired: false, quality: 0, detail: `Has not closed beyond OR ${direction === 'LONG' ? 'high' : 'low'} (₹${breakoutLevel.toFixed(2)}) yet.` };
  }

  const breakoutDistancePct = Math.abs((last.c - breakoutLevel) / breakoutLevel) * 100;
  const range = last.h - last.l;
  const closingStrength = range === 0 ? 0.5 : direction === 'LONG' ? (last.c - last.l) / range : (last.h - last.c) / range;
  const quality = Math.round(Math.min(100, 50 + breakoutDistancePct * 20 + closingStrength * 30));
  return {
    type: 'ORB', direction, fired: true, quality,
    detail: `Closed ${breakoutDistancePct.toFixed(2)}% beyond the OR ${direction === 'LONG' ? 'high' : 'low'}, closing strength ${(closingStrength * 100).toFixed(0)}%.`,
  };
}

/**
 * VWAP Pullback (spec §16) — trend extended away from VWAP, pulled back
 * toward it (ideally on lighter volume), then resumed. A v1 structural
 * read over the last 8 bars, not a full pattern-matcher: was extended
 * early in the window, distance-from-VWAP shrank since, price hasn't
 * crossed to the wrong side of VWAP, and the latest bar resumed in the
 * trend direction.
 */
export function detectVwapPullback(bars: IntradayBar[], vwapSeries: number[], direction: Direction): SetupSignal {
  const n = bars.length;
  if (n < 8) return { type: 'VWAP_PULLBACK', direction, fired: false, quality: 0, detail: 'Not enough bars yet.' };
  const recent = bars.slice(-8);
  const recentVwap = vwapSeries.slice(-8);
  const sign = direction === 'LONG' ? 1 : -1;
  const distFromVwapPct = recent.map((b, i) => ((b.c - recentVwap[i]) / recentVwap[i]) * 100 * sign);

  const earlyPeak = Math.max(...distFromVwapPct.slice(0, 4));
  const wasExtended = earlyPeak > 0.3;
  // Pulled back MEANINGFULLY from the peak extension — not just "less than
  // bar zero," which said nothing if bar zero itself was already near VWAP.
  const pulledBack = distFromVwapPct[distFromVwapPct.length - 2] < earlyPeak * 0.6;
  const stillAligned = distFromVwapPct[distFromVwapPct.length - 1] > -0.05;
  const volDeclinedInPullback = recent[recent.length - 2].v < recent[0].v;
  const last = recent[recent.length - 1];
  const resumed = direction === 'LONG' ? last.c > last.o : last.c < last.o;

  const fired = wasExtended && pulledBack && stillAligned && resumed;
  if (!fired) return { type: 'VWAP_PULLBACK', direction, fired: false, quality: 0, detail: 'Pullback structure not yet confirmed.' };

  const bonusConditions = [volDeclinedInPullback].filter(Boolean).length;
  const quality = Math.round(70 + bonusConditions * 20);
  return {
    type: 'VWAP_PULLBACK', direction, fired: true, quality,
    detail: `Trend extended from VWAP, pulled back${volDeclinedInPullback ? ' on lighter volume' : ''}, and resumed ${direction === 'LONG' ? 'higher' : 'lower'}.`,
  };
}

const EMA_NEAR_TOLERANCE_PCT = 0.5;

/**
 * EMA Trend Continuation (spec §17) — 9/20 EMA stacked with price on the
 * trend side, PLUS a pullback-toward-the-EMA + intact higher-highs/
 * higher-lows structure. Spec is explicit: "do not trade an EMA
 * crossover alone — EMA is context, not the signal," so a bare stack
 * without the structural check does not fire here.
 */
export function detectEmaTrendContinuation(bars: IntradayBar[], ema9: (number | null)[], ema20: (number | null)[], direction: Direction): SetupSignal {
  const i = bars.length - 1;
  const e9 = ema9[i], e20 = ema20[i];
  if (e9 == null || e20 == null) return { type: 'EMA_TREND_CONTINUATION', direction, fired: false, quality: 0, detail: 'Not enough bars for EMA9/20 yet.' };

  const stacked = direction === 'LONG' ? e9 > e20 : e9 < e20;
  const priceAligned = direction === 'LONG' ? bars[i].c > e9 : bars[i].c < e9;
  if (!stacked || !priceAligned) {
    return { type: 'EMA_TREND_CONTINUATION', direction, fired: false, quality: 0, detail: 'EMA9/20 stack or price alignment not yet in place.' };
  }

  const recent = bars.slice(-5);
  let structureOk = true;
  for (let k = 1; k < recent.length; k++) {
    if (direction === 'LONG' ? recent[k].h < recent[k - 1].l : recent[k].l > recent[k - 1].h) { structureOk = false; break; }
  }
  const distFromEma9Pct = Math.abs((bars[i].c - e9) / e9) * 100;
  const nearEma = distFromEma9Pct < EMA_NEAR_TOLERANCE_PCT;
  if (!structureOk) return { type: 'EMA_TREND_CONTINUATION', direction, fired: false, quality: 0, detail: 'Trend structure broken (a lower high/higher low against the trend).' };

  const quality = Math.round(60 + (nearEma ? 30 : 0) + 10);
  return {
    type: 'EMA_TREND_CONTINUATION', direction, fired: true, quality,
    detail: `EMA9/20 stacked ${direction === 'LONG' ? 'bullishly' : 'bearishly'}, structure intact, price ${nearEma ? 'pulled back near' : 'extended from'} EMA9.`,
  };
}
