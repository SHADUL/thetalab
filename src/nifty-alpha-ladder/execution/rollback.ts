/**
 * Compensating rollback — Definition 7.5, simulated. Processes filled legs
 * in REVERSE placement order (heavier shorts closed while their protective
 * longs are still simulated "on") and records what WOULD have happened in
 * AUTO — a real compensating exit order and fill event, not merely a
 * status flip.
 */
import { simulateFill, type MarketSnapshot, type FillOutcome } from './shadowFillModel.ts';
import { marketableLimitPrice } from './marketableLimit.ts';
import type { LegEntryResult } from './entrySequencer.ts';
import { THETA } from '../parameters.ts';

export interface RollbackLegResult {
  originalLegIndex: number;
  compensatingSide: 'BUY' | 'SELL';
  limit: number;
  outcome: FillOutcome;
}

export interface RollbackResult {
  legs: RollbackLegResult[];
  /** true iff every filled leg was successfully unwound; false means a residue was escalated (Definition 10.3) — never over-closed, never guessed. */
  fullyUnwound: boolean;
}

/**
 * `rollbackIndices` must already be in the order they were FILLED
 * (ascending placement order); this function reverses them itself.
 * `snapshotsFor` supplies the post-cancel market evolution for the
 * compensating order at each leg (a fresh quote read, per the spec).
 */
export function simulateRollback(
  legResults: LegEntryResult[],
  rollbackIndices: number[],
  snapshotsFor: (originalLegIndex: number) => MarketSnapshot[],
): RollbackResult {
  const reverseOrder = [...rollbackIndices].sort((a, b) => b - a);
  const legs: RollbackLegResult[] = [];
  let fullyUnwound = true;

  for (const idx of reverseOrder) {
    const original = legResults[idx];
    const compensatingSide: 'BUY' | 'SELL' = original.leg.side === 'BUY' ? 'SELL' : 'BUY';
    const referencePrice = original.outcome.fillPrice ?? original.leg.referencePrice;
    const limit = marketableLimitPrice(compensatingSide, referencePrice, original.leg.tick);
    const snapshots = snapshotsFor(idx);
    const deadlineMs = THETA.ROLLBACK_STATUS_LOOKUP_SEC * 1000 + THETA.ROLLBACK_RECHECK_SEC * 1000;
    const outcome = simulateFill(compensatingSide, limit, referencePrice, snapshots, deadlineMs);
    legs.push({ originalLegIndex: idx, compensatingSide, limit, outcome });
    if (!outcome.filled) {
      // Definition 10.3: a leg whose state cannot be established is
      // escalated — this simulation stops touching lighter legs rather
      // than guessing, mirroring the real rollback's own halt condition.
      fullyUnwound = false;
      break;
    }
  }

  return { legs, fullyUnwound };
}
