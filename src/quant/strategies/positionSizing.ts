/**
 * Decides how many lots (if any) of an already-chosen candidate to trade,
 * from account equity, existing open positions, and margin — never from
 * available margin alone ("never size based simply on available margin" is
 * the spec's own instruction). Ten independent caps, each expressed as its
 * own maximum-lots-affordable-under-this-constraint-alone; the final size
 * is the MINIMUM across all of them, so no single generous limit can hide
 * a tighter one. A calculated size of zero is a genuine NO_TRADE, not an
 * error — the caller is told exactly which constraint bound it.
 *
 * Every input this needs already exists in this codebase: the priced
 * candidate's own maxLoss/maxProfit/netGreeks, and a live per-lot margin
 * figure from the /margins/basket wrapper (api/options-autotrade.ts,
 * src/lib/optionsMargin.js) verified against a real Kite response. Nothing
 * here is fabricated — "existing positions" and "account equity" are
 * caller-supplied state this module doesn't own or fetch.
 *
 * Defaults for every limit below are provisional starting points, not
 * validated — same posture as regimeSelect.ts's skew threshold and
 * tradeQualityScore.ts's weights.
 */
import type { Greeks } from '../types.ts';
import type { IronCondorResult } from './ironCondor.ts';
import type { CreditSpreadResult } from './creditSpread.ts';

/** The real priced-result fields this module needs — reused directly, not redefined, to avoid drift from the actual pricing engine. */
export type SizablePricing = Pick<IronCondorResult | CreditSpreadResult, 'maxLoss' | 'maxProfit' | 'netCredit' | 'netGreeks'>;

export interface SizableCandidate {
  /** Priced for exactly ONE lot (i.e. built with lotSize = the exchange's own contracts-per-lot, before multiplying by a chosen lot count). */
  pricing: SizablePricing;
  /** From a live /margins/basket call for this exact structure at one lot — not fetched by this module. */
  marginRequiredPerLot: number;
  /** e.g. 'NIFTY' — scopes the underlying-exposure (delta) cap to positions on the same underlying. */
  underlyingGroup: string;
  /** Defaults to underlyingGroup when omitted. Set to something broader (e.g. 'NIFTY_FAMILY') to pool NIFTY+BANKNIFTY under one correlated-risk budget. */
  correlatedGroup?: string;
}

export interface OpenPositionSummary {
  underlyingGroup: string;
  correlatedGroup?: string;
  /** Total across however many lots this open position already holds — not per-lot. */
  maxLoss: number;
  marginRequired: number;
  netGreeks: Greeks;
}

export interface AccountState {
  /** Total account equity — the base every *Pct risk limit below is a percentage of. */
  equity: number;
  /** Actual free margin/cash available right now, from the broker — the base maxMarginUtilizationPct is a percentage of. */
  availableFunds: number;
}

export interface PortfolioState {
  openPositions: OpenPositionSummary[];
  /** Negative = a loss so far today. Zero or positive = no daily loss to budget against yet. */
  realizedPnlToday: number;
  /** Same sign convention as realizedPnlToday, over the current week. */
  realizedPnlThisWeek: number;
}

export interface RiskLimits {
  maxRiskPerTradePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxPortfolioRiskPct: number;
  maxMarginUtilizationPct: number;
  maxPositions: number;
  /** Absolute cap on net delta (this module's own Greek units — same scale as netGreeks.delta), scoped per underlyingGroup. */
  maxUnderlyingDelta: number;
  /** Absolute cap on total net gamma, across the whole portfolio regardless of underlying. */
  maxGamma: number;
  /** Absolute cap on total net vega, across the whole portfolio regardless of underlying. */
  maxVega: number;
  /** % of equity, scoped per correlatedGroup (defaults to underlyingGroup when a candidate doesn't set one). */
  maxCorrelatedGroupRiskPct: number;
}

/** Provisional — see this file's header. */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxRiskPerTradePct: 2,
  maxDailyLossPct: 4,
  maxWeeklyLossPct: 8,
  maxPortfolioRiskPct: 10,
  maxMarginUtilizationPct: 60,
  maxPositions: 5,
  maxUnderlyingDelta: 300,
  maxGamma: 50,
  maxVega: 5000,
  maxCorrelatedGroupRiskPct: 6,
};

