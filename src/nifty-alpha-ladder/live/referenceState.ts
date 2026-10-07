/**
 * Cross-session persistence of the large-order reference state
 * (Definition 13.3's recursive estimator: cumulative count N and running
 * q_hat, per side). PERSISTENCE PLUMBING ONLY — the recursion itself
 * (foldWindow), the quantile level, the 15-minute windows and the 150,000
 * warm-up all live in signal/largeOrderNet.ts and are not touched here.
 *
 * Why it must exist: observations arrive at roughly 320/minute per side, so
 * 150,000 takes ~7.8 hours — longer than one 6.25-hour session. Starting
 * every morning from zero meant G1 could never activate within a day.
 *
 * Safety: state is only carried across an identical source. A contract roll
 * (different instrument token), strategy version, or source mode resets the
 * warm-up explicitly rather than mixing two contracts' statistics; no
 * cross-contract normalization is invented. Malformed or stale rows fail
 * safe to a reset, never to a guess. BID and ASK are judged independently.
 */
import type { ReferenceThresholdState } from '../types.ts';
import { initialReferenceThreshold } from '../signal/largeOrderNet.ts';
import { STRATEGY_VERSION } from '../parameters.ts';
import type { AccumulatorCheckpoint } from './sessionAccumulator.ts';

export const REFERENCE_SOURCE_MODE = 'FUTURES_DEPTH_FALLBACK_MODE';

/** Safety bound (not a strategy parameter): state older than this many days is treated as stale. Covers long holiday weekends. */
export const MAX_REFERENCE_STATE_AGE_DAYS = 10;
/** A persisted timestamp more than this far in the future indicates a clock/data anomaly. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export type Side = 'b' | 'a';

export interface PersistedReferenceState {
  side: Side;
  sourceInstrumentToken: number;
  sourceTradingsymbol: string;
  cumulativeCount: number;
  runningThreshold: number;
  /** End of the last completed reference window folded into this state (epoch ms). */
  lastWindowFoldedAtMs: number;
  strategyVersion: string;
  sourceMode: string;
  updatedAtMs: number;
}

export interface ReferenceSource {
  instrumentToken: number;
  tradingsymbol: string;
}

export type ReferenceRestoreReason =
  | 'RESTORED' | 'NO_PRIOR_STATE' | 'MALFORMED' | 'STALE'
  | 'SOURCE_CHANGED' | 'STRATEGY_VERSION_CHANGED' | 'SOURCE_MODE_CHANGED';

export interface SideOutcome {
  restored: boolean;
  reason: ReferenceRestoreReason;
  detail: string;
  state: ReferenceThresholdState;
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function restoreSide(
  side: Side, raw: unknown, source: ReferenceSource, nowMs: number,
): SideOutcome {
  const reset = (reason: ReferenceRestoreReason, detail: string): SideOutcome =>
    ({ restored: false, reason, detail, state: initialReferenceThreshold() });

  if (raw === null || raw === undefined) return reset('NO_PRIOR_STATE', 'no persisted reference state');
  const r = raw as Partial<PersistedReferenceState>;
  if (
    r.side !== side || !isFiniteNum(r.cumulativeCount) || !Number.isInteger(r.cumulativeCount) || r.cumulativeCount < 0 ||
    !isFiniteNum(r.runningThreshold) || r.runningThreshold < 0 || !isFiniteNum(r.sourceInstrumentToken) ||
    !isFiniteNum(r.lastWindowFoldedAtMs) || typeof r.strategyVersion !== 'string' || typeof r.sourceMode !== 'string'
  ) return reset('MALFORMED', 'persisted reference state is malformed');

  if (r.strategyVersion !== STRATEGY_VERSION) return reset('STRATEGY_VERSION_CHANGED', `persisted ${r.strategyVersion}, running ${STRATEGY_VERSION}`);
  if (r.sourceMode !== REFERENCE_SOURCE_MODE) return reset('SOURCE_MODE_CHANGED', `persisted ${r.sourceMode}, running ${REFERENCE_SOURCE_MODE}`);
  if (r.sourceInstrumentToken !== source.instrumentToken) {
    return reset('SOURCE_CHANGED',
      `contract changed from ${r.sourceTradingsymbol ?? r.sourceInstrumentToken} (token ${r.sourceInstrumentToken}) to ${source.tradingsymbol} (token ${source.instrumentToken}) — reference warm-up restarted for the new contract`);
  }
  if (r.lastWindowFoldedAtMs > nowMs + FUTURE_TOLERANCE_MS) return reset('STALE', 'persisted timestamp is in the future');
  if (nowMs - r.lastWindowFoldedAtMs > MAX_REFERENCE_STATE_AGE_DAYS * 86_400_000) {
    return reset('STALE', `persisted state is older than ${MAX_REFERENCE_STATE_AGE_DAYS} days`);
  }
  return { restored: true, reason: 'RESTORED', detail: 'restored', state: { cumulativeCount: r.cumulativeCount, runningThreshold: r.runningThreshold } };
}

export interface StartingReferenceDecision {
  state: { b: ReferenceThresholdState; a: ReferenceThresholdState };
  /** Where the starting state came from. A same-day checkpoint is authoritative: it already contains the in-session progress, so persisted state is NOT also applied (no double counting). */
  origin: 'CHECKPOINT' | 'PERSISTED';
  outcomes: { b: SideOutcome | null; a: SideOutcome | null };
}

export function chooseStartingReferenceState(input: {
  checkpoint: AccumulatorCheckpoint | null;
  persistedBid: unknown; persistedAsk: unknown;
  source: ReferenceSource; nowMs: number;
}): StartingReferenceDecision {
  if (input.checkpoint) {
    return { state: { b: input.checkpoint.referenceThresholds.b, a: input.checkpoint.referenceThresholds.a }, origin: 'CHECKPOINT', outcomes: { b: null, a: null } };
  }
  const b = restoreSide('b', input.persistedBid, input.source, input.nowMs);
  const a = restoreSide('a', input.persistedAsk, input.source, input.nowMs);
  return { state: { b: b.state, a: a.state }, origin: 'PERSISTED', outcomes: { b, a } };
}

export function buildPersistedState(
  side: Side, state: ReferenceThresholdState, source: ReferenceSource, lastWindowFoldedAtMs: number, nowMs: number,
): PersistedReferenceState {
  return {
    side, sourceInstrumentToken: source.instrumentToken, sourceTradingsymbol: source.tradingsymbol,
    cumulativeCount: state.cumulativeCount, runningThreshold: state.runningThreshold,
    lastWindowFoldedAtMs, strategyVersion: STRATEGY_VERSION, sourceMode: REFERENCE_SOURCE_MODE, updatedAtMs: nowMs,
  };
}

/** Persist only when a new reference window has completed since the last save (the state changes only at window folds). */
export function shouldPersistReference(lastPersistedFoldMs: number | null, currentFoldMs: number): boolean {
  return lastPersistedFoldMs === null || currentFoldMs > lastPersistedFoldMs;
}
