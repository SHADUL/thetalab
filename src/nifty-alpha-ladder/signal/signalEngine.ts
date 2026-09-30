/**
 * Signal engine composition — spec §5 Eq (4.5)–(4.11), the operator view of
 * spec §15 (Eq 14.1). Pure: takes already-built G1/G2 knot series and a VIX
 * read, returns a decision. No knowledge of execution mode (SHADOW/AUTO) —
 * per the implementation plan's mode rule, this module is identical for
 * both; mode belongs only in the downstream execution layer (Milestone 3+).
 */
import type { Direction, PathKnot, SignalPath, SignedDirection } from '../types.ts';
import { computeG1Area } from './largeOrderNet.ts';
import { computeG2Area, findFirstCrossing } from './imbalancePath.ts';
import { valueAtOrBefore } from './signedArea.ts';
import { signWithTolerance, resolveAlignment } from './alignmentRule.ts';
import { applyVariationC } from './variationC.ts';

/** Plain sign (no dead-band) — Eq (4.7)'s d2 = sgn(G2(τ×)) on the crossing path uses this, not sgn_ε. Unreachable-zero in practice since |G2(τ×)| ≥ θ5 by construction of a crossing. */
function sign(x: number): SignedDirection {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

export interface VixRead {
  value: number | null;
  available: boolean;
}

export interface SignalEngineInput {
  g1Knots: PathKnot[];
  g2Knots: PathKnot[];
  /** Current lattice evaluation instant, seconds since the same origin as the knots. */
  nowSec: number;
  /** Session cutoff T_c = 14:30, in the same seconds-since-origin frame. */
  cutoffSec: number;
  vix: VixRead;
}

export type SignalDecision =
  | { fired: false }
  | {
      fired: true;
      path: SignalPath;
      signalInstantSec: number;
      d1: SignedDirection;
      d2: SignedDirection;
      alpha: 0 | 1;
      baseDirection: Direction;
      finalDirection: Direction;
      area1: number;
      area2: number;
      g1AtSignal: number;
      g2AtSignal: number;
      crossingTimeSec: number | null;
      crossingG2Value: number | null;
      vixValue: number | null;
      vixAvailable: boolean;
      variationCActed: boolean;
    };

/**
 * Evaluates the composite decision Γ (Eq 14.1) at one lattice instant.
 * Returns `{fired:false}` when either no crossing has happened yet and we
 * are before cutoff (nothing to decide), or d1=0 (base rule unresolved) —
 * both cases mean "re-evaluate at the next lattice instant," per the spec.
 */
export function evaluateSignal(input: SignalEngineInput): SignalDecision {
  const { g1Knots, g2Knots, nowSec, cutoffSec, vix } = input;

  const crossing = findFirstCrossing(g2Knots, Math.min(nowSec, cutoffSec - 1e-9));
  let path: SignalPath;
  let signalInstantSec: number;
  let d2: SignedDirection;
  let g2AtSignal: number;

  if (nowSec < cutoffSec && crossing) {
    path = 'crossing';
    signalInstantSec = crossing.timeSec;
    d2 = sign(crossing.value);
    g2AtSignal = crossing.value;
  } else if (nowSec >= cutoffSec) {
    path = 'cutoff';
    signalInstantSec = cutoffSec;
    const area2AtCutoff = computeG2Area(g2Knots, cutoffSec);
    d2 = signWithTolerance(area2AtCutoff);
    g2AtSignal = valueAtOrBefore(g2Knots, cutoffSec) ?? 0;
  } else {
    // Before cutoff and no crossing yet — nothing to decide this instant.
    return { fired: false };
  }

  const area1 = computeG1Area(g1Knots, signalInstantSec);
  const d1 = signWithTolerance(area1);
  if (d1 === 0) return { fired: false };

  const { baseDirection, alpha } = resolveAlignment(d1, d2);
  // Guaranteed non-null: d1 !== 0 was just checked above.
  const D0 = baseDirection!;

  const area2 = computeG2Area(g2Knots, signalInstantSec);
  const g1AtSignal = valueAtOrBefore(g1Knots, signalInstantSec) ?? 0;

  const variationC = applyVariationC({
    baseDirection: D0,
    alpha,
    gStar: g2AtSignal,
    vixValue: vix.value,
    vixAvailable: vix.available,
  });

  return {
    fired: true,
    path,
    signalInstantSec,
    d1,
    d2,
    alpha,
    baseDirection: D0,
    finalDirection: variationC.finalDirection,
    area1,
    area2,
    g1AtSignal,
    g2AtSignal,
    crossingTimeSec: crossing ? crossing.timeSec : null,
    crossingG2Value: crossing ? crossing.value : null,
    vixValue: vix.value,
    vixAvailable: vix.available,
    variationCActed: variationC.acted,
  };
}