export interface SizingConstraint {
  name: string;
  /** Max additional lots this constraint alone would allow. Infinity = unconstrained by this rule. */
  maxLots: number;
  /** Human-readable, cites the real numbers behind the figure. */
  detail: string;
}

export interface PositionSizeResult {
  /** Final decided lot count. 0 = NO_TRADE. */
  lots: number;
  /** Name of whichever constraint produced the minimum — null only when lots > 0 and every constraint was unconstrained (should not happen in practice). */
  binding: string | null;
  /** Every constraint's own figure, for full explainability — not just the tightest one. */
  constraints: SizingConstraint[];
  sizedMaxLoss: number;
  sizedMaxProfit: number;
  sizedMarginRequired: number;
  /** Set (non-null) exactly when lots === 0, citing the binding constraint's own detail. */
  reason: string | null;
}

function floorNonNegative(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : (x === Infinity ? Infinity : 0);
}

/** Max lots affordable from a fixed rupee budget against a fixed per-lot cost. */
function maxLotsForBudget(budget: number, perLotCost: number): number {
  if (perLotCost <= 0) return Infinity; // shouldn't happen for a valid defined-risk credit structure's maxLoss/margin — defensive only
  return floorNonNegative(budget / perLotCost);
}

/**
 * Max additional lots before |existing + perLot*lots| would exceed cap.
 * If the existing exposure ALREADY breaches the cap, this deliberately
 * refuses any new lots (0) rather than doing directional math about
 * whether this specific trade would happen to net it back down — fixing
 * an already-breached exposure is a kill-switch/adjustment-engine concern
 * (Phase 17/20/21), not something a NEW-entry sizer should reason its way
 * around.
 */
function maxLotsForAbsCap(existing: number, perLot: number, cap: number): number {
  if (cap < 0) return 0;
  if (Math.abs(existing) > cap) return 0;
  if (perLot === 0) return Infinity;
  const limit = perLot > 0 ? (cap - existing) / perLot : (-cap - existing) / perLot;
  return floorNonNegative(limit);
}

function sumMaxLoss(positions: OpenPositionSummary[]): number {
  return positions.reduce((s, p) => s + p.maxLoss, 0);
}
function sumMargin(positions: OpenPositionSummary[]): number {
  return positions.reduce((s, p) => s + p.marginRequired, 0);
}
function sumGreek(positions: OpenPositionSummary[], key: keyof Greeks): number {
  return positions.reduce((s, p) => s + (p.netGreeks[key] ?? 0), 0);
}

