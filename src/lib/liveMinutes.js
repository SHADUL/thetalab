/**
 * Turns one index candle series plus a handful of per-leg candle series
 * (each possibly sparser, since illiquid strikes don't trade every minute)
 * into a single aligned timeline: one timestamp list, and for every leg a
 * same-length price array, forward-filled from its last trade so a quiet
 * minute still resolves to the last known premium rather than a gap.
 *
 * @param {Array<{t: string, c: number}>} indexCandles
 * @param {Array<[string, Array<{t: string, c: number}>]>} legCandleEntries  [key, candles][]
 * @returns {{ timestamps: string[], spot: number[], legs: Record<string, Array<number|null>> }}
 */
export function buildMinuteSeries(indexCandles, legCandleEntries) {
  const timestamps = indexCandles.map((c) => c.t);
  const spot = indexCandles.map((c) => c.c);
  const legs = {};
  for (const [key, candles] of legCandleEntries) {
    const byTime = new Map((candles ?? []).map((c) => [c.t, c.c]));
    let last = null;
    legs[key] = timestamps.map((t) => {
      if (byTime.has(t)) last = byTime.get(t);
      return last;
    });
  }
  return { timestamps, spot, legs };
}
