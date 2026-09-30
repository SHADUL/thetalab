/**
 * Definition 6.1 — unit mode. n_u = floor(allocated capital / θ39). A2
 * (confirmed): "subscriber u" collapses to the single configured account —
 * there is no fan-out loop here, just one allocation.
 */
import { THETA } from '../parameters.ts';

/** Returns 0 (skip) when allocatedCapital <= 0, matching "subscribers with n_u=0 are skipped." */
export function computeUnitModeUnits(allocatedCapital: number, unitBudget: number = THETA.STRUCTURE_UNIT_MARGIN): number {
  if (allocatedCapital <= 0) return 0;
  return Math.floor(allocatedCapital / unitBudget);
}
