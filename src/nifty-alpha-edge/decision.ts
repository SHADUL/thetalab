/**
 * hedged131's direction for the week. The order-flow part (d1, d2, alpha,
 * D0, g*) is the SHARED weekly signal produced by the Alpha Ladder engine;
 * this strategy re-applies Variation C with a real India VIX reading at the
 * signal instant τ* (the shared worker records VIX as unavailable, which
 * leaves Variation C inert). Uses the same applyVariationC function — no
 * reimplementation of the rule.
 */
import { applyVariationC } from '../nifty-alpha-ladder/signal/variationC.ts';
import type { Direction } from '../nifty-alpha-ladder/types.ts';

export interface SharedSignal {
  id: number;
  weekKey: string;
  signalDate: string;
  /** Absolute epoch ms of τ*. */
  signalInstantMs: number;
  path: 'crossing' | 'cutoff';
  d1: number;
  d2: number;
  alpha: 0 | 1;
  baseDirection: Direction;
  g2AtSignal: number;
  area1: number;
  area2: number;
  g1AtSignal: number;
  createdAtMs: number;
}

export interface VixBar { startMs: number; close: number }

/** v* = close of the latest bar stamped at or before τ*; non-positive closes are ignored (spec §4.7). */
export function vixAtOrBefore(bars: VixBar[], tauMs: number): number | null {
  let best: VixBar | null = null;
  for (const b of bars) {
    if (b.startMs <= tauMs && b.close > 0 && (!best || b.startMs > best.startMs)) best = b;
  }
  return best ? best.close : null;
}

export interface EdgeDecision {
  direction: Direction;
  baseDirection: Direction;
  vix: number | null;
  vixAvailable: boolean;
  variationCActed: boolean;
}

export function decideDirection(signal: SharedSignal, vixBars: VixBar[]): EdgeDecision {
  const vix = vixAtOrBefore(vixBars, signal.signalInstantMs);
  const vc = applyVariationC({
    baseDirection: signal.baseDirection, alpha: signal.alpha, gStar: signal.g2AtSignal,
    vixValue: vix, vixAvailable: vix !== null,
  });
  return { direction: vc.finalDirection, baseDirection: signal.baseDirection, vix, vixAvailable: vix !== null, variationCActed: vc.acted };
}

export function signalFromRow(row: any): SharedSignal {
  return {
    id: row.id, weekKey: row.week_key, signalDate: row.signal_date, signalInstantMs: Date.parse(row.signal_instant),
    path: row.path, d1: row.d1, d2: row.d2, alpha: row.alpha, baseDirection: row.base_direction,
    g2AtSignal: Number(row.g2_at_signal), area1: Number(row.area1), area2: Number(row.area2), g1AtSignal: Number(row.g1_at_signal),
    createdAtMs: Date.parse(row.created_at),
  };
}
