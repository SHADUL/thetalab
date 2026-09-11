/**
 * EMA/SMA — the base every other trend indicator here is built from.
 *
 * EMA is seeded with a plain SMA of the first `period` values (the standard
 * convention) rather than starting from the first close, which would bias
 * early values toward that one observation.
 */

export function sma(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error('period must be positive');
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error('period must be positive');
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Percent-above/below reading used all over the scanner — null-safe. */
export function pctAbove(price: number, level: number | null): number | null {
  if (level == null || level === 0) return null;
  return ((price - level) / level) * 100;
}
