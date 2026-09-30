/**
 * Gate 5.12 / Definition 15.1 — capital head-room and margin. A2 (confirmed
 * single-account collapse): "subscriber u" is the one configured account;
 * there is no per-subscriber loop.
 */
import { THETA } from '../parameters.ts';

/** H_u = min(C_u + π_u, C_u) — a running LOSS reduces head-room 1:1; a running PROFIT does not increase it. */
export function computeHeadroom(deployedCapital: number, runningPnl: number): number {
  return Math.min(deployedCapital + runningPnl, deployedCapital);
}

/** Skip iff I_u ≥ H_u > 0 (already fully invested and head-room is positive). */
export function hasHeadroom(investedAmount: number, headroom: number): boolean {
  return !(investedAmount >= headroom && headroom > 0);
}

/** Unit mode's margin check: ⌊I^alloc/θ39⌋ ≥ 1, i.e. at least one whole unit was computable. */
export function unitModeMarginOk(units: number): boolean {
  return units >= 1;
}

/** Quantity mode's margin check: the broker-quoted structure-proxy margin must not exceed remaining head-room. */
export function quantityModeMarginOk(quotedMargin: number, headroom: number, invested: number): boolean {
  return quotedMargin <= headroom - invested;
}

/** No-basket-margin-quote fallback: compare available broker funds against n_u · θ39. */
export function noBasketMarginFallbackOk(availableFunds: number, units: number, unitBudget: number = THETA.STRUCTURE_UNIT_MARGIN): boolean {
  return availableFunds >= units * unitBudget;
}
