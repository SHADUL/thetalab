/**
 * BASELINE_V1 — frozen, machine-readable snapshot of the risk-limit subset
 * of production defaults actually consumed by computePositionSize()/
 * checkDailyRiskLock() in this backtest phase. See BASELINE_V1.md at the
 * repo root for the full parameter list (including delta targets, skew
 * threshold, etc., which are consumed as their own module-level defaults
 * elsewhere and don't need restating here as a separate config object).
 *
 * Never mutate this file to "improve" a research result. A future,
 * deliberate parameter change belongs in a new BASELINE_V2 (a new file,
 * new name), so any report can state exactly which baseline produced it.
 */
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../../quant/strategies/positionSizing.ts';

export const BASELINE_V1_RISK_LIMITS: RiskLimits = { ...DEFAULT_RISK_LIMITS };

export const BASELINE_V1_DAILY_LOCK = {
  maxDailyLossPct: 4,
  maxConsecutiveLosses: 3,
};

export const BASELINE_V1_EXIT_PARAMS = {
  profitTargetPct: 50,
  stopLossCreditMultiple: 2,
  timeExitDte: 2,
  strikeBreachBufferPct: 0,
};

export const BASELINE_V1_DECISION_THRESHOLDS = {
  noTradeBelow: 70,
  watchBelow: 80,
  highConvictionAtOrAbove: 90,
};

export const BASELINE_V1_DTE_BAND = { minDte: 2, maxDte: 60 };

export const BASELINE_VERSION = 'BASELINE_V1';
