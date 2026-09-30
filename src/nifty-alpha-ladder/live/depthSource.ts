/**
 * The live depth-source abstraction (spec §2 of the Milestone 3
 * instructions) — so a future proprietary/primary source can replace the
 * current NIFTY_NEAREST_FUTURE/FUTURES_DEPTH_FALLBACK_MODE provider
 * without touching G1/G2 mathematics at all. Provider adapters implement
 * this interface; Milestone-2's signal engine never sees it directly (it
 * only ever receives already-built PathKnot[] series).
 */
import type { DepthLevelObservation } from '../types.ts';

export type WorkerHealthStatus =
  | 'STARTING' | 'CONNECTING' | 'WARMING_UP' | 'HEALTHY' | 'DEGRADED'
  | 'STALE' | 'RECONNECTING' | 'FAILED' | 'MARKET_CLOSED';

export interface DepthSourceHealth {
  status: WorkerHealthStatus;
  connectionGeneration: number;
  lastSocketMessageAtMs: number | null;
  reconnectCount: number;
}

export interface ResolvedInstrument {
  tradingsymbol: string;
  instrumentToken: number;
  expiry: string;
}

/**
 * A single depth observation, normalized (spec §9): every field the broker
 * actually provided, nothing synthesized. `orderCount` is `null` (never 0)
 * when the provider genuinely doesn't supply it — a capability mismatch,
 * flagged explicitly rather than silently defaulted, since a fabricated 0
 * would corrupt Definition 2.2's change-detection semantics (a real
 * order-count change from 1->0 is meaningful; a fabricated 0 is not).
 */
export interface NormalizedDepthTick {
  timestampExchangeMs: number | null;
  timestampReceivedMs: number;
  instrumentToken: number;
  side: 'b' | 'a';
  price: number;
  quantity: number;
  orderCount: number | null;
  levelIndex: number;
}

export interface AlphaLadderDepthSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(instrument: ResolvedInstrument): Promise<void>;
  getHealth(): DepthSourceHealth;
  onDepthSnapshot(handler: (ticks: NormalizedDepthTick[]) => void): void;
}

/** Converts a single raw DepthLevelObservation (Milestone-2's own shape) FROM a NormalizedDepthTick — the seam between "what the broker gave us" and "what Milestone-2's large-order/imbalance builders consume." Throws if orderCount is null, since Milestone-2's type requires a number — the caller (the worker) must decide what "capability mismatch" means for classification (e.g. skip large-order detection for that side entirely) rather than this function silently defaulting to 0. */
export function toDepthLevelObservation(tick: NormalizedDepthTick): DepthLevelObservation {
  if (tick.orderCount === null) {
    throw new Error('toDepthLevelObservation: orderCount capability mismatch — the provider does not supply order counts; do not default to 0 (see depthSource.ts header).');
  }
  return {
    side: tick.side,
    price: tick.price,
    quantity: tick.quantity,
    orderCount: tick.orderCount,
    timestampMs: tick.timestampExchangeMs ?? tick.timestampReceivedMs,
  };
}
