/**
 * Feature 2 — cumulative aggregate book imbalance (G2). Spec §5 Eq
 * (4.3)/(4.4), Definition 2.6 (snapshot construction).
 */
import type { AggregateSnapshot, PathKnot } from '../types.ts';
import { THETA } from '../parameters.ts';
import { signedArea } from './signedArea.ts';

/** ρ_k = (B_k − A_k)/(B_k + A_k), or 0 when B_k+A_k = 0. */
export function computeRho(snapshot: AggregateSnapshot): number {
  const denom = snapshot.bidQty + snapshot.askQty;
  return denom > 0 ? (snapshot.bidQty - snapshot.askQty) / denom : 0;
}

/**
 * G2(t_k) = Σ_{r≤k} ρ_r — cumulative sum of the per-snapshot imbalance
 * ratio. `snapshots` must already be sorted ascending by timeSec.
 */
export function computeG2Knots(snapshots: AggregateSnapshot[]): PathKnot[] {
  let cumulative = 0;
  return snapshots.map((s) => {
    cumulative += computeRho(s);
    return { timeSec: s.timeSec, value: cumulative };
  });
}

/** 𝒜2(u): the signed time-integral of G2 up to instant u. */
export function computeG2Area(knots: PathKnot[], uSec: number): number {
  return signedArea(knots, uSec);
}

/**
 * τ×: the first snapshot (in time order) at which |G2(t_k)| ≥ θ5 — Eq (4.5).
 * Returns null if no snapshot up to `atOrBeforeSec` crosses (the caller is
 * responsible for only looking as far as the current evaluation instant, per
 * the spec's "the evaluator never reads a sample stamped after the
 * evaluation instant").
 */
export function findFirstCrossing(
  knots: PathKnot[],
  atOrBeforeSec: number,
  crossingLevel: number = THETA.IMBALANCE_CROSSING_LEVEL,
): PathKnot | null {
  for (const k of knots) {
    if (k.timeSec > atOrBeforeSec) break;
    if (Math.abs(k.value) >= crossingLevel) return k;
  }
  return null;
}
