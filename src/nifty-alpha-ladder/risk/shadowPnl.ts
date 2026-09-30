/**
 * SHADOW P&L — computed from simulated FILLS, never from the theoretical
 * payoff (spec §38 of the Milestone 3 instructions: "Do not use
 * theoretical payoff as realised P&L"). No brokerage/charges model exists
 * for this strategy yet, so the result is explicitly labeled
 * `netPnlBeforeCharges` — never silently called "net."
 */
import type { LegSide } from '../types.ts';

export interface LegFillPair {
  side: LegSide;
  quantity: number;
  entryFillPrice: number;
  /** null while the leg is still open — the whole result is then partial (gross/net are null), never estimated from an assumed exit. */
  exitFillPrice: number | null;
}

export interface ShadowPnlResult {
  /** Per-leg realized P&L (₹), null for any leg not yet exited. */
  perLegPnl: Array<{ side: LegSide; pnl: number | null }>;
  /** Sum of per-leg P&L — null if ANY leg is still open (never partially estimated). */
  grossPnl: number | null;
  /** Identical to grossPnl today (no cost model exists for this strategy yet) — kept as its own explicitly-named field precisely so it is never confused with a true post-charges net once a cost model is added later. */
  netPnlBeforeCharges: number | null;
}

function legPnl(leg: LegFillPair): number | null {
  if (leg.exitFillPrice === null) return null;
  return (leg.side === 'SELL' ? 1 : -1) * (leg.entryFillPrice - leg.exitFillPrice) * leg.quantity;
}

export function computeShadowPnl(legs: LegFillPair[]): ShadowPnlResult {
  const perLegPnl = legs.map((l) => ({ side: l.side, pnl: legPnl(l) }));
  const anyOpen = perLegPnl.some((l) => l.pnl === null);
  const gross = anyOpen ? null : perLegPnl.reduce((sum, l) => sum + (l.pnl ?? 0), 0);
  return { perLegPnl, grossPnl: gross, netPnlBeforeCharges: gross };
}

/**
 * The THEORETICAL payoff (from risk/payoff.ts, at the sized units/lot size)
 * is a separate number entirely — kept alongside the realized SHADOW P&L
 * above for comparison, never substituted for it. Callers should persist
 * both `theoreticalPayoffAtEntry` (computed once, at entry, from the
 * spec's V⁻ formula) and this module's `ShadowPnlResult` (computed
 * continuously/at exit, from real simulated fills) as genuinely separate
 * fields — see alpha_ladder_positions' own max_loss/max_gain/tail_value
 * columns (theoretical) vs realized_pnl (this module's output).
 */
