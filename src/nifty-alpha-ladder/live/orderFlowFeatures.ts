/**
 * Read-only order-flow FEATURES for consumers outside Alpha Ladder (the
 * Options Auto-Trader's observe-only experiment). Reuses the existing pure
 * G1/G2/alignment/Variation C functions UNCHANGED — nothing here alters the
 * signal engine, thresholds or any strategy decision; it only evaluates the
 * same functions "as of now" instead of only at a fired signal instant.
 *
 * d2 follows the engine's own rule where it applies: sign of G2 at the
 * crossing if one exists before the cutoff; sign_eps of the G2 area at the
 * cutoff once past it; before either, a PROVISIONAL running-area sign
 * (d2Basis = 'running_area') — consumers must treat that as provisional.
 */
import type { Direction, SignedDirection } from '../types.ts';
import type { SessionAccumulatorState } from './sessionAccumulator.ts';
import { buildLargeOrderEvents, computeG1Knots, computeG1Area, isThresholdActive } from '../signal/largeOrderNet.ts';
import { computeG2Knots, computeG2Area, findFirstCrossing } from '../signal/imbalancePath.ts';
import { valueAtOrBefore } from '../signal/signedArea.ts';
import { signWithTolerance, resolveAlignment } from '../signal/alignmentRule.ts';
import { applyVariationC } from '../signal/variationC.ts';
import type { VixRead } from '../signal/signalEngine.ts';

export type D2Basis = 'crossing' | 'cutoff_area' | 'running_area';

export interface OrderFlowFeatures {
  asOfSec: number;
  g1: number | null;
  a1: number;
  d1: SignedDirection;
  g2: number | null;
  a2: number;
  d2: SignedDirection;
  d2Basis: D2Basis;
  g2Crossed: boolean;
  crossingValue: number | null;
  /** 1 = d1 and d2 agree (Alpha Ladder fades), 0 = divergent. null while d1 = 0 (undefined). */
  alpha: 0 | 1 | null;
  /** D0 — Alpha Ladder's base direction (+1 bullish / -1 bearish). null while d1 = 0. */
  baseDirection: Direction | null;
  /** D — final direction after Variation C. null while d1 = 0. */
  finalDirection: Direction | null;
  variationCActed: boolean;
  vixAvailable: boolean;
  /** Both sides' reference thresholds are active (θ2 warm-up met) — until then G1 is empty and d1 = 0 means "no data", not "no pressure". */
  g1Active: boolean;
}

const sign = (x: number): SignedDirection => (x > 0 ? 1 : x < 0 ? -1 : 0);

export function computeOrderFlowFeatures(
  state: SessionAccumulatorState, nowSec: number, cutoffSec: number, vix: VixRead,
): OrderFlowFeatures {
  const events = buildLargeOrderEvents(state.rawObservations, (side) => state.referenceThresholds[side]);
  const g1Knots = computeG1Knots(events, state.sessionOriginMs);
  const g2Knots = computeG2Knots(state.aggregateSnapshots);

  const evalSec = Math.min(nowSec, cutoffSec);
  const crossing = findFirstCrossing(g2Knots, Math.min(nowSec, cutoffSec - 1e-9));
  const a1 = computeG1Area(g1Knots, evalSec);
  const a2 = computeG2Area(g2Knots, evalSec);
  const d1 = signWithTolerance(a1);

  let d2: SignedDirection;
  let d2Basis: D2Basis;
  if (crossing && nowSec < cutoffSec) { d2 = sign(crossing.value); d2Basis = 'crossing'; }
  else if (nowSec >= cutoffSec) { d2 = signWithTolerance(a2); d2Basis = 'cutoff_area'; }
  else { d2 = signWithTolerance(a2); d2Basis = 'running_area'; }

  const g1Active = isThresholdActive(state.referenceThresholds.b) && isThresholdActive(state.referenceThresholds.a);
  let alpha: 0 | 1 | null = null;
  let baseDirection: Direction | null = null;
  let finalDirection: Direction | null = null;
  let variationCActed = false;
  if (d1 !== 0) {
    const r = resolveAlignment(d1, d2);
    alpha = r.alpha;
    baseDirection = r.baseDirection;
    const g2Now = valueAtOrBefore(g2Knots, evalSec) ?? 0;
    const vc = applyVariationC({ baseDirection: r.baseDirection!, alpha: r.alpha, gStar: crossing ? crossing.value : g2Now, vixValue: vix.value, vixAvailable: vix.available });
    finalDirection = vc.finalDirection;
    variationCActed = vc.acted;
  }

  return {
    asOfSec: nowSec, g1: valueAtOrBefore(g1Knots, evalSec), a1, d1, g2: valueAtOrBefore(g2Knots, evalSec), a2, d2, d2Basis,
    g2Crossed: !!crossing, crossingValue: crossing ? crossing.value : null,
    alpha, baseDirection, finalDirection, variationCActed, vixAvailable: vix.available, g1Active,
  };
}
