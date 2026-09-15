export interface PositionSizeResult {
  shares: number;
  riskAmount: number;
  capitalUsed: number;
  limitedBy: 'RISK' | 'CAPITAL' | 'NEITHER';
}

/**
 * Position sizing (spec §27) — must respect BOTH the risk-per-trade
 * limit AND the max-capital-per-trade limit, never just one. Mirrors the
 * Swing Scanner's own risk-then-fund sizing pattern (min of the two
 * caps), same reasoning: either constraint alone can violate the other.
 */
export function computePositionSize(input: {
  capital: number;
  riskPct: number;
  entry: number;
  stop: number;
  maxCapitalAllocationPct: number;
}): PositionSizeResult {
  const riskAmount = input.capital * (input.riskPct / 100);
  const riskPerShare = Math.abs(input.entry - input.stop);
  if (riskPerShare <= 0 || input.entry <= 0) {
    return { shares: 0, riskAmount, capitalUsed: 0, limitedBy: 'NEITHER' };
  }
  const sharesByRisk = Math.floor(riskAmount / riskPerShare);
  const maxCapital = input.capital * (input.maxCapitalAllocationPct / 100);
  const sharesByCapital = Math.floor(maxCapital / input.entry);
  const shares = Math.max(0, Math.min(sharesByRisk, sharesByCapital));
  const limitedBy = sharesByRisk === sharesByCapital ? 'NEITHER' : shares === sharesByRisk ? 'RISK' : 'CAPITAL';
  return { shares, riskAmount, capitalUsed: shares * input.entry, limitedBy };
}

export type DailyLockReason = 'MAX_DAILY_LOSS' | 'MAX_TRADES' | 'MAX_CONSECUTIVE_LOSSES';

export interface DailyRiskCheck {
  locked: boolean;
  reason: DailyLockReason | null;
}

/**
 * Daily risk limits (spec §28) — mandatory for any automated trading.
 * Once locked, only exits remain active; no new entries for the rest of
 * the session, regardless of how good the next signal looks. This is
 * the mechanism that stops the system from revenge-trading a bad day.
 */
export function checkDailyRiskLimits(input: {
  dailyPnl: number;
  capital: number;
  maxDailyLossPct: number;
  tradesToday: number;
  maxTrades: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
}): DailyRiskCheck {
  const maxLossAmount = input.capital * (input.maxDailyLossPct / 100);
  if (input.dailyPnl <= -maxLossAmount) return { locked: true, reason: 'MAX_DAILY_LOSS' };
  if (input.tradesToday >= input.maxTrades) return { locked: true, reason: 'MAX_TRADES' };
  if (input.consecutiveLosses >= input.maxConsecutiveLosses) return { locked: true, reason: 'MAX_CONSECUTIVE_LOSSES' };
  return { locked: false, reason: null };
}
