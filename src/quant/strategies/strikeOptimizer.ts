/**
 * Generates and ranks MULTIPLE candidate structures for an already-chosen
 * strategy type, rather than the single deterministic pick
 * ironCondor.ts/creditSpread.ts each make on their own. Strategy SELECTION
 * (which shape to build — Iron Condor vs Bull Put vs Bear Call) is still
 * regimeSelect.ts's job; this module only explores the strike/delta/wing
 * space WITHIN that already-chosen shape, reusing buildIronCondor() /
 * buildCreditSpread() as the pricing primitive for every candidate — no
 * duplicated pricing logic here.
 *
 * Ranked by expected value PER UNIT OF RISK (expectedValue / maxLoss), not
 * raw premium or raw expected value — a structure with a huge maxLoss isn't
 * automatically better just because its absolute EV is bigger. Expected
 * value itself is the standard two-outcome approximation
 * (pop * maxProfit - (1-pop) * maxLoss) built from the same POP the pricing
 * engine already computes — not a separate model.
 */
import { buildIronCondor, type IronCondorFailure, type IronCondorResult } from './ironCondor.ts';
import { buildCreditSpread, type CreditSpreadFailure, type CreditSpreadResult } from './creditSpread.ts';
import { classifyLegLiquidity, classifyStrategyLiquidity, type StrategyLiquidity } from '../analytics/liquidity.ts';
import type { EnrichedQuote, EnrichedSlice, Right } from '../types.ts';

export type StrategyLabel = 'Iron Condor' | 'Bull Put Spread' | 'Bear Call Spread';

/**
 * A standard credit-selling delta grid — not backtested/optimized (see
 * tradeQualityScore.ts's header for the same caveat on its own weights).
 * Stated explicitly so it can be argued with, matching regimeSelect.ts's
 * own convention for its skew threshold.
 */
export const DEFAULT_DELTA_TARGETS = [0.1, 0.16, 0.2, 0.25, 0.3];

/** Convenience: wing widths as multiples of the chain's own strike step (50 for NIFTY, 100 for SENSEX). */
export function wingWidthsFromStep(step: number, multiples: number[] = [2, 4, 6, 8]): number[] {
  return multiples.map((m) => m * step);
}

export interface StrikeOptimizerParams {
  strategyLabel: StrategyLabel;
  lotSize: number;
  entryPriceOverride?: (strike: number, right: Right) => number | null;
  /** |delta| targets to explore for the short strike(s). Defaults to DEFAULT_DELTA_TARGETS. */
  deltaTargets?: number[];
  /** Wing widths to explore, in raw strike points — required, no default (strike-grid dependent). */
  wingWidths: number[];
}

export interface OptimizerCandidate {
  strategyLabel: StrategyLabel;
  targetShortDelta: number;
  wingWidth: number;
  result: IronCondorResult | CreditSpreadResult;
  /** pop * maxProfit - (1-pop) * maxLoss. Null when POP is unavailable. */
  expectedValue: number | null;
  /** expectedValue / maxLoss — the ranking metric. Null alongside expectedValue. */
  evPerUnitRisk: number | null;
  /**
   * The HARD liquidity gate's own read (see analytics/liquidity.ts) — never
   * UNTRADABLE here, since an UNTRADABLE candidate is rejected into
   * `failures` before it ever reaches this list. Distinct from
   * tradeQualityScore.ts's own soft liquidity SCORE, which this survives
   * regardless of tier.
   */
  liquidity: StrategyLiquidity;
}

export interface OptimizerFailure {
  strategyLabel: StrategyLabel;
  targetShortDelta: number;
  wingWidth: number;
  reason: string;
}

export interface OptimizerResult {
  /** Sorted best-first by evPerUnitRisk; candidates with no POP sort last. */
  candidates: OptimizerCandidate[];
  failures: OptimizerFailure[];
}

function buildOne(
  slice: EnrichedSlice,
  strategyLabel: StrategyLabel,
  targetShortDelta: number,
  wingWidth: number,
  lotSize: number,
  entryPriceOverride?: (strike: number, right: Right) => number | null,
): IronCondorResult | IronCondorFailure | CreditSpreadResult | CreditSpreadFailure {
  if (strategyLabel === 'Iron Condor') {
    return buildIronCondor(slice, { targetShortDelta, wingWidth, lotSize, entryPriceOverride });
  }
  const right: Right = strategyLabel === 'Bull Put Spread' ? 'PE' : 'CE';
  return buildCreditSpread(slice, { right, targetShortDelta, wingWidth, lotSize, entryPriceOverride });
}

