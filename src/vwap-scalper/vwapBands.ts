/**
 * Session VWAP + volume-weighted standard-deviation bands — the exact
 * formula from the Pine source (Section 1 of the reference doc), NOT a
 * Bollinger Band (SMA + stdev of price):
 *
 *   cumPV  = Σ(price · volume)
 *   cumPV2 = Σ(price² · volume)
 *   cumVol = Σ(volume)
 *   VWAP     = cumPV / cumVol
 *   variance = cumPV2 / cumVol − VWAP²        (volume-weighted variance)
 *   stdev    = √variance
 *   Band(n)  = VWAP ± n × stdevMultiplier × stdev,  for n = 1, 2, 3
 *
 * Point-in-time by construction: index i only ever reads bars[0..i],
 * matching the Pine script's own non-repainting cumulative-sum design
 * (Section 14's "Not a Bollinger Band" note, and the indicator source's
 * own header comment on VWAP/bands never using future bars).
 */
import type { Bar, VwapBandsPoint, VwapSource } from './types.ts';

export const hlc3: VwapSource = (b) => (b.h + b.l + b.c) / 3;

export function computeVwapBands(bars: Bar[], stdevMultiplier = 1.0, source: VwapSource = hlc3): VwapBandsPoint[] {
  let cumPV = 0, cumPV2 = 0, cumVol = 0;
  return bars.map((bar) => {
    const price = source(bar);
    cumPV += price * bar.v;
    cumPV2 += price * price * bar.v;
    cumVol += bar.v;

    const vwap = cumVol > 0 ? cumPV / cumVol : price;
    const variance = cumVol > 0 ? Math.max(cumPV2 / cumVol - vwap * vwap, 0) : 0;
    const stdev = Math.sqrt(variance);
    const unit = stdev * stdevMultiplier;

    return {
      vwap, stdev,
      upper1: vwap + unit, upper2: vwap + unit * 2, upper3: vwap + unit * 3,
      lower1: vwap - unit, lower2: vwap - unit * 2, lower3: vwap - unit * 3,
    };
  });
}
