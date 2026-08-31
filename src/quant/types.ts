/**
 * Phase 1 — Option chain data model.
 *
 * Design rules:
 *  - Nothing here knows about a broker, an exchange or a UI.
 *  - Greeks that came *from the provider* are kept strictly separate from
 *    Greeks *we computed*. They are never merged into one field.
 *  - Every numeric field that can legitimately be absent is `null`, never 0.
 *    A missing IV is not an IV of zero.
 */

export type Right = 'CE' | 'PE';

/** Epoch milliseconds, UTC. All timestamps in the system are this. */
export type EpochMs = number;

/**
 * Instrument-level contract metadata. Lot size / multiplier is deliberately
 * NOT hard-coded anywhere in the engine: NIFTY's lot size has changed several
 * times (25 -> 50 -> 75) and any hard-coded value silently corrupts every
 * P&L, margin and position-sizing number downstream.
 */
export interface ContractSpec {
  /** e.g. 'NIFTY' */
  underlyingSymbol: string;
  /** Contracts per lot. Must be supplied by the caller/config. */
  lotSize: number;
  /** Currency multiplier per index point per unit. Usually 1 for NIFTY. */
  pointValue: number;
  /** Strike step, used for sanity checks (NIFTY weekly = 50). */
  strikeStep: number;
  currency: string;
  /** European or American exercise. Index options in India are European. */
  exerciseStyle: 'european' | 'american';
  /**
   * Whether the option settles against a futures price (Black-76) or a cash
   * spot price (Black-Scholes-Merton). NIFTY options are quoted against the
   * synthetic forward, so 'futures' is correct even though the index is cash
   * settled.
   */
  pricingBasis: 'futures' | 'spot';
}

/** Greeks in raw (per-unit-of-1) form. Presentation scaling happens in the UI. */
export interface Greeks {
  /** dPrice/dUnderlying, per 1 point. */
  delta: number | null;
  /** d2Price/dUnderlying^2, per 1 point. */
  gamma: number | null;
  /** dPrice/dTime, per CALENDAR DAY (negative for long options). */
  theta: number | null;
  /** dPrice/dVol, per 1.00 of vol (i.e. per 100 vol points). */
  vega: number | null;
  /** dPrice/dRate, per 1.00 of rate. Optional. */
  rho?: number | null;
}

export const EMPTY_GREEKS: Greeks = {
  delta: null,
  gamma: null,
  theta: null,
  vega: null,
  rho: null,
};

/** Where a Greek/IV number came from. Surfaced in the UI; never collapsed. */
export type ValueSource = 'observed' | 'model' | 'unavailable';

/**
 * A single normalised option quote. This is the ONLY shape the rest of the
 * engine consumes. Adapters convert provider payloads into this.
 */
export interface OptionQuote {
  symbol: string;
  right: Right;
  strike: number;
  /** Expiry at exchange close, epoch ms UTC. */
  expiry: EpochMs;
  /** Quote timestamp, epoch ms UTC. Used for staleness detection. */
  asOf: EpochMs;

  bid: number | null;
  ask: number | null;
  last: number | null;
  /** Settlement/close price. Present in EOD bhavcopy data, absent intraday. */
  settle: number | null;

  openInterest: number | null;
  /** Change in OI vs previous session, if the provider gives it. */
  oiChange: number | null;
  volume: number | null;

  /** IV as reported by the provider, decimal (0.14 = 14%). Often absent. */
  observedIv: number | null;
  /** Greeks as reported by the provider. Usually all null for Indian feeds. */
  observedGreeks: Greeks;
}

/** Everything needed to price a chain, independent of the quotes themselves. */
export interface PricingContext {
  /** Cash/spot price of the underlying index. */
  spot: number | null;
  /**
   * Futures price for this expiry, if a matching future exists. Preferred over
   * spot. If absent, the engine derives a synthetic forward via put-call parity.
   */
  futures: number | null;
  /** Continuously compounded risk-free rate, decimal. */
  riskFreeRate: number;
  /** Continuous dividend yield, decimal. Only used when pricingBasis='spot'. */
  dividendYield: number;
  /** Valuation time, epoch ms UTC. Normally = chain.asOf. */
  valuationTime: EpochMs;
}

