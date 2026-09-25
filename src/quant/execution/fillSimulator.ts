/**
 * The canonical PAPER/BACKTEST simulated execution model (QUANT_AUDIT.md
 * Phase A, Task 2) — replaces paperFill.ts's single, undisclosed-elsewhere
 * assumption ("every leg fills instantly at its quoted price") with three
 * explicit, named modes so a result can never be read as "expected live
 * performance" without saying which assumption produced it.
 *
 * IDEAL:      approximately midpoint, zero slippage. Theoretical ceiling
 *             only — see this file's own guard in describeFillMode().
 * REALISTIC:  BUY moves toward ask, SELL moves toward bid, scaled by
 *             configurable spread/liquidity/latency assumptions. The
 *             default for new research.
 * STRESS:     REALISTIC's assumptions widened further, plus adverse
 *             movement between legs and execution delay.
 *
 * Deliberately does NOT invent a bid/ask where the historical source has
 * none — EOD bhavcopy data (this engine's primary historical source, see
 * bhavcopy.ts) carries only a settlement price. When no real bid/ask
 * exists, this module returns settlement-based fills UNCHANGED and labels
 * the result's execution-data quality as EOD_APPROXIMATION rather than
 * silently presenting a settlement print as if it were a live executable
 * spread.
 */

export type FillMode = 'IDEAL' | 'REALISTIC' | 'STRESS';

export type ExecutionDataQuality = 'LIVE_QUOTE' | 'EOD_APPROXIMATION';

