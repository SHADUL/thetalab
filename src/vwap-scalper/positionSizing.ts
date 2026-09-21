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
