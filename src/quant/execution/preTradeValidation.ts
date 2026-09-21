/**
 * The ten pre-flight checks a candidate must pass immediately before any
 * order is placed (Phase 11) — market data freshness, trading session,
 * instrument validity, available margin, risk limits, no duplicate
 * position, price/slippage, strategy still valid, Greeks recalculation,
 * and max-loss recalculation. One failed check refuses the whole trade;
 * this function never decides "close enough."
 *
 * Deliberately a pure function over already-fetched inputs, same
 * discipline as checkDailyRiskLimits() in the intraday module — gathering
 * a fresh quote, a live margin figure, or the current duplicate-position
 * state is the (not yet built) orchestrator's job, not this module's.
 */

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

export interface ValidationInput {
  /** How old the quote used to build this candidate is, in ms. */
  quoteAgeMs: number;
  maxQuoteAgeMs: number;

  isMarketOpen: boolean;

  allInstrumentsResolved: boolean;
  /** tradingsymbols that failed to resolve, if any — populates the detail message. */
  unresolvedLegs: string[];

  marginSufficient: boolean;
  marginDetail: string;

  /** From computePositionSize() — zero means a risk limit already refused this trade upstream. */
  positionSizeLots: number;

  duplicatePositionExists: boolean;

  /** How far the live price has drifted from the price this candidate was scored at, as a percent (can be negative). */
  priceDriftPct: number;
  maxSlippagePct: number;

  /** Re-running classifyBias/generateCandidates right before submission still agrees with the original decision. */
  strategyStillValid: boolean;
  strategyDetail: string;

  /** Re-priced net Greeks are still within the position-sizing engine's exposure caps. */
  greeksWithinLimits: boolean;
  greeksDetail: string;

  recalculatedMaxLoss: number;
  originalMaxLoss: number;
  maxLossDriftPct: number;
}

export function runPreTradeValidation(input: ValidationInput): ValidationResult {
  const maxLossDrift = input.originalMaxLoss > 0
    ? Math.abs(input.recalculatedMaxLoss - input.originalMaxLoss) / input.originalMaxLoss * 100
    : Infinity;

  const checks: ValidationCheck[] = [
    {
      name: 'marketDataFreshness',
      passed: input.quoteAgeMs <= input.maxQuoteAgeMs,
      detail: `Quote is ${input.quoteAgeMs}ms old, max allowed ${input.maxQuoteAgeMs}ms.`,
    },
    {
      name: 'tradingSession',
      passed: input.isMarketOpen,
      detail: input.isMarketOpen ? 'Market is open.' : 'Market is closed.',
    },
    {
      name: 'instrumentValidity',
      passed: input.allInstrumentsResolved,
      detail: input.allInstrumentsResolved
        ? 'Every leg resolved to a real tradingsymbol.'
        : `Unresolved leg(s): ${input.unresolvedLegs.join(', ') || 'none listed'}.`,
    },
    { name: 'availableMargin', passed: input.marginSufficient, detail: input.marginDetail },
    {
      name: 'riskLimits',
      passed: input.positionSizeLots > 0,
      detail: input.positionSizeLots > 0
        ? `Sized to ${input.positionSizeLots} lot(s).`
        : 'Position size resolved to zero lots — a risk limit blocked this trade.',
    },
    {
      name: 'noDuplicatePosition',
      passed: !input.duplicatePositionExists,
      detail: input.duplicatePositionExists ? 'An equivalent position is already open.' : 'No duplicate open position.',
    },
    {
      name: 'priceSlippage',
      passed: Math.abs(input.priceDriftPct) <= input.maxSlippagePct,
      detail: `Price has drifted ${input.priceDriftPct.toFixed(2)}% since this candidate was scored, max allowed ${input.maxSlippagePct}%.`,
    },
    { name: 'strategyStillValid', passed: input.strategyStillValid, detail: input.strategyDetail },
    { name: 'greeksRecalculation', passed: input.greeksWithinLimits, detail: input.greeksDetail },
    {
      name: 'maxLossRecalculation',
      passed: maxLossDrift <= input.maxLossDriftPct,
      detail: `Recalculated max loss ₹${input.recalculatedMaxLoss.toFixed(0)} vs original ₹${input.originalMaxLoss.toFixed(0)} (${maxLossDrift.toFixed(1)}% drift, max allowed ${input.maxLossDriftPct}%).`,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
}