export function computePositionSize(
  candidate: SizableCandidate,
  account: AccountState,
  portfolio: PortfolioState,
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
): PositionSizeResult {
  const perLotMaxLoss = candidate.pricing.maxLoss;
  const perLotMargin = candidate.marginRequiredPerLot;
  const correlatedGroup = candidate.correlatedGroup ?? candidate.underlyingGroup;

  const sameUnderlying = portfolio.openPositions.filter((p) => p.underlyingGroup === candidate.underlyingGroup);
  const sameCorrelatedGroup = portfolio.openPositions.filter((p) => (p.correlatedGroup ?? p.underlyingGroup) === correlatedGroup);

  const dailyLossSoFar = Math.max(0, -portfolio.realizedPnlToday);
  const weeklyLossSoFar = Math.max(0, -portfolio.realizedPnlThisWeek);

  const constraints: SizingConstraint[] = [
    {
      name: 'maxRiskPerTrade',
      maxLots: maxLotsForBudget(account.equity * (limits.maxRiskPerTradePct / 100), perLotMaxLoss),
      detail: `1-lot max loss ₹${perLotMaxLoss.toFixed(0)} against a per-trade budget of ${limits.maxRiskPerTradePct}% of equity (₹${(account.equity * limits.maxRiskPerTradePct / 100).toFixed(0)}).`,
    },
    {
      name: 'maxDailyLoss',
      maxLots: maxLotsForBudget(Math.max(0, account.equity * (limits.maxDailyLossPct / 100) - dailyLossSoFar), perLotMaxLoss),
      detail: `₹${dailyLossSoFar.toFixed(0)} lost today against a daily budget of ${limits.maxDailyLossPct}% of equity (₹${(account.equity * limits.maxDailyLossPct / 100).toFixed(0)}).`,
    },
    {
      name: 'maxWeeklyLoss',
      maxLots: maxLotsForBudget(Math.max(0, account.equity * (limits.maxWeeklyLossPct / 100) - weeklyLossSoFar), perLotMaxLoss),
      detail: `₹${weeklyLossSoFar.toFixed(0)} lost this week against a weekly budget of ${limits.maxWeeklyLossPct}% of equity (₹${(account.equity * limits.maxWeeklyLossPct / 100).toFixed(0)}).`,
    },
    {
      name: 'maxPortfolioRisk',
      maxLots: maxLotsForBudget(Math.max(0, account.equity * (limits.maxPortfolioRiskPct / 100) - sumMaxLoss(portfolio.openPositions)), perLotMaxLoss),
      detail: `₹${sumMaxLoss(portfolio.openPositions).toFixed(0)} already at risk across ${portfolio.openPositions.length} open position(s), against a portfolio budget of ${limits.maxPortfolioRiskPct}% of equity.`,
    },
    {
      name: 'maxMarginUtilization',
      maxLots: maxLotsForBudget(Math.max(0, account.availableFunds * (limits.maxMarginUtilizationPct / 100) - sumMargin(portfolio.openPositions)), perLotMargin),
      detail: `₹${sumMargin(portfolio.openPositions).toFixed(0)} margin already used, against ${limits.maxMarginUtilizationPct}% of available funds (₹${(account.availableFunds * limits.maxMarginUtilizationPct / 100).toFixed(0)}).`,
    },
    {
      name: 'maxPositions',
      maxLots: portfolio.openPositions.length < limits.maxPositions ? Infinity : 0,
      detail: `${portfolio.openPositions.length} open position(s) against a max of ${limits.maxPositions}.`,
    },
    {
      name: 'maxUnderlyingExposure',
      maxLots: maxLotsForAbsCap(sumGreek(sameUnderlying, 'delta'), candidate.pricing.netGreeks.delta ?? 0, limits.maxUnderlyingDelta),
      detail: `Net delta on ${candidate.underlyingGroup} currently ${sumGreek(sameUnderlying, 'delta').toFixed(1)}, cap ±${limits.maxUnderlyingDelta}.`,
    },
    {
      name: 'maxGammaExposure',
      maxLots: maxLotsForAbsCap(sumGreek(portfolio.openPositions, 'gamma'), candidate.pricing.netGreeks.gamma ?? 0, limits.maxGamma),
      detail: `Portfolio net gamma currently ${sumGreek(portfolio.openPositions, 'gamma').toFixed(2)}, cap ±${limits.maxGamma}.`,
    },
    {
      name: 'maxVegaExposure',
      maxLots: maxLotsForAbsCap(sumGreek(portfolio.openPositions, 'vega'), candidate.pricing.netGreeks.vega ?? 0, limits.maxVega),
      detail: `Portfolio net vega currently ${sumGreek(portfolio.openPositions, 'vega').toFixed(1)}, cap ±${limits.maxVega}.`,
    },
    {
      name: 'maxCorrelatedExposure',
      maxLots: maxLotsForBudget(Math.max(0, account.equity * (limits.maxCorrelatedGroupRiskPct / 100) - sumMaxLoss(sameCorrelatedGroup)), perLotMaxLoss),
      detail: `₹${sumMaxLoss(sameCorrelatedGroup).toFixed(0)} already at risk in the '${correlatedGroup}' correlated group, against ${limits.maxCorrelatedGroupRiskPct}% of equity.`,
    },
  ];

  const rawLots = Math.min(...constraints.map((c) => c.maxLots));
  const lots = Number.isFinite(rawLots) ? Math.max(0, Math.floor(rawLots)) : 0;
  const bindingConstraint = constraints.find((c) => c.maxLots === rawLots) ?? null;

  return {
    lots,
    binding: lots > 0 ? (Number.isFinite(rawLots) ? bindingConstraint?.name ?? null : null) : (bindingConstraint?.name ?? null),
    constraints,
    sizedMaxLoss: perLotMaxLoss * lots,
    sizedMaxProfit: candidate.pricing.maxProfit * lots,
    sizedMarginRequired: perLotMargin * lots,
    reason: lots === 0 ? `Position size is zero — ${bindingConstraint?.name ?? 'a risk limit'} allows no lots. ${bindingConstraint?.detail ?? ''}` : null,
  };
}
