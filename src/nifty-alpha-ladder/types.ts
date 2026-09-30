/**
 * Domain types for Nifty Alpha Ladder (hedged133), mirroring the notation of
 * NIFTY_ALPHA_LADDER_SPEC_RECONSTRUCTION.md section-for-section so the code
 * reads like the formulas. Milestone 2 scope only: no execution-mode-specific
 * types here (SHADOW/AUTO differ only in the execution layer, not here) and
 * no live-data-connection types (those are Milestone 3).
 */

/** Definition 2.4 — direction encoding. 0 = NEUTRAL/unresolved. */
export type SignedDirection = -1 | 0 | 1;

/** A fully resolved family direction (Variation C output) is never neutral. */
export type Direction = -1 | 1;

export type OptionRight = 'CE' | 'PE';
export type LegSide = 'BUY' | 'SELL';

/** Which of the two execution modes eventually runs a resolved decision — this type exists purely so downstream (Milestone 3+) execution code has something to switch on; nothing in Milestone 2 reads or produces it. Spec §1 of the implementation plan: PAPER does not exist for this strategy. */
export type ExecutionMode = 'SHADOW' | 'AUTO';

// ---------------------------------------------------------------------------
// Section 3 — Notation and information set
// ---------------------------------------------------------------------------

/** A raw depth-level observation on one side of the book at one instant (Definition 2.2's (p, x, n) at time t). */
export interface DepthLevelObservation {
  side: 'b' | 'a';
  price: number;
  /** Displayed quantity x. */
  quantity: number;
  /** Order count n. */
  orderCount: number;
  /** Epoch milliseconds. */
  timestampMs: number;
}

/** A merged large-order event (Definition 2.2): same side+price+clock-minute observations summed and stamped at the minute start. */
export interface LargeOrderEvent {
  side: 'b' | 'a';
  /** Whole-minute epoch milliseconds (start of the minute). */
  timestampMs: number;
  quantity: number;
  orderCount: number;
}

/** One knot of a piecewise-constant path (G1 on the minute grid, G2 on the aggregation grid) — time in seconds for area integration per spec Eq 4.2. */
export interface PathKnot {
  /** Seconds since session open (or any common, monotonic origin — only differences matter). */
  timeSec: number;
  value: number;
}

/** Definition 13.3 — the recursive count-weighted reference-threshold estimator's state for one side. */
export interface ReferenceThresholdState {
  /** N^(m): cumulative number of level observations folded in so far. */
  cumulativeCount: number;
  /** q̂_σ^(m): the running count-weighted average of window quantiles. */
  runningThreshold: number;
}

/** One aggregation-window's contribution before folding into ReferenceThresholdState (Eq 13.2's n_m, ξ_m^σ). */
export interface WindowQuantileObservation {
  /** n_m: number of level observations in this window. */
  windowCount: number;
  /** ξ_m^σ: the empirical θ₁-quantile of displayed level size within this window. */
  windowQuantile: number;
}

/** Definition 2.6 — one aggregate-book snapshot (B_k, A_k, t_k). */
export interface AggregateSnapshot {
  /** t_k: interval-end time, seconds since session open. */
  timeSec: number;
  /** B_k: aggregate admitted bid quantity. */
  bidQty: number;
  /** A_k: aggregate admitted ask quantity. */
  askQty: number;
}

// ---------------------------------------------------------------------------
// Section 4 — Universe and instrument selection
// ---------------------------------------------------------------------------

/** Definition 3.4 — one declared leg of the bearish-orientation template. */
export interface LegTemplateEntry {
  /** o_i: offset in strike steps from ATM (bearish orientation values, as declared). */
  offsetSteps: number;
  /** u_i: unit ratio. */
  ratio: number;
  side: LegSide;
}

/** A leg resolved to an actual strike/expiry/type for a given direction (Eq 3.1's 𝓡(D,d,S) — the per-leg output). */
export interface ResolvedLeg {
  strike: number;
  expiry: string; // ISO date (YYYY-MM-DD)
  right: OptionRight;
  side: LegSide;
  ratio: number;
}

// ---------------------------------------------------------------------------
// Section 5 — Signal construction
// ---------------------------------------------------------------------------

export type SignalPath = 'crossing' | 'cutoff';

/** The full persisted signal record (spec §5, "Signal persistence" — the exact field list the PDF requires persisted before any call is created). */
export interface SignalRecord {
  /** κ(d): the Wednesday-of-week idempotency key (ISO date), even on a Thursday fallback. */
  weekKey: string;
  /** The actual signal date (Wednesday, or Thursday on fallback). */
  signalDate: string;
  /** τ*, seconds since session open. */
  signalInstantSec: number;
  path: SignalPath;
  d1: SignedDirection;
  d2: SignedDirection;
  alpha: 0 | 1;
  baseDirection: Direction;
  finalDirection: Direction;
  area1: number;
  area2: number;
  /** G1(τ*) — the level, not the area, kept for record completeness. */
  g1AtSignal: number;
  /** G2(τ*) — the level, kept for record completeness. */
  g2AtSignal: number;
  /** Crossing timestamp, seconds since session open — only meaningful on the crossing path. */
  crossingTimeSec: number | null;
  /** G2 value at the crossing — only meaningful on the crossing path. */
  crossingG2Value: number | null;
  vixValue: number | null;
  vixAvailable: boolean;
  variationCActed: boolean;
  /** Which source fed the large-order / imbalance series this week — see Ambiguity A1 / FUTURES_DEPTH_FALLBACK_MODE. */
  sourceDataset: 'primary' | 'futures-fallback';
  createdAtMs: number;
}

// ---------------------------------------------------------------------------
// Section 7 — Position construction and sizing / payoff
// ---------------------------------------------------------------------------

export interface PayoffResult {
  /** ₹, for the whole sized position (units × lot size already applied). */
  maxLoss: number;
  maxGain: number;
  tailValue: number;
  /** Absolute index levels (A applied) — one or two depending on the debit (Proposition 6.3). */
  breakEvens: number[];
}

export interface SizingResult {
  units: number;
  mode: 'unit' | 'quantity';
}