// Not ironCondor.ts's/creditSpread.ts's own isIronCondorFailure()/
// isCreditSpreadFailure(): buildOne()'s return type spans all four
// result/failure shapes at once, which neither of those narrows correctly.
// Both are implemented identically ('reason' in r) — this is that same
// check, generalised across the wider union.
function isFailure(
  r: IronCondorResult | IronCondorFailure | CreditSpreadResult | CreditSpreadFailure,
): r is IronCondorFailure | CreditSpreadFailure {
  return 'reason' in r;
}

function scoreExpectedValue(
  result: IronCondorResult | CreditSpreadResult,
): { expectedValue: number | null; evPerUnitRisk: number | null } {
  if (result.pop === null || !(result.maxLoss > 0)) return { expectedValue: null, evPerUnitRisk: null };
  const expectedValue = result.pop * result.maxProfit - (1 - result.pop) * result.maxLoss;
  return { expectedValue, evPerUnitRisk: expectedValue / result.maxLoss };
}

export function generateCandidates(slice: EnrichedSlice, params: StrikeOptimizerParams): OptimizerResult {
  const deltaTargets = params.deltaTargets ?? DEFAULT_DELTA_TARGETS;
  if (!params.wingWidths || params.wingWidths.length === 0) {
    return {
      candidates: [],
      failures: [{
        strategyLabel: params.strategyLabel, targetShortDelta: NaN, wingWidth: NaN,
        reason: 'No wingWidths supplied — the optimizer needs at least one strike-point width to explore.',
      }],
    };
  }

  const candidates: OptimizerCandidate[] = [];
  const failures: OptimizerFailure[] = [];
  // Different delta targets can resolve to the identical actual strikes once
  // the target saturates against the available strike grid — de-duped so
  // the same real trade isn't presented twice as if it were two distinct
  // opportunities. Candidates are structurally identical when this happens,
  // so keeping whichever was built first loses no information.
  const seen = new Set<string>();

  const legLookup = new Map(slice.quotes.map((q) => [`${q.quote.strike}:${q.quote.right}`, q]));

  for (const targetShortDelta of deltaTargets) {
    for (const wingWidth of params.wingWidths) {
      const result = buildOne(slice, params.strategyLabel, targetShortDelta, wingWidth, params.lotSize, params.entryPriceOverride);
      if (isFailure(result)) {
        failures.push({ strategyLabel: params.strategyLabel, targetShortDelta, wingWidth, reason: result.reason });
        continue;
      }
      const key = result.legs.map((l) => `${l.side}${l.strike}${l.right}`).sort().join('|');
      if (seen.has(key)) continue;

      // HARD liquidity gate (see analytics/liquidity.ts's header): a
      // mathematically attractive but genuinely unfillable spread must be
      // rejected outright here, not merely soft-scored lower downstream
      // and left to possibly win anyway.
      const legQuotes = result.legs
        .map((l) => legLookup.get(`${l.strike}:${l.right}`))
        .filter((q): q is EnrichedQuote => q != null);
      const liquidity = classifyStrategyLiquidity(legQuotes.map((q) => classifyLegLiquidity(q)));
      if (liquidity.tier === 'UNTRADABLE') {
        seen.add(key);
        failures.push({
          strategyLabel: params.strategyLabel, targetShortDelta, wingWidth,
          reason: `Rejected on liquidity: ${liquidity.blockingReasons.join('; ')}`,
        });
        continue;
      }
      seen.add(key);

      const { expectedValue, evPerUnitRisk } = scoreExpectedValue(result);
      candidates.push({ strategyLabel: params.strategyLabel, targetShortDelta, wingWidth, result, expectedValue, evPerUnitRisk, liquidity });
    }
  }

  candidates.sort((a, b) => (b.evPerUnitRisk ?? -Infinity) - (a.evPerUnitRisk ?? -Infinity));
  return { candidates, failures };
}
