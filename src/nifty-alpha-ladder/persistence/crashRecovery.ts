/**
 * Crash recovery — resume from durable state, never blindly replay the
 * whole structure (your explicit instruction). Pure function over already-
 * loaded rows: the worker's own restart path reads the current signal/
 * call/position/leg/shadow-order rows via AlphaLadderStore and hands them
 * to `determineResumeAction`, which returns exactly one next step.
 */
import type { CallRow, LegRow, PositionRow, ShadowOrderRow, SignalRow } from './store.ts';

export type ResumeAction =
  | { kind: 'PUBLISH_MONITOR_AND_STRUCTURE_CALLS'; signal: SignalRow }
  | { kind: 'RESOLVE_STRUCTURE'; call: CallRow }
  | { kind: 'PLACE_NEXT_LEG'; position: PositionRow; legIndex: number }
  | { kind: 'ROLLBACK_IN_PROGRESS'; position: PositionRow; legs: LegRow[] }
  | { kind: 'ENTRY_COMPLETE_MONITOR_FOR_EXIT'; position: PositionRow }
  | { kind: 'EXIT_SHORT_LEGS_PENDING'; position: PositionRow; legs: LegRow[] }
  | { kind: 'EXIT_LONG_LEGS_PENDING'; position: PositionRow; legs: LegRow[] }
  | { kind: 'NOTHING_TO_DO'; position: PositionRow };

export interface RecoveryState {
  signal: SignalRow;
  structureCall: CallRow | null;
  position: PositionRow | null;
  legs: LegRow[];
  /** Keyed by legId — every shadow order (entry/rollback/exit) recorded for that leg so far. */
  shadowOrdersByLeg: Map<number, ShadowOrderRow[]>;
}

export function determineResumeAction(state: RecoveryState): ResumeAction {
  const { signal, structureCall, position, legs } = state;

  if (!structureCall) {
    // Signal persisted but the call(s) were never created — resume at publication.
    return { kind: 'PUBLISH_MONITOR_AND_STRUCTURE_CALLS', signal };
  }
  if (!position) {
    // Call exists but structure resolution (strike/expiry/ATM) never completed.
    return { kind: 'RESOLVE_STRUCTURE', call: structureCall };
  }

  if (position.status === 'ACTIVE' && structureCall.status === 'PUBLISHED') {
    // Entry sequencing was in progress — find the first leg not yet COMPLETE.
    const rollingBack = legs.some((l) => l.status === 'ROLLBACK');
    if (rollingBack) return { kind: 'ROLLBACK_IN_PROGRESS', position, legs };
    const firstIncomplete = legs.findIndex((l) => l.status !== 'COMPLETE');
    if (firstIncomplete === -1) {
      // Every leg COMPLETE but the call was never marked LIVE — a crash
      // between the last fill and the state-flip. Resume by marking LIVE,
      // not by re-placing anything.
      return { kind: 'ENTRY_COMPLETE_MONITOR_FOR_EXIT', position };
    }
    return { kind: 'PLACE_NEXT_LEG', position, legIndex: firstIncomplete };
  }

  if (structureCall.status === 'LIVE') {
    return { kind: 'ENTRY_COMPLETE_MONITOR_FOR_EXIT', position };
  }

  if (structureCall.status === 'EXIT_REQUESTED' || structureCall.status === 'EXITING') {
    const shortLegs = legs.filter((l) => l.side === 'SELL');
    const longLegs = legs.filter((l) => l.side === 'BUY');
    const shortOrdersComplete = (legId: number) => (state.shadowOrdersByLeg.get(legId) ?? []).some((o) => o.orderKind === 'EXIT' && o.fillStatus === 'COMPLETE');
    const allShortsClosed = shortLegs.every((l) => shortOrdersComplete(l.id));
    if (!allShortsClosed) return { kind: 'EXIT_SHORT_LEGS_PENDING', position, legs: shortLegs };
    const allLongsClosed = longLegs.every((l) => shortOrdersComplete(l.id));
    if (!allLongsClosed) return { kind: 'EXIT_LONG_LEGS_PENDING', position, legs: longLegs };
  }

  return { kind: 'NOTHING_TO_DO', position };
}
