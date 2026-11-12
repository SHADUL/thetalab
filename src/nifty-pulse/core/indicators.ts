/**
 * Strategy A indicators, computed from the per-second sample series.
 *
 *   R5   = (P_now / P_5s_ago  − 1) × 100
 *   R15  = (P_now / P_15s_ago − 1) × 100
 *   MA60 = mean of the latest 60 valid one-second samples (including now)
 *   last-5 changes: sign of each of the latest five 1-second differences
 *
 * Indicators are only produced when the trailing run of consecutive VALID
 * samples is long enough (61 for the baseline: 60 for MA60 + the 1 needed to
 * form the oldest change / the 15-second return comfortably fits inside).
 * A single STALE / NO_DATA second resets the run, so a feed gap can never be
 * bridged as if prices had been observed.
 */
import type { Sample } from './sampler.ts';
import type { PulseConfig } from './config.ts';

export type ChangeSign = 1 | -1 | 0;

export interface IndicatorsReady {
  ready: true;
  price: number;
  r5: number;
  r15: number;
  ma60: number;
  /** price − MA60, index points. */
  maDistance: number;
  /** Oldest → newest. */
  lastChanges: Array<{ delta: number; sign: ChangeSign }>;
  ups: number;
  downs: number;
  flats: number;
  validRun: number;
}

export interface IndicatorsWaiting {
  ready: false;
  validRun: number;
  needed: number;
  reason: string;
}

export type Indicators = IndicatorsReady | IndicatorsWaiting;

export function requiredSamples(c: Pick<PulseConfig, 'maWindowSec' | 'longReturnWindowSec' | 'confirmLookback'>): number {
  return Math.max(c.maWindowSec, c.longReturnWindowSec, c.confirmLookback) + 1;
}

/** Length of the trailing run of valid samples. */
export function trailingValidRun(samples: readonly Sample[]): number {
  let n = 0;
  for (let i = samples.length - 1; i >= 0 && samples[i].valid; i--) n++;
  return n;
}

const round = (x: number, dp: number) => { const f = 10 ** dp; return Math.round(x * f) / f; };

export function computeIndicators(samples: readonly Sample[], c: PulseConfig): Indicators {
  const needed = requiredSamples(c);
  const validRun = trailingValidRun(samples);
  if (validRun < needed) {
    const last = samples[samples.length - 1];
    const reason = last && !last.valid
      ? (last.status === 'STALE' ? 'Market data is stale — waiting for fresh ticks' : 'No market data received yet')
      : `Waiting for ${needed} seconds of valid data (${validRun}/${needed})`;
    return { ready: false, validRun, needed, reason };
  }
  const p = (back: number) => samples[samples.length - 1 - back].price as number;
  const price = p(0);
  const r5 = (price / p(c.shortReturnWindowSec) - 1) * 100;
  const r15 = (price / p(c.longReturnWindowSec) - 1) * 100;
  let sum = 0;
  for (let i = 0; i < c.maWindowSec; i++) sum += p(i);
  const ma60 = sum / c.maWindowSec;

  const lastChanges: IndicatorsReady['lastChanges'] = [];
  let ups = 0, downs = 0, flats = 0;
  for (let back = c.confirmLookback - 1; back >= 0; back--) {
    const delta = round(p(back) - p(back + 1), 4);
    const sign: ChangeSign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (sign === 1) ups++; else if (sign === -1) downs++; else flats++;
    lastChanges.push({ delta, sign });
  }
  return {
    ready: true, price,
    r5: round(r5, 6), r15: round(r15, 6), ma60: round(ma60, 4), maDistance: round(price - ma60, 4),
    lastChanges, ups, downs, flats, validRun,
  };
}
