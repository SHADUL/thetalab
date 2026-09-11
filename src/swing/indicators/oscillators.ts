/**
 * RSI and MACD — Wilder's original smoothing for RSI (an exponential
 * average with alpha = 1/period, not a plain moving average of gains and
 * losses), which is what every mainstream charting platform actually
 * computes when it says "RSI(14)."
 */
import { ema } from './movingAverages.ts';

export function rsi(closes: number[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error('period must be positive');
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MACDPoint {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): (MACDPoint | null)[] {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line: (number | null)[] = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i]! - emaSlow[i]! : null);

  const out: (MACDPoint | null)[] = new Array(closes.length).fill(null);
  const firstValid = line.findIndex((v) => v != null);
  if (firstValid === -1) return out;

  const macdValues = line.slice(firstValid).map((v) => v as number);
  const signalValues = ema(macdValues, signalPeriod);
  for (let i = 0; i < macdValues.length; i++) {
    if (signalValues[i] == null) continue;
    out[firstValid + i] = {
      macd: macdValues[i], signal: signalValues[i]!, histogram: macdValues[i] - signalValues[i]!,
    };
  }
  return out;
}
