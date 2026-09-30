/**
 * The live-to-Milestone-2 seam: accumulates raw depth ticks for the
 * current trading session and, on each scheduled evaluation instant,
 * re-derives G1/G2 knots and calls signalEngine.evaluateSignal — the SAME
 * pure functions Milestone 2 already proved against the PDF's worked
 * example, never duplicated or rewritten here.
 *
 * Deliberately a "recompute from full accumulated history each cycle"
 * design, not an incrementally-optimized streaming engine: at the data
 * volumes one trading session produces (thousands, not millions, of
 * ticks), re-running the pure builders over the full accumulated arrays
 * on every lattice minute is entirely tractable, and it guarantees
 * correctness by construction (there is no separate incremental code path
 * that could silently drift from the batch functions this session already
 * tested). If this ever needs to scale further, that's a Milestone 4+
 * optimization on top of an already-correct baseline, not a prerequisite
 * for one.
 */
import type { DepthLevelObservation, ReferenceThresholdState } from '../types.ts';
import { foldWindow, isLargeOrderLevel, buildLargeOrderEvents, computeG1Knots, empiricalQuantile } from '../signal/largeOrderNet.ts';
import { computeG2Knots } from '../signal/imbalancePath.ts';
import { evaluateSignal, type SignalDecision, type VixRead } from '../signal/signalEngine.ts';
import { THETA } from '../parameters.ts';
import type { AggregateSnapshot } from '../types.ts';

export interface SessionAccumulatorState {
  sessionOriginMs: number;
  rawObservations: DepthLevelObservation[];
  aggregateSnapshots: AggregateSnapshot[];
  referenceThresholds: { b: ReferenceThresholdState; a: ReferenceThresholdState };
  /** Buffered observations since the last completed θ3 reference window, per side — folded in when a window completes. */
  pendingWindowObservations: { b: number[]; a: number[] };
  lastWindowFoldedAtMs: number;
  /** Buffered observations since the last completed θ4 aggregate-imbalance interval. */
  pendingIntervalObservations: DepthLevelObservation[];
  lastIntervalEndMs: number;
}

export function createSessionAccumulator(sessionOriginMs: number): SessionAccumulatorState {
  return {
    sessionOriginMs,
    rawObservations: [],
    aggregateSnapshots: [],
    referenceThresholds: { b: { cumulativeCount: 0, runningThreshold: 0 }, a: { cumulativeCount: 0, runningThreshold: 0 } },
    pendingWindowObservations: { b: [], a: [] },
    lastWindowFoldedAtMs: sessionOriginMs,
    pendingIntervalObservations: [],
    lastIntervalEndMs: sessionOriginMs,
  };
}

const WINDOW_MS = THETA.LARGE_ORDER_REFERENCE_WINDOW_MIN * 60_000;
const INTERVAL_MS = THETA.AGGREGATE_SNAPSHOT_INTERVAL_MIN * 60_000;

/** Ingests one batch of normalized-and-converted observations (already through toDepthLevelObservation), rolling any completed θ3/θ4 windows into durable state as it goes. Mutates and returns the same state object for simplicity — callers own the object's lifetime. */
export function ingest(state: SessionAccumulatorState, observations: DepthLevelObservation[], nowMs: number): SessionAccumulatorState {
  state.rawObservations.push(...observations);
  for (const obs of observations) {
    state.pendingWindowObservations[obs.side].push(obs.quantity);
    state.pendingIntervalObservations.push(obs);
  }

  // Fold completed θ3 reference windows (Definition 13.3) — using only
  // observations from BEFORE this window closes, never the observation
  // being classified right now (predictability, per Definition 13.3's own
  // requirement).
  while (nowMs - state.lastWindowFoldedAtMs >= WINDOW_MS) {
    for (const side of ['b', 'a'] as const) {
      const sizes = state.pendingWindowObservations[side];
      if (sizes.length > 0) {
        const quantile = empiricalQuantile(sizes);
        state.referenceThresholds[side] = foldWindow(state.referenceThresholds[side], { windowCount: sizes.length, windowQuantile: quantile });
      }
    }
    state.pendingWindowObservations = { b: [], a: [] };
    state.lastWindowFoldedAtMs += WINDOW_MS;
  }

  // Complete θ4 aggregate-imbalance intervals (Definition 2.6).
  while (nowMs - state.lastIntervalEndMs >= INTERVAL_MS) {
    const intervalEnd = state.lastIntervalEndMs + INTERVAL_MS;
    const inInterval = state.pendingIntervalObservations.filter((o) => o.timestampMs <= intervalEnd);
    // Admission: a level is admitted each time its price is first seen in
    // the interval or its (quantity, orderCount) differs from the last
    // admitted state at that price (Definition 2.6) — tracked per side+price.
    const lastAdmitted = new Map<string, { quantity: number; orderCount: number }>();
    let bidQty = 0;
    let askQty = 0;
    for (const obs of inInterval) {
      const key = `${obs.side}|${obs.price}`;
      const prior = lastAdmitted.get(key);
      const changed = !prior || prior.quantity !== obs.quantity || prior.orderCount !== obs.orderCount;
      if (changed) {
        lastAdmitted.set(key, { quantity: obs.quantity, orderCount: obs.orderCount });
        if (obs.side === 'b') bidQty += obs.quantity; else askQty += obs.quantity;
      }
    }
    state.aggregateSnapshots.push({ timeSec: (intervalEnd - state.sessionOriginMs) / 1000, bidQty, askQty });
    state.pendingIntervalObservations = state.pendingIntervalObservations.filter((o) => o.timestampMs > intervalEnd);
    state.lastIntervalEndMs = intervalEnd;
  }

  return state;
}

const thresholdAt = (state: SessionAccumulatorState) => (side: 'b' | 'a') => state.referenceThresholds[side];

/** Re-derives the current G1/G2 knot series from everything accumulated so far and evaluates the signal — identical math to Milestone 2's fixture-driven tests, now fed by live-accumulated data. */
export function evaluateCurrentSignal(state: SessionAccumulatorState, nowSec: number, cutoffSec: number, vix: VixRead): SignalDecision {
  const events = buildLargeOrderEvents(state.rawObservations, (side) => thresholdAt(state)(side));
  const g1Knots = computeG1Knots(events, state.sessionOriginMs);
  const g2Knots = computeG2Knots(state.aggregateSnapshots);
  return evaluateSignal({ g1Knots, g2Knots, nowSec, cutoffSec, vix });
}
