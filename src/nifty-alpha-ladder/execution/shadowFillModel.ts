/**
 * Deterministic, conservative SHADOW fill model — spec §24 of the
 * Milestone 3 instructions. Never assumes "marketable limit => instant
 * fill at LTP." A BUY only simulates a fill when the observed ASK is at or
 * below the submitted limit; a SELL only when the observed BID is at or
 * above it — i.e. the order must genuinely be marketable against the real
 * touch at that instant, not merely "through" a stale reference LTP.
 *
 * Exchange queue position (how long you'd wait behind other resting
 * orders at the same price) is NOT modeled — this codebase's market-data
 * granularity (periodic quote/depth snapshots, not a full order-by-order
 * trade tape) cannot support it, and this is stated here rather than
 * silently assumed away. `executionQuality` reflects that limitation
 * honestly: TOUCH_FILL/DEPTH_FILL are optimistic-but-plausible
 * classifications, not a claim of exact queue-accurate simulation.
 */

export interface MarketSnapshot {
  /** Milliseconds since order submission (simulated or real clock — caller's choice). */
  atMs: number;
  bid: number | null;
  ask: number | null;
}

export type FillStatus = 'TOUCH_FILL' | 'DEPTH_FILL' | 'DELAYED_FILL' | 'LIMIT_NOT_MARKETABLE' | 'TIMEOUT';

export interface FillOutcome {
  filled: boolean;
  status: FillStatus;
  fillPrice: number | null;
  fillAtMs: number | null;
  slippageVsReference: number | null;
}

/**
 * `snapshots` must be sorted ascending by `atMs` and represent the market's
 * evolution AFTER the order was submitted. `referencePrice` is the LTP the
 * limit was computed from (for slippage reporting only).
 */
export function simulateFill(
  side: 'BUY' | 'SELL',
  limit: number,
  referencePrice: number,
  snapshots: MarketSnapshot[],
  timeoutMs: number,
): FillOutcome {
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s.atMs > timeoutMs) break;

    const touchPrice = side === 'BUY' ? s.ask : s.bid;
    if (touchPrice == null) continue;

    const marketable = side === 'BUY' ? touchPrice <= limit : touchPrice >= limit;
    if (!marketable) continue;

    const status: FillStatus = i === 0 ? 'TOUCH_FILL' : s.atMs > timeoutMs * 0.5 ? 'DELAYED_FILL' : 'DEPTH_FILL';
    return {
      filled: true,
      status,
      fillPrice: touchPrice,
      fillAtMs: s.atMs,
      slippageVsReference: (side === 'BUY' ? 1 : -1) * (touchPrice - referencePrice),
    };
  }

  // Never crossed within the timeout — a real marketable-limit order in a
  // liquid instrument would almost always fill quickly; a genuine timeout
  // here signals the quoted touch never came back to a tradeable level.
  const everMarketable = snapshots.some((s) => {
    const t = side === 'BUY' ? s.ask : s.bid;
    return t != null && (side === 'BUY' ? t <= limit : t >= limit);
  });
  return {
    filled: false,
    status: everMarketable ? 'TIMEOUT' : 'LIMIT_NOT_MARKETABLE',
    fillPrice: null,
    fillAtMs: null,
    slippageVsReference: null,
  };
}
