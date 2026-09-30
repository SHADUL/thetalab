/**
 * Piecewise expiry value and risk characterisation — spec §7 Eq (6.6)/(6.7),
 * Proposition 6.3 (break-evens). Bearish orientation; bullish is the mirror
 * about A (Proposition 14.4) — callers wanting the bullish payoff reflect
 * S_T about A themselves rather than this module carrying a direction flag,
 * since the formula is genuinely symmetric and a flag would just be another
 * way to spell that reflection.
 *
 * New module — not present in the originally suggested directory tree, but
 * required by spec §7/§12 and by your own instruction (§15 "max loss/gain/
 * tail/break-even", §16 "structural risk calculation").
 */
import type { PayoffResult } from '../types.ts';

/**
 * V⁻(S_T) = 4·(A−S_T)⁺ − 5·(A−200−S_T)⁺ + (A−400−S_T)⁺ — Eq (6.6), in index
 * points, one unit, bearish orientation. `wingPoints` is the 200-point
 * offset (§7's declared 4 strike steps at Δ=50); passed explicitly rather
 * than hard-coded so a different strike step still produces the correct
 * geometry.
 */
export function bearishUnitPayoff(spotAtExpiry: number, atmStrike: number, wingPoints: number): number {
  const positivePart = (x: number) => Math.max(x, 0);
  const A = atmStrike;
  return (
    4 * positivePart(A - spotAtExpiry) -
    5 * positivePart(A - wingPoints - spotAtExpiry) +
    positivePart(A - 2 * wingPoints - spotAtExpiry)
  );
}

/**
 * Eq (6.7): max loss/gain/tail value for the whole sized position, in ₹,
 * given the net debit per unit `deltaPoints` (index points), unit count
 * `units`, exchange lot size `lotSize` and the resolved ATM strike (needed
 * only to express break-evens as absolute index levels).
 */
export function computePayoffSummary(deltaPoints: number, units: number, lotSize: number, atmStrike: number): PayoffResult {
  const scale = units * lotSize;
  return {
    maxLoss: scale * deltaPoints,
    maxGain: scale * (800 - deltaPoints),
    tailValue: scale * (600 - deltaPoints),
    breakEvens: computeBreakEvenOffsets(deltaPoints).map((offset) => atmStrike + offset),
  };
}

/**
 * Proposition 6.3: for 0<δ<600 a single break-even at A−δ/4; for
 * 600≤δ<800 a second break-even appears at A−1000+δ. Returns OFFSETS from A
 * (in index points) — `computePayoffSummary` adds A for the absolute level;
 * exposed separately so a caller who only has δ (no strike yet) can still
 * reason about the break-even structure.
 */
export function computeBreakEvenOffsets(deltaPoints: number): number[] {
  if (deltaPoints <= 0 || deltaPoints >= 800) return [];
  const first = -deltaPoints / 4; // offset from A: S_T = A - δ/4
  if (deltaPoints < 600) return [first];
  return [first, -(1000 - deltaPoints)]; // S_T = A - 1000 + δ  =>  offset = -(1000-δ)
}
