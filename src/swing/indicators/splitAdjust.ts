import type { Bar } from './types.ts';

/**
 * Back-adjusts a price series for splits, bonus issues, and rights issues —
 * detected from the price discontinuity itself, since this project has no
 * corporate-actions feed to consult directly. NSE's bhavcopy gives raw,
 * unadjusted prices; a 1:1 bonus halves the traded price overnight with no
 * flag anywhere in the data saying so, and every lookback indicator that
 * spans that date (moving averages, 52w/ATH, RSI, ATR%, MACD — all of it)
 * is corrupted for as long as its window straddles the event. Confirmed
 * against real data before this was built: 70 such discontinuities across
 * 63 of 498 universe symbols in a 3-year window — common enough that
 * skipping this wasn't an option.
 *
 * The detected ratio (this day's close over the previous day's) is used
 * directly as the adjustment factor rather than trying to infer the
 * "official" clean ratio (1:1, 1:2, 3:2, ...) — it bakes in that one day's
 * real return along with the corporate action, a small and bounded
 * distortion, which is a much better trade than the 2-10x discontinuity it
 * replaces. THRESHOLD is deliberately conservative (a same-day move this
 * large essentially never happens through ordinary trading, even on a
 * circuit day) specifically to avoid the opposite mistake: mis-adjusting a
 * stock that genuinely just had a big trading day. That conservatism means
 * very mild bonus ratios (e.g. 1:4, ratio ~0.8) can slip through undetected
 * — a known, smaller residual limitation, not a silent one.
 */
const DEFAULT_THRESHOLD = 0.67;

export function adjustForSplits(bars: Bar[], threshold = DEFAULT_THRESHOLD): Bar[] {
  const n = bars.length;
  if (n === 0) return bars;

  const factor = new Array<number>(n).fill(1);
  let cumulative = 1;
  for (let i = n - 1; i >= 1; i--) {
    const ratio = bars[i - 1].c === 0 ? 1 : bars[i].c / bars[i - 1].c;
    if (ratio < threshold || ratio > 1 / threshold) cumulative *= ratio;
    factor[i - 1] = cumulative;
  }

  return bars.map((b, i) => {
    const f = factor[i];
    if (f === 1) return b;
    return {
      t: b.t, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f,
      // Volume moves the opposite way: more shares exist after a split, so
      // pre-split volume (in the old, smaller share count) is scaled UP to
      // stay comparable to post-split volume — otherwise vol_ratio would
      // show a fake jump right at the split date.
      v: b.v / f,
    };
  });
}
