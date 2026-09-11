/**
 * ATR and ADX — both built on Wilder's true range and both use Wilder's
 * running smoothing (alpha = 1/period), not a plain moving average. ADX in
 * particular is the thing that tells "price is moving" apart from "price is
 * actually trending" (spec §11) — a whipsaw range can post real ATR with
 * ADX sitting under 15 the whole time.
 */
import type { Bar } from './types.ts';

export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const prevClose = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
  });
}

export function atr(bars: Bar[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error('period must be positive');
  const tr = trueRange(bars);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** ATR as a percentage of price — the "can this realistically move +10%
 *  quickly" input (spec §13). Null wherever ATR itself is undefined or
 *  price is non-positive. */
export function atrPct(bars: Bar[], period = 14): (number | null)[] {
  const a = atr(bars, period);
  return bars.map((b, i) => (a[i] == null || b.c <= 0 ? null : (a[i]! / b.c) * 100));
}

export interface ADXPoint {
  plusDI: number;
  minusDI: number;
  adx: number;
}

/** Wilder's ADX. Needs roughly 2×period bars of run-up before the first
 *  value (one period to seed the smoothed +DM/-DM/TR, another to smooth DX
 *  itself into ADX) — shorter series come back entirely null rather than a
 *  noisy early estimate. */
export function adx(bars: Bar[], period = 14): (ADXPoint | null)[] {
  if (period <= 0) throw new Error('period must be positive');
  const n = bars.length;
  const out: (ADXPoint | null)[] = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;

  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const prevClose = bars[i - 1].c;
    tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevClose), Math.abs(bars[i].l - prevClose));
  }

  const smoothPlusDM = new Array<number>(n).fill(0);
  const smoothMinusDM = new Array<number>(n).fill(0);
  const smoothTR = new Array<number>(n).fill(0);
  let sp = 0, sm = 0, st = 0;
  for (let i = 1; i <= period; i++) { sp += plusDM[i]; sm += minusDM[i]; st += tr[i]; }
  smoothPlusDM[period] = sp; smoothMinusDM[period] = sm; smoothTR[period] = st;
  for (let i = period + 1; i < n; i++) {
    smoothPlusDM[i] = smoothPlusDM[i - 1] - smoothPlusDM[i - 1] / period + plusDM[i];
    smoothMinusDM[i] = smoothMinusDM[i - 1] - smoothMinusDM[i - 1] / period + minusDM[i];
    smoothTR[i] = smoothTR[i - 1] - smoothTR[i - 1] / period + tr[i];
  }

  const plusDI = new Array<number>(n).fill(0);
  const minusDI = new Array<number>(n).fill(0);
  const dx = new Array<number>(n).fill(0);
  for (let i = period; i < n; i++) {
    plusDI[i] = smoothTR[i] === 0 ? 0 : (100 * smoothPlusDM[i]) / smoothTR[i];
    minusDI[i] = smoothTR[i] === 0 ? 0 : (100 * smoothMinusDM[i]) / smoothTR[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  }

  const adxStart = period * 2;
  let sumDx = 0;
  for (let i = period; i < adxStart; i++) sumDx += dx[i];
  let adxVal = sumDx / period;
  out[adxStart - 1] = { plusDI: plusDI[adxStart - 1], minusDI: minusDI[adxStart - 1], adx: adxVal };
  for (let i = adxStart; i < n; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    out[i] = { plusDI: plusDI[i], minusDI: minusDI[i], adx: adxVal };
  }
  return out;
}

export type TrendStrength = 'weak' | 'developing' | 'moderate' | 'strong' | 'very-strong';

/** Spec §11's bands, verbatim. */
export function classifyADX(value: number | null): TrendStrength | null {
  if (value == null) return null;
  if (value < 15) return 'weak';
  if (value < 20) return 'developing';
  if (value < 25) return 'moderate';
  if (value < 35) return 'strong';
  return 'very-strong';
}
