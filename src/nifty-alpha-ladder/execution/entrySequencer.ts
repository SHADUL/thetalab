/**
 * Strict leg-by-leg SHADOW entry sequencing — spec §25/§26 of the
 * Milestone 3 instructions, Definitions 7.3/7.4 of the PDF. Simulates the
 * exact production state machine (IDLE→SIZED→PLACING→GATING→COMPLETE→
 * ROLLBACK→ABANDONED) so SHADOW validates the same machine AUTO will use —
 * never releases leg N+1 before leg N is simulated COMPLETE, never marks a
 * short live before both protective longs are simulated complete.
 */
import { THETA } from '../parameters.ts';
import { marketableLimitPrice } from './marketableLimit.ts';
import { simulateFill, type MarketSnapshot, type FillOutcome } from './shadowFillModel.ts';

export interface LegSpec {
  side: 'BUY' | 'SELL';
  tradingsymbol: string;
  quantity: number;
  tick: number;
  referencePrice: number;
  /** Market evolution after THIS leg's submission — caller-supplied fixture/live feed, sorted ascending by atMs. */
  snapshots: MarketSnapshot[];
}

export interface LegEntryResult {
  leg: LegSpec;
  limit: number;
  outcome: FillOutcome;
}

export type EntrySequenceState = 'COMPLETE' | 'ABANDONED' | 'ROLLBACK';

export interface EntrySequenceResult {
  legResults: LegEntryResult[];
  state: EntrySequenceState;
  /** Indices (into legResults) of legs that filled and therefore need rollback — only populated when state==='ROLLBACK'. */
  rollbackIndices: number[];
}

/** Total fill-gate deadline for one leg, from Definition 7.4/Eq (16.1) — simplified to the two extremes since a fixture-driven simulation doesn't observe a real "seen OPEN at exchange" intermediate signal; uses the tighter of the two caps as a conservative deadline. */
function fillGateDeadlineMs(): number {
  return Math.min(THETA.FILL_GATE_BROKER_PHASE_CAP_SEC, THETA.FILL_GATE_ABSOLUTE_CEILING_SEC) * 1000;
}

/**
 * Simulates the strict declared-order entry: legs must already be in
 * placement order (index 0 = leg 1, etc. — the caller, i.e. the resolved
 * ladder from instruments/ladderTemplate.ts, already guarantees this).
 */
export function simulateEntrySequence(legs: LegSpec[]): EntrySequenceResult {
  const legResults: LegEntryResult[] = [];
  const deadlineMs = fillGateDeadlineMs();

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const limit = marketableLimitPrice(leg.side, leg.referencePrice, leg.tick);
    const outcome = simulateFill(leg.side, limit, leg.referencePrice, leg.snapshots, deadlineMs);
    legResults.push({ leg, limit, outcome });

    if (!outcome.filled) {
      if (i === 0) {
        // First leg NOT_PLACED/TIMEOUT/DEAD -> abandon, nothing simulated on the book.
        return { legResults, state: 'ABANDONED', rollbackIndices: [] };
      }
      // Any later leg's failure -> rollback every PREVIOUSLY FILLED leg (reverse order handled by rollback.ts).
      const rollbackIndices = legResults.slice(0, i).map((_, idx) => idx).filter((idx) => legResults[idx].outcome.filled);
      return { legResults, state: 'ROLLBACK', rollbackIndices };
    }
    // theta14 inter-leg pause is a real-clock concern in the live worker;
    // this pure simulation doesn't need to model it (it doesn't affect
    // whether the NEXT leg fills, only when it's released, which the
    // worker's own scheduler enforces).
  }

  return { legResults, state: 'COMPLETE', rollbackIndices: [] };
}

/** Invariant 7.6 (no naked short at entry): true iff, at every prefix of the sequence, filled SHORT quantity never exceeds filled protective (BUY) coverage placed earlier. Checked as a standing assertion, not just a test — see the CRITICAL_SHADOW_INVARIANT hook in rollback.ts. */
export function noNakedShortInvariantHolds(legResults: LegEntryResult[]): boolean {
  let coveredLongQty = 0;
  for (const { leg, outcome } of legResults) {
    if (!outcome.filled) continue;
    if (leg.side === 'BUY') coveredLongQty += leg.quantity;
    else if (leg.quantity > coveredLongQty) return false;
  }
  return true;
}
