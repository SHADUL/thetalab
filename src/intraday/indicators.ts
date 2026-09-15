import type { IntradayBar } from './types.ts';

/**
 * Small, self-contained indicator math for intraday bars — deliberately
 * NOT importing from src/swing/indicators even though the formulas
 * overlap (EMA is EMA): the spec asks to keep engines independent, and
 * swing's Bar.t is a date string while intraday's is an epoch-ms
 * timestamp, so sharing would mean bridging two incompatible bar shapes
 * for a few lines of math that are cheap to keep separate.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function trueRange(bars: IntradayBar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const prevClose = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
  });
}

/** Wilder's smoothing, same convention as the Swing Scanner's ATR. */
export function atr(bars: IntradayBar[], period: number): (number | null)[] {
  const tr = trueRange(bars);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Minutes since midnight IST for an epoch-ms timestamp. */
export function istMinutesOfDay(epochMs: number): number {
  const ist = new Date(new Date(epochMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
