/**
 * Worker health state machine (spec §4/§5/§6) and session-quality gate
 * (spec §7). Pure functions over explicit timestamps — no real timers —
 * so the supervision logic itself is deterministic and testable
 * independent of an actual running worker process.
 */

export type WorkerHealthStatus =
  | 'STARTING' | 'CONNECTING' | 'WARMING_UP' | 'HEALTHY' | 'DEGRADED'
  | 'STALE' | 'RECONNECTING' | 'FAILED' | 'MARKET_CLOSED';

export type SessionQuality = 'VALID' | 'DEGRADED' | 'INVALID_FOR_NEW_SIGNAL';

export interface FreshnessInput {
  nowMs: number;
  lastSocketMessageAtMs: number | null;
  isMarketHours: boolean;
  isWarmedUp: boolean;
  /** A material gap (per spec §7) that could have changed the quantile reference, large-order events, G1 or G2. */
  hasUnrecoverableGapThisWeek: boolean;
  /** The depth source's own circuit breaker has tripped (too many consecutive reconnect failures) — it has given up retrying on its own. Optional so existing callers/tests keep compiling unchanged; omitted/false preserves prior behavior exactly. */
  isCircuitBroken?: boolean;
}

const STALE_AFTER_MS = 30_000; // no socket message for 30s during market hours is stale, not merely quiet

/**
 * Determines the worker's health status from raw freshness signals. A
 * disconnected feed is NEVER reported HEALTHY merely because the process
 * itself is alive (spec §4's explicit requirement) — status is derived
 * from `lastSocketMessageAtMs` freshness, never from "the function
 * returned without throwing."
 */
export function deriveHealthStatus(input: FreshnessInput): WorkerHealthStatus {
  if (!input.isMarketHours) return 'MARKET_CLOSED';
  // Checked BEFORE the null-timestamp branch below: a circuit-broken feed
  // has lastSocketMessageAtMs === null too (it never got a tick this
  // generation), but it is NOT "still connecting" — it has given up and
  // needs a human/redeploy, not a dashboard that just says CONNECTING
  // indefinitely.
  if (input.isCircuitBroken) return 'FAILED';
  if (input.lastSocketMessageAtMs === null) return 'CONNECTING';
  const age = input.nowMs - input.lastSocketMessageAtMs;
  if (age > STALE_AFTER_MS) return 'STALE';
  if (!input.isWarmedUp) return 'WARMING_UP';
  return 'HEALTHY';
}

/**
 * Session quality (spec §7): this strategy is path-dependent, so a
 * material data gap invalidates the WHOLE week's signal, not just the
 * moment of the gap — never interpolated, never silently patched over.
 */
export function deriveSessionQuality(status: WorkerHealthStatus, hasUnrecoverableGapThisWeek: boolean): SessionQuality {
  if (hasUnrecoverableGapThisWeek) return 'INVALID_FOR_NEW_SIGNAL';
  if (status === 'HEALTHY') return 'VALID';
  if (status === 'MARKET_CLOSED') return 'VALID'; // no session in progress to invalidate
  return 'DEGRADED';
}

/**
 * Fail-closed rule (spec §5): a signal may only fire when the session is
 * VALID. Exit monitoring of EXISTING positions is a SEPARATE concern —
 * this function answers only "can a NEW signal fire," never "can an
 * existing SHADOW position still be monitored," which the caller must
 * check independently against whatever quote stream remains healthy.
 */
export function canFireNewSignal(quality: SessionQuality): boolean {
  return quality === 'VALID';
}

export interface ReconnectIntegrityInput {
  subscriptionReestablished: boolean;
  newDataFlowing: boolean;
  durableStateRestored: boolean;
  gapDurationMs: number;
  /** A gap longer than this is treated as unrecoverable for THIS week's signal integrity — a deliberately conservative default; tunable by the caller, never silently assumed elsewhere. */
  maxRecoverableGapMs: number;
}

/**
 * Only returns HEALTHY when every post-reconnect integrity condition
 * passes (spec §6, steps 1-5) — otherwise reports the specific failure so
 * the caller can decide whether this week's signal is still valid.
 */
export function evaluateReconnectIntegrity(input: ReconnectIntegrityInput): { healthy: boolean; reason: string | null } {
  if (!input.subscriptionReestablished) return { healthy: false, reason: 'subscription not re-established' };
  if (!input.newDataFlowing) return { healthy: false, reason: 'no new data flowing after reconnect' };
  if (!input.durableStateRestored) return { healthy: false, reason: 'durable state not restored' };
  if (input.gapDurationMs > input.maxRecoverableGapMs) return { healthy: false, reason: `gap of ${input.gapDurationMs}ms exceeds recoverable window` };
  return { healthy: true, reason: null };
}