export interface LegQuote {
  side: 'BUY' | 'SELL';
  tradingsymbol: string;
  /** Null when the historical source has no live bid/ask (e.g. EOD bhavcopy) — never fabricated. */
  bid: number | null;
  ask: number | null;
  /** Settlement/mid/last — whatever markPrice basis was actually used to build the candidate. Always present. */
  referencePrice: number;
  /** Real spread as a fraction of referencePrice, when bid/ask exist. Null otherwise (EOD data has no spread to read). */
  spreadPct: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface FillSimulatorConfig {
  mode: FillMode;
  /**
   * REALISTIC: how far toward the adverse side of the spread a fill lands,
   * as a fraction of the (assumed-or-real) spread — 0 = exactly at
   * referencePrice, 1 = exactly at the far touch (ask for a BUY, bid for a
   * SELL). Applied on top of a real spread when one exists, or on top of
   * `assumedSpreadPctWhenUnknown` when it doesn't.
   */
  realisticSpreadFraction: number;
  /** Assumed spread (fraction of referencePrice) when the historical source has no real bid/ask — an EOD_APPROXIMATION-only input, never applied when a real spread is known. */
  assumedSpreadPctWhenUnknown: number;
  /** Additional slippage, in rupees per unit, added on top of the spread-based fill — models latency/impact beyond the quoted spread itself. */
  additionalSlippagePerUnit: number;
  /** Milliseconds of assumed latency between decision and fill — recorded for reporting; does not itself move the price in this synchronous simulator, but STRESS uses it to size adverse-movement slippage. */
  latencyMs: number;
  /** STRESS only: extra multiplicative widening applied to the spread fraction on top of realisticSpreadFraction. */
  stressSpreadMultiplier: number;
  /** STRESS only: extra flat slippage per unit added on top of additionalSlippagePerUnit. */
  stressExtraSlippagePerUnit: number;
  /** STRESS only: assumed adverse move (rupees) applied to legs filled LATER in a multi-leg sequence, modeling the underlying moving against you between legs. */
  stressLeggingAdverseMovePerLeg: number;
  /** Liquidity-based execution quality penalty: legs with OI/volume below these thresholds get an extra multiplicative slippage penalty (openInterestFloor/volumeFloor from config.ts's own dataQuality thresholds by default). */
  minOpenInterestForFullLiquidity: number;
  minVolumeForFullLiquidity: number;
  /** Multiplies the effective slippage fraction when a leg is below the liquidity floor above — 1.5 means 50% worse execution on a thin leg. */
  illiquidLegSlippageMultiplier: number;
}

export const IDEAL_CONFIG: FillSimulatorConfig = {
  mode: 'IDEAL',
  realisticSpreadFraction: 0, assumedSpreadPctWhenUnknown: 0, additionalSlippagePerUnit: 0,
  latencyMs: 0, stressSpreadMultiplier: 1, stressExtraSlippagePerUnit: 0, stressLeggingAdverseMovePerLeg: 0,
  minOpenInterestForFullLiquidity: 500, minVolumeForFullLiquidity: 100, illiquidLegSlippageMultiplier: 1,
};

export const REALISTIC_CONFIG: FillSimulatorConfig = {
  mode: 'REALISTIC',
  // Mid-of-the-adverse-half: a real order rarely gets the full touch price
  // instantly, but rarely gets the exact mid either — 0.5 of the spread is
  // a commonly-cited rule-of-thumb starting assumption for a marketable
  // limit order on a liquid contract, stated plainly so it can be argued
  // with (same posture as this engine's other provisional defaults).
  realisticSpreadFraction: 0.5,
  assumedSpreadPctWhenUnknown: 0.02, // 2% of price — a stated, conservative EOD-only assumption, not a measurement
  additionalSlippagePerUnit: 0,
  latencyMs: 800,
  stressSpreadMultiplier: 1, stressExtraSlippagePerUnit: 0, stressLeggingAdverseMovePerLeg: 0,
  minOpenInterestForFullLiquidity: 500, minVolumeForFullLiquidity: 100, illiquidLegSlippageMultiplier: 1.5,
};

export const STRESS_CONFIG: FillSimulatorConfig = {
  mode: 'STRESS',
  realisticSpreadFraction: 0.8, // most of the way to the far touch
  assumedSpreadPctWhenUnknown: 0.05,
  additionalSlippagePerUnit: 0,
  latencyMs: 3000,
  stressSpreadMultiplier: 1.75,
  stressExtraSlippagePerUnit: 0,
  stressLeggingAdverseMovePerLeg: 0, // set per-leg-index at call time (see simulateFill's stress branch)
  minOpenInterestForFullLiquidity: 500, minVolumeForFullLiquidity: 100, illiquidLegSlippageMultiplier: 2.5,
};

export function configFor(mode: FillMode): FillSimulatorConfig {
  return mode === 'IDEAL' ? IDEAL_CONFIG : mode === 'STRESS' ? STRESS_CONFIG : REALISTIC_CONFIG;
}

/**
 * SHADOW_EXECUTION_V1 (live-data-capture phase, Task 6) — SHADOW mode's
 * fill model. Structurally identical to REALISTIC_CONFIG today (same
 * spread-fraction assumption), but named and exported SEPARATELY so it
 * can diverge without touching REALISTIC_V1: SHADOW always simulates
 * against REAL, live bid/ask captured at decision time (never
 * EOD-approximated), so once enough observed SHADOW fills exist
 * (empiricalExecutionModel.ts), THIS config is the one that should get
 * replaced by a calibrated version — REALISTIC_V1 stays the historical-
 * backtest assumption for comparison, per this phase's explicit
 * instruction not to overwrite it.
 */
export const SHADOW_EXECUTION_V1: FillSimulatorConfig = { ...REALISTIC_CONFIG };

export interface SimulatedFill {
  tradingsymbol: string;
  side: 'BUY' | 'SELL';
  /** The price a "fair value" read would have quoted — mid, or the historical reference price when no real bid/ask exists. */
  decisionPrice: number;
  /** The price actually submitted at (before any further adverse-movement/legging adjustment). */
  submittedPrice: number;
  /** The final simulated fill price, after spread + slippage + (STRESS only) legging adjustment. */
  filledPrice: number;
  slippageRupees: number;
  slippageBps: number;
  spreadAtEntryPct: number | null;
  latencyMs: number;
  executionDataQuality: ExecutionDataQuality;
  /** Never null in this simulator (unlike a real broker) — a fill/partial-fill/rejection concept belongs to liveFill.ts, not the paper/backtest model. Retained for interface parity with a future non-fill scenario. */
  filled: true;
}

/** True when the underlying quote provides a genuine two-sided price (live data or a source that models bid/ask) rather than a single settlement print. */
function hasRealSpread(q: LegQuote): boolean {
  return q.bid !== null && q.ask !== null && q.bid > 0 && q.ask > 0;
}

/**
 * Simulates ONE leg's fill under the given mode/config. `legIndexInSequence`
 * (0-based, in execution order — BUY-before-SELL, matching liveFill.ts's
 * own real sequencing) is used only by STRESS to apply adverse movement to
 * legs filled later in a multi-leg structure, modeling the underlying
 * moving against you while earlier legs were still being placed.
 */
export function simulateFill(
  quote: LegQuote,
  config: FillSimulatorConfig,
  legIndexInSequence = 0,
): SimulatedFill {
  const executionDataQuality: ExecutionDataQuality = hasRealSpread(quote) ? 'LIVE_QUOTE' : 'EOD_APPROXIMATION';
  const decisionPrice = quote.referencePrice;

  let effectiveSpreadPct: number;
  let bid: number, ask: number;
  if (hasRealSpread(quote)) {
    bid = quote.bid!; ask = quote.ask!;
    effectiveSpreadPct = quote.spreadPct ?? ((ask - bid) / decisionPrice);
  } else {
    // No real spread to read (EOD_APPROXIMATION) — model one from the
    // configured assumption rather than pretending settlement == mid == a
    // zero-spread executable price.
    effectiveSpreadPct = config.assumedSpreadPctWhenUnknown;
    bid = decisionPrice * (1 - effectiveSpreadPct / 2);
    ask = decisionPrice * (1 + effectiveSpreadPct / 2);
  }

  const illiquid = (quote.openInterest !== null && quote.openInterest < config.minOpenInterestForFullLiquidity) ||
    (quote.volume !== null && quote.volume < config.minVolumeForFullLiquidity);
  const liquidityMultiplier = illiquid ? config.illiquidLegSlippageMultiplier : 1;

  const spreadFraction = Math.min(1, config.realisticSpreadFraction * config.stressSpreadMultiplier) * liquidityMultiplier;
  const halfSpread = (ask - bid) / 2;
  // BUY moves toward ask; SELL moves toward bid — both scaled by
  // spreadFraction, so IDEAL (spreadFraction effectively 0) lands at mid.
  const spreadAdjustment = quote.side === 'BUY' ? halfSpread * spreadFraction : -halfSpread * spreadFraction;
  let submittedPrice = decisionPrice + spreadAdjustment;

  const flatSlippage = (config.additionalSlippagePerUnit + config.stressExtraSlippagePerUnit) * liquidityMultiplier;
  submittedPrice += quote.side === 'BUY' ? flatSlippage : -flatSlippage;

  // STRESS-only: a later leg in the sequence has had more time for the
  // underlying to move against the structure — modeled as a monotonically
  // growing adverse adjustment by leg index, never favorable.
  const leggingAdjustment = config.stressLeggingAdverseMovePerLeg * legIndexInSequence;
  const filledPrice = Math.max(0.05, submittedPrice + (quote.side === 'BUY' ? leggingAdjustment : -leggingAdjustment));

  const slippageRupees = quote.side === 'BUY' ? filledPrice - decisionPrice : decisionPrice - filledPrice;
  const slippageBps = decisionPrice > 0 ? (slippageRupees / decisionPrice) * 10_000 : 0;

  return {
    tradingsymbol: quote.tradingsymbol, side: quote.side,
    decisionPrice, submittedPrice, filledPrice,
    slippageRupees, slippageBps, spreadAtEntryPct: quote.spreadPct ?? (hasRealSpread(quote) ? effectiveSpreadPct : null),
    latencyMs: config.latencyMs, executionDataQuality, filled: true,
  };
}

/** Simulates every leg of a structure in the given execution order (BUY-before-SELL by convention — the caller must already have sorted `legs` that way, matching liveFill.ts's real sequencing). */
export function simulateStructureFill(legs: LegQuote[], mode: FillMode, overrides?: Partial<FillSimulatorConfig>): SimulatedFill[] {
  const config: FillSimulatorConfig = { ...configFor(mode), ...overrides };
  return legs.map((leg, i) => simulateFill(leg, config, i));
}

/**
 * Legging cost: the difference between what the structure would have cost
 * at a single instant's decision prices (all legs at `decisionPrice`
 * simultaneously) versus what it actually cost across the sequenced fills
 * — i.e. the extra cost purely from NOT executing all legs atomically.
 * Always >= 0 in this simulator (STRESS's adverse-movement modeling only
 * ever worsens later legs, never improves them) — a real fill could in
 * principle land favorably, but this simulator deliberately never assumes
 * that, consistent with never presenting an optimistic number as typical.
 */
export function computeLeggingCost(fills: SimulatedFill[], quantityPerLeg: number[]): number {
  let instantCost = 0, actualCost = 0;
  fills.forEach((f, i) => {
    const qty = quantityPerLeg[i] ?? 0;
    const dir = f.side === 'BUY' ? 1 : -1;
    instantCost += dir * f.decisionPrice * qty;
    actualCost += dir * f.filledPrice * qty;
  });
  return Math.max(0, actualCost - instantCost);
}

/** A guardrail string, meant to be surfaced anywhere an IDEAL result is displayed — see this file's header. */
export function describeFillMode(mode: FillMode): string {
  if (mode === 'IDEAL') {
    return 'IDEAL: midpoint fills, zero slippage — a theoretical ceiling for comparison ONLY. Never present this as expected live performance.';
  }
  if (mode === 'STRESS') {
    return 'STRESS: wider spreads, added slippage, execution delay, and adverse movement between legs — a deliberately pessimistic scenario, not a prediction.';
  }
  return 'REALISTIC: models executable BUY-toward-ask / SELL-toward-bid pricing scaled by spread/liquidity — the default assumption for new research.';
}
