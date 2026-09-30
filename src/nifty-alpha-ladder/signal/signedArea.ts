/**
 * Shared trapezoidal signed-area function 𝒜(u) — spec Eq (4.2)/(4.4). One
 * implementation used by both G1's 𝒜1 and G2's 𝒜2, exactly as the PDF gives
 * a single formula reused for both: the trapezoid rule over observed knots,
 * with linear interpolation of the final partial segment, in seconds.
 *
 * Conventions (verbatim from the spec): 𝒜(u) = knots[0].value when exactly
 * one knot lies at or before u; 𝒜(u) = 0 when none does.
 */
import type { PathKnot } from '../types.ts';

function interpolate(a: PathKnot, b: PathKnot, x: number): number {
  if (b.timeSec === a.timeSec) return a.value;
  return a.value + (b.value - a.value) * ((x - a.timeSec) / (b.timeSec - a.timeSec));
}

/**
 * Computes 𝒜(u): the trapezoidal signed area of a piecewise-constant path
 * (observed at `knots`, sorted ascending by timeSec) up to instant `u`.
 * `knots` must already be sorted ascending by timeSec.
 */
export function signedArea(knots: PathKnot[], u: number): number {
  const atOrBefore = knots.filter((k) => k.timeSec <= u);
  if (atOrBefore.length === 0) return 0;
  if (atOrBefore.length === 1) return atOrBefore[0].value;

  let area = 0;
  for (let j = 0; j < knots.length; j++) {
    const sj = knots[j].timeSec;
    if (sj >= u) break;
    const next = knots[j + 1];
    const end = next ? Math.min(next.timeSec, u) : u;
    const endValue = next ? (next.timeSec <= u ? next.value : interpolate(knots[j], next, u)) : knots[j].value;
    area += 0.5 * (knots[j].value + endValue) * (end - sj);
  }
  return area;
}

/** The path's own level (not its area) at the last knot stamped at or before `u` — e.g. G2(τ*) for Variation C's g*. Null if no knot qualifies. */
export function valueAtOrBefore(knots: PathKnot[], u: number): number | null {
  let result: number | null = null;
  for (const k of knots) {
    if (k.timeSec > u) break;
    result = k.value;
  }
  return result;
}