/** A normalised chain for ONE expiry. Multi-expiry work composes these. */
export interface ExpirySlice {
  expiry: EpochMs;
  quotes: OptionQuote[];
}

export interface OptionChain {
  contract: ContractSpec;
  asOf: EpochMs;
  context: PricingContext;
  slices: ExpirySlice[];
  /** Free-form provenance: provider id, file name, request params. */
  source: ChainSource;
}

export interface ChainSource {
  providerId: string;
  /** 'live' | 'delayed' | 'eod' | 'historical' — affects what we allow. */
  kind: 'live' | 'delayed' | 'eod' | 'historical';
  retrievedAt: EpochMs;
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Enriched (post Phase-2) shapes                                      */
/* ------------------------------------------------------------------ */

export interface EnrichedQuote {
  quote: OptionQuote;

  /** Mid of bid/ask when both sides are valid, else null. */
  mid: number | null;
  /** Absolute bid-ask spread. */
  spread: number | null;
  /** Spread as a fraction of mid. Null when mid is null or <= 0. */
  spreadPct: number | null;
  /**
   * The price the pricing engine actually used to solve for IV. Prefers mid,
   * falls back to settle, then last. Recorded so the UI can show it.
   */
  markPrice: number | null;
  markPriceSource: 'mid' | 'settle' | 'last' | 'none';

  /** Time to expiry in years, ACT/365. Can be 0 on expiry day. */
  timeToExpiry: number;

  /** Resolved IV: provider's if present, otherwise solved from markPrice. */
  iv: number | null;
  ivSource: ValueSource;

  /** Greeks the engine will use downstream, with provenance. */
  greeks: Greeks;
  greeksSource: ValueSource;

  /** Model Greeks always computed when IV is solvable, even if provider gave its own. */
  modelGreeks: Greeks;

  /** Moneyness relative to the forward: ln(F/K). */
  logMoneyness: number | null;
  /** Signed distance from forward in index points (F - K). */
  distanceFromForward: number | null;

  /** Populated by the validator. Empty array = clean. */
  issues: DataIssue[];
}

export interface EnrichedSlice {
  expiry: EpochMs;
  timeToExpiry: number;
  /** Forward used for pricing this expiry, and how we got it. */
  forward: number;
  forwardSource: 'futures' | 'parity' | 'spot-carry';
  atmStrike: number | null;
  quotes: EnrichedQuote[];
}

export interface EnrichedChain {
  contract: ContractSpec;
  asOf: EpochMs;
  context: PricingContext;
  source: ChainSource;
  slices: EnrichedSlice[];
  issues: DataIssue[];
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type IssueSeverity = 'fatal' | 'error' | 'warn' | 'info';

export type IssueCode =
  | 'MISSING_PRICE'
  | 'NON_POSITIVE_PRICE'
  | 'CROSSED_QUOTE'
  | 'WIDE_SPREAD'
  | 'STALE_QUOTE'
  | 'MISSING_IV'
  | 'IMPLAUSIBLE_IV'
  | 'IV_UNSOLVABLE'
  | 'IV_ILL_CONDITIONED'
  | 'ARBITRAGE_BOUND_VIOLATION'
  | 'MISSING_GREEKS'
  | 'IMPLAUSIBLE_GREEK'
  | 'OBSERVED_MODEL_GREEK_DIVERGENCE'
  | 'ZERO_OPEN_INTEREST'
  | 'ZERO_VOLUME'
  | 'EXPIRY_IN_PAST'
  | 'EXPIRY_MISMATCH'
  | 'OFF_GRID_STRIKE'
  | 'DUPLICATE_QUOTE'
  | 'MISSING_UNDERLYING_PRICE'
  | 'NO_FORWARD_AVAILABLE'
  | 'INVALID_LOT_SIZE'
  | 'SPARSE_CHAIN';

export interface DataIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** Identifies the offending contract, when the issue is quote-level. */
  ref?: { right: Right; strike: number; expiry: EpochMs };
  /** Observed value that triggered the issue, for display. */
  value?: number | string | null;
}

/**
 * A quote carrying a 'fatal' issue must never reach the strategy engine.
 * This predicate is the single gate.
 */
export function isUsable(q: EnrichedQuote): boolean {
  return !q.issues.some((i) => i.severity === 'fatal');
}
