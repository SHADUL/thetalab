/**
 * Variation C — the volatility-conditioned contrarian filter. Spec §5 Eq
 * (4.10)/(4.11). Strictly asymmetric: only a bullish base decision can be
 * reversed, and only to bearish. Never guesses a VIX value — inert (D = D0)
 * whenever the read is unavailable.
 */
import type { Direction } from '../types.ts';
import { THETA } from '../parameters.ts';

export interface VariationCInput {
  baseDirection: Direction;
  alpha: 0 | 1;
  /** g*: G2 evaluated at the last snapshot at or before τ*. */
  gStar: number;
  /** v*: close of the latest India VIX bar at/before τ*, as returned at the decision instant. Null/unavailable maps to vixAvailable=false. */
  vixValue: number | null;
  vixAvailable: boolean;
}

export interface VariationCResult {
  finalDirection: Direction;
  /** W: whether the read was weak (divergent, or a sub-threshold |g*|). */
  weak: boolean;
  /** Whether the filter actually reversed the decision this time. */
  acted: boolean;
}

/** W = (α=0) ∨ (|g*| < θ8) — Eq (4.10). */
export function isWeakRead(alpha: 0 | 1, gStar: number, strongReadLevel: number = THETA.STRONG_READ_LEVEL): boolean {
  return alpha === 0 || Math.abs(gStar) < strongReadLevel;
}

/**
 * D = −1 if D0=+1 ∧ χ=1 ∧ v*<θ7 ∧ W; D = D0 otherwise — Eq (4.11).
 * When the VIX read fails (vixAvailable=false) the filter is inert: the base
 * direction is traded unfiltered, exactly like the unfiltered rule, rather
 * than guessing a volatility level.
 */
export function applyVariationC(input: VariationCInput, calmCutoff: number = THETA.CALM_VIX_CUTOFF): VariationCResult {
  const weak = isWeakRead(input.alpha, input.gStar);
  const canAct = input.baseDirection === 1 && input.vixAvailable && input.vixValue !== null && input.vixValue < calmCutoff && weak;
  if (canAct) return { finalDirection: -1, weak, acted: true };
  return { finalDirection: input.baseDirection, weak, acted: false };
}
