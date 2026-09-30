/**
 * Definition 4.1 — alignment resolution Ψ, and the sign operator sgn_ε that
 * feeds it. "One of the defining features of the strategy" (your own
 * instruction) — implemented exactly, never altered.
 */
import type { SignedDirection, Direction } from '../types.ts';
import { THETA } from '../parameters.ts';

/** sgn_ε(x): Definition 2.4. Dead-band θ6 around zero. */
export function signWithTolerance(x: number, tolerance: number = THETA.SIGN_TOLERANCE): SignedDirection {
  if (x > tolerance) return 1;
  if (x < -tolerance) return -1;
  return 0;
}

export interface AlignmentResult {
  /** D0 — undefined only when d1 = 0 (caller must not fire the signal yet). */
  baseDirection: Direction | null;
  /** α: 1 if aligned (d1 = d2), 0 if divergent (including d2 = 0). */
  alpha: 0 | 1;
}

/**
 * Ψ(d1,d2): aligned summaries are faded (D0 = −d1); divergent summaries
 * follow the large-order path (D0 = d1). Undefined when d1 = 0 — the base
 * rule cannot resolve a direction and nothing is recorded; the engine
 * re-evaluates on the next lattice instant (Proposition 4.4's closed form:
 * Ψ = d1·(1 − 2·𝟙{d1=d2}) for d1≠0).
 */
export function resolveAlignment(d1: SignedDirection, d2: SignedDirection): AlignmentResult {
  if (d1 === 0) return { baseDirection: null, alpha: 0 };
  const aligned = d1 === d2;
  return {
    baseDirection: (aligned ? -d1 : d1) as Direction,
    alpha: aligned ? 1 : 0,
  };
}
