/**
 * Session-integrity guard — separate from worker health. Alpha Ladder's
 * signal is path-dependent (G1/G2 are integrals from 09:15), so a session
 * only qualifies for a NEW signal if this system has continuous market-data
 * coverage from the session start. A worker that is perfectly HEALTHY can
 * still be running on an incomplete path (late start, unrecoverable gap).
 *
 * Pure functions over explicit inputs. Does not touch G1/G2 mathematics.
 */
import { THETA } from '../parameters.ts';
import type { AccumulatorCheckpoint } from './sessionAccumulator.ts';

export type SessionIntegrityReason = 'LATE_SESSION_START' | 'UNRECOVERABLE_FEED_GAP';

export interface SessionIntegrity {
  valid: boolean;
  reason: SessionIntegrityReason | null;
  detail: string | null;
}

/** Zero grace: collecting must begin at or before 09:15:00 IST. Start well before the open. */
export const LATE_START_GRACE_MS = 0;

const INTERVAL_SEC = THETA.AGGREGATE_SNAPSHOT_INTERVAL_MIN * 60;
const INTERVAL_MS = INTERVAL_SEC * 1000;

const VALID: SessionIntegrity = { valid: true, reason: null, detail: null };

function fmtIST(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Can a durable checkpoint PROVE observation was continuous from the
 * session start? Proof is structural, using only what the checkpoint holds:
 *  - closed G2 snapshots must run 180s, 360s, ... with no missing bucket
 *    (missing buckets are never zero-filled, so a hole means a hole);
 *  - no closed bucket may be {0,0} (a live NIFTY futures book is never
 *    empty for 3 minutes — an all-zero bucket is a fabricated/legacy
 *    placeholder, not an observation);
 *  - with no closed bucket yet, the open bucket must contain observations
 *    from within the first interval after the open.
 */
export function hasContinuousCoverageFromOpen(checkpoint: AccumulatorCheckpoint): boolean {
  const snaps = checkpoint.aggregateSnapshots;
  if (snaps.length === 0) {
    const firstObsMs = checkpoint.pendingIntervalObservations.reduce<number | null>(
      (min, o) => (min === null || o.timestampMs < min ? o.timestampMs : min), null);
    return firstObsMs !== null && firstObsMs <= checkpoint.sessionOriginMs + INTERVAL_MS;
  }
  for (let i = 0; i < snaps.length; i++) {
    if (snaps[i].timeSec !== (i + 1) * INTERVAL_SEC) return false;
    if (snaps[i].bidQty === 0 && snaps[i].askQty === 0) return false;
  }
  return true;
}

/** Earliest instant of real data the checkpoint holds, for the human-readable reason. */
function firstRealDataMs(checkpoint: AccumulatorCheckpoint): number | null {
  const firstSnap = checkpoint.aggregateSnapshots.find((s) => s.bidQty > 0 || s.askQty > 0);
  if (firstSnap) return checkpoint.sessionOriginMs + firstSnap.timeSec * 1000 - INTERVAL_MS;
  const obs = checkpoint.pendingIntervalObservations.reduce<number | null>(
    (min, o) => (min === null || o.timestampMs < min ? o.timestampMs : min), null);
  return obs;
}

export interface SessionIntegrityInput {
  /** When this process began collecting market data for the session. */
  startMs: number;
  sessionOriginMs: number;
  checkpoint: AccumulatorCheckpoint | null;
  /** restoreOrStartFresh's verdict that the downtime since the checkpoint exceeded the recoverable window. */
  gapDetected: boolean;
  gapDurationMs: number;
  /** An invalidating gap already persisted for today — once invalid, a session stays invalid across restarts. */
  priorInvalidation: SessionIntegrity | null;
}

export function assessSessionIntegrity(input: SessionIntegrityInput): SessionIntegrity {
  if (input.priorInvalidation && !input.priorInvalidation.valid) return input.priorInvalidation;

  if (input.checkpoint) {
    if (input.gapDetected) {
      return {
        valid: false, reason: 'UNRECOVERABLE_FEED_GAP',
        detail: `Feed gap of ${Math.round(input.gapDurationMs / 1000)}s on restart — market data missing`,
      };
    }
    if (!hasContinuousCoverageFromOpen(input.checkpoint)) {
      const from = firstRealDataMs(input.checkpoint) ?? input.startMs;
      return {
        valid: false, reason: 'LATE_SESSION_START',
        detail: `Late start — market data missing from ${fmtIST(input.sessionOriginMs)} to ${fmtIST(from)} IST`,
      };
    }
    return VALID;
  }

  if (input.startMs <= input.sessionOriginMs + LATE_START_GRACE_MS) return VALID;
  return {
    valid: false, reason: 'LATE_SESSION_START',
    detail: `Late start — market data missing from ${fmtIST(input.sessionOriginMs)} to ${fmtIST(input.startMs)} IST`,
  };
}
