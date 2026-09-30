/**
 * Feature 1 — cumulative large-order net (G1). Spec §5 Eq (4.1)/(4.2),
 * Definition 2.2 (large-order event) and Definition 13.3 (reference-
 * threshold recursion).
 */
import type { DepthLevelObservation, LargeOrderEvent, PathKnot, ReferenceThresholdState, WindowQuantileObservation } from '../types.ts';
import { THETA } from '../parameters.ts';
import { signedArea } from './signedArea.ts';

// ---------------------------------------------------------------------------
// Definition 13.3 — reference threshold as a recursive estimator
// ---------------------------------------------------------------------------

export function initialReferenceThreshold(): ReferenceThresholdState {
  return { cumulativeCount: 0, runningThreshold: 0 };
}

/** Eq (13.2): fold one completed window's (n_m, ξ_m^σ) into the running count-weighted average. */
export function foldWindow(state: ReferenceThresholdState, window: WindowQuantileObservation): ReferenceThresholdState {
  const { cumulativeCount: N, runningThreshold: qHat } = state;
  const nextN = N + window.windowCount;
  const nextQHat = nextN === 0 ? 0 : (N * qHat + window.windowCount * window.windowQuantile) / nextN;
  return { cumulativeCount: nextN, runningThreshold: nextQHat };
}

/** Classification is active only once ≥ θ2 level observations have been folded in. */
export function isThresholdActive(state: ReferenceThresholdState): boolean {
  return state.cumulativeCount >= THETA.LARGE_ORDER_WARMUP_COUNT;
}

/** A depth level (p, x, n) is a large-order level iff x > q̂_σ(t) and the threshold is active. */
export function isLargeOrderLevel(displayedQuantity: number, state: ReferenceThresholdState): boolean {
  return isThresholdActive(state) && displayedQuantity > state.runningThreshold;
}

/**
 * The θ1-quantile (0.85) of a window's displayed level sizes — the empirical
 * quantile ξ_m^σ that Definition 13.3 folds into the recursive estimator.
 * Nearest-rank method: given a non-empty sorted sample, index
 * ⌈quantile · n⌉ − 1, clamped to [0, n−1].
 */
export function empiricalQuantile(sizes: number[], quantile: number = THETA.LARGE_ORDER_QUANTILE): number {
  if (sizes.length === 0) return 0;
  const sorted = [...sizes].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Definition 2.2 — large-order event detection and minute-merge
// ---------------------------------------------------------------------------

interface LevelState {
  quantity: number;
  orderCount: number;
}

/**
 * Builds the merged, minute-stamped large-order event stream from a raw
 * ordered stream of depth-level observations, given a threshold-state
 * provider for each side (already warmed up / not — callers control that
 * via `thresholds`). Change detection is per (side, price): a level is
 * only re-emitted when it is new at that price, or its (quantity,
 * orderCount) pair differs from the last admitted state — a disappeared
 * level is forgotten, so its reappearance is a brand-new event, never a
 * continuation.
 *
 * `observations` must be sorted ascending by timestampMs. `thresholds`
 * provides the read-only reference threshold applicable at each
 * observation's time (the estimator's own evolution over the session is
 * the caller's concern — this function only classifies and merges, exactly
 * mirroring the PDF's separation of 𝒬_σ/𝒟/𝓜 as independent operators).
 */
export function buildLargeOrderEvents(
  observations: DepthLevelObservation[],
  thresholdAt: (side: 'b' | 'a', timestampMs: number) => ReferenceThresholdState,
): LargeOrderEvent[] {
  const lastStateByKey = new Map<string, LevelState>();
  // side|minuteStartMs -> aggregated (quantity, orderCount)
  const perMinute = new Map<string, LargeOrderEvent>();

  for (const obs of observations) {
    const key = `${obs.side}|${obs.price}`;
    const threshold = thresholdAt(obs.side, obs.timestampMs);
    const large = isLargeOrderLevel(obs.quantity, threshold);
    const prior = lastStateByKey.get(key);

    if (!large) {
      // A level that drops below threshold (or was never large) is not a
      // large-order level right now — forget any prior state so a later
      // reappearance above threshold is treated as new, per Definition 2.2.
      lastStateByKey.delete(key);
      continue;
    }

    const changed = !prior || prior.quantity !== obs.quantity || prior.orderCount !== obs.orderCount;
    lastStateByKey.set(key, { quantity: obs.quantity, orderCount: obs.orderCount });
    if (!changed) continue;

    const minuteStartMs = Math.floor(obs.timestampMs / 60_000) * 60_000;
    const mergeKey = `${obs.side}|${minuteStartMs}`;
    const existing = perMinute.get(mergeKey);
    if (existing) {
      existing.quantity += obs.quantity;
      existing.orderCount += obs.orderCount;
    } else {
      perMinute.set(mergeKey, { side: obs.side, timestampMs: minuteStartMs, quantity: obs.quantity, orderCount: obs.orderCount });
    }
  }

  return [...perMinute.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

// ---------------------------------------------------------------------------
// Eq (4.1) — G1 knots, and its signed area 𝒜1
// ---------------------------------------------------------------------------

/**
 * G1(s_j) = Σ_{r≤j} (b_r − a_r) — merges bid and ask events sharing a stored
 * timestamp (already whole minutes) into one signed net-quantity knot per
 * distinct timestamp, then cumulatively sums. `events` need not be sorted;
 * `sessionOriginMs` is the epoch used as t=0 for the seconds-based area
 * calculation (only differences matter — pick any fixed origin, e.g. session
 * open, consistently for a given day).
 */
export function computeG1Knots(events: LargeOrderEvent[], sessionOriginMs: number): PathKnot[] {
  const byTimestamp = new Map<number, { bid: number; ask: number }>();
  for (const e of events) {
    const entry = byTimestamp.get(e.timestampMs) ?? { bid: 0, ask: 0 };
    if (e.side === 'b') entry.bid += e.quantity;
    else entry.ask += e.quantity;
    byTimestamp.set(e.timestampMs, entry);
  }
  const timestamps = [...byTimestamp.keys()].sort((a, b) => a - b);
  let cumulative = 0;
  return timestamps.map((ts) => {
    const { bid, ask } = byTimestamp.get(ts)!;
    cumulative += bid - ask;
    return { timeSec: (ts - sessionOriginMs) / 1000, value: cumulative };
  });
}

/** 𝒜1(u): the signed time-integral of G1 up to instant u (seconds since sessionOriginMs). */
export function computeG1Area(knots: PathKnot[], uSec: number): number {
  return signedArea(knots, uSec);
}
