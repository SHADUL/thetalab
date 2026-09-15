import type { IntradayBar, VwapRelationship } from './types.ts';

/**
 * Session VWAP — cumulative typical-price*volume / cumulative volume,
 * reset at the start of each bar array (caller passes only today's bars).
 * Point-in-time by construction: index i only reads bars[0..i].
 */
export function computeSessionVWAP(bars: IntradayBar[]): number[] {
  let cumPV = 0, cumV = 0;
  return bars.map((b) => {
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * b.v;
    cumV += b.v;
    return cumV > 0 ? cumPV / cumV : b.c;
  });
}

const AT_VWAP_TOLERANCE_PCT = 0.05; // within this %, "at VWAP" rather than meaningfully above/below

/**
 * Classifies price vs VWAP AND whether VWAP itself is trending — spec
 * §12 wants both ("price > VWAP and ideally VWAP rising"), not price
 * position alone.
 */
export function classifyVwapRelationship(price: number, vwapSeries: number[], lookback = 5): VwapRelationship {
  if (vwapSeries.length === 0) return 'AT_VWAP';
  const vwap = vwapSeries[vwapSeries.length - 1];
  const priorIdx = Math.max(0, vwapSeries.length - 1 - lookback);
  const priorVwap = vwapSeries[priorIdx];
  const rising = vwap > priorVwap;
  const distPct = vwap !== 0 ? ((price - vwap) / vwap) * 100 : 0;

  if (Math.abs(distPct) < AT_VWAP_TOLERANCE_PCT) return 'AT_VWAP';
  if (price > vwap) return rising ? 'ABOVE_RISING' : 'ABOVE_FALLING';
  return rising ? 'BELOW_RISING' : 'BELOW_FALLING';
}
