/**
 * Position sizing for a single-leg equity scalp — genuinely simpler than
 * options' multi-leg margin/Greeks sizing (src/quant/strategies/
 * positionSizing.ts): risk is just entry-to-stop distance × share count,
 * no margin or Greeks exposure to model.
 *
 * Sizing WITHOUT a stop (stopPrice null) is refused, not estimated — an
 * unbounded position has no genuine risk-per-share to size against, and
 * guessing one would be fabricating a number this module has no basis for.
 */
export interface PositionSizingParams {
  accountEquity: number;
  maxRiskPerTradePct: number;
  entryPrice: number;
  stopPrice: number;
  /** Minimum tradable lot — 1 for most NSE equities (unlike index options, which trade in fixed lots). */
  lotSize?: number;
}

export interface PositionSizingResult {
  quantity: number;
  riskPerShare: number;
  totalRiskAtStop: number;
  budgetAtRisk: number;
}

export function computeVwapScalperPositionSize(params: PositionSizingParams): PositionSizingResult | null {
  const { accountEquity, maxRiskPerTradePct, entryPrice, stopPrice } = params;
  const lotSize = params.lotSize ?? 1;
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  if (!(accountEquity > 0) || !(maxRiskPerTradePct > 0) || !(riskPerShare > 0) || !(lotSize > 0)) return null;

  const budgetAtRisk = accountEquity * (maxRiskPerTradePct / 100);
  const rawQuantity = Math.floor(budgetAtRisk / riskPerShare / lotSize) * lotSize;
  if (rawQuantity <= 0) return null;

  return {
    quantity: rawQuantity,
    riskPerShare,
    totalRiskAtStop: rawQuantity * riskPerShare,
    budgetAtRisk,
  };
}

/**
 * An alternative sizing philosophy: allocate a FIXED amount of capital
 * per trade (e.g. "₹20,000 per position, so I can run 5 at once out of
 * ₹1,00,000") rather than sizing off the stop distance. Quantity is
 * purely capital / entryPrice — genuinely different from risk-based
 * sizing, not a variant of it: two trades of the same capital allocation
 * can carry very different rupee risk if their stop distances differ.
 *
 * Unlike computeVwapScalperPositionSize, this does NOT require a stop to
 * size — capital allocation doesn't need one to compute quantity. When a
 * stop IS supplied, the resulting risk figures are still reported (for
 * visibility/logging), just never used to derive the quantity itself.
 */
export interface FixedCapitalSizingParams {
  capitalPerTrade: number;
  entryPrice: number;
  /** Optional — reported for transparency only, never used to size. */
  stopPrice?: number | null;
  lotSize?: number;
}

export interface FixedCapitalSizingResult {
  quantity: number;
  capitalDeployed: number;
  /** null when no stop was supplied — sizing itself never needed one. */
  riskPerShare: number | null;
  totalRiskAtStop: number | null;
}

export function computeFixedCapitalPositionSize(params: FixedCapitalSizingParams): FixedCapitalSizingResult | null {
  const { capitalPerTrade, entryPrice } = params;
  const lotSize = params.lotSize ?? 1;
  if (!(capitalPerTrade > 0) || !(entryPrice > 0) || !(lotSize > 0)) return null;

  const rawQuantity = Math.floor(capitalPerTrade / entryPrice / lotSize) * lotSize;
  if (rawQuantity <= 0) return null;

  const stopPrice = params.stopPrice ?? null;
  const riskPerShare = stopPrice !== null ? Math.abs(entryPrice - stopPrice) : null;

  return {
    quantity: rawQuantity,
    capitalDeployed: rawQuantity * entryPrice,
    riskPerShare,
    totalRiskAtStop: riskPerShare !== null ? riskPerShare * rawQuantity : null,
  };
}
