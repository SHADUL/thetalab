/**
 * Pure summary of the order-flow OBSERVE experiment: for each variant
 * (A = raw d1/d2, B = Alpha Ladder final D) split CLOSED trades into
 * MATCH / CONFLICT / NOT_COMPARABLE groups and report counts, win rate,
 * expectancy, profit factor and max drawdown of the ACTUAL realized P&L.
 * It never estimates what a different structure would have earned — no
 * counterfactual P&L exists without historical executable option quotes.
 */
import type { FlowMatch } from '../strategies/orderFlowConfirmation.ts';

export interface ObservedTrade {
  rrDirection: 'bullish' | 'bearish' | 'neutral' | 'UNAVAILABLE';
  matchA: FlowMatch;
  matchB: FlowMatch;
  pnl: number;
  closedAtMs: number;
}

export interface GroupStats {
  n: number; pnl: number; winRatePct: number | null; expectancy: number | null; profitFactor: number | null; maxDrawdown: number;
}

export interface VariantReport {
  rrBearishWithBullishFlowConflict: number;
  rrBullishWithBearishFlowConflict: number;
  groups: Record<FlowMatch, GroupStats>;
}

export function groupStats(trades: Array<{ pnl: number; closedAtMs: number }>): GroupStats {
  const ordered = trades.slice().sort((a, b) => a.closedAtMs - b.closedAtMs);
  const n = ordered.length;
  const wins = ordered.filter((t) => t.pnl > 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -ordered.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const pnl = ordered.reduce((s, t) => s + t.pnl, 0);
  let equity = 0, peak = 0, dd = 0;
  for (const t of ordered) { equity += t.pnl; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); }
  return {
    n, pnl, winRatePct: n ? (100 * wins.length) / n : null, expectancy: n ? pnl / n : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, maxDrawdown: dd,
  };
}

function variant(trades: ObservedTrade[], pick: (t: ObservedTrade) => FlowMatch): VariantReport {
  const by = (m: FlowMatch) => trades.filter((t) => pick(t) === m);
  return {
    rrBearishWithBullishFlowConflict: trades.filter((t) => t.rrDirection === 'bearish' && pick(t) === 'CONFLICT').length,
    rrBullishWithBearishFlowConflict: trades.filter((t) => t.rrDirection === 'bullish' && pick(t) === 'CONFLICT').length,
    groups: { MATCH: groupStats(by('MATCH')), CONFLICT: groupStats(by('CONFLICT')), NOT_COMPARABLE: groupStats(by('NOT_COMPARABLE')) },
  };
}

export function summarizeOrderFlow(trades: ObservedTrade[]): { tradeCount: number; variantA: VariantReport; variantB: VariantReport } {
  return { tradeCount: trades.length, variantA: variant(trades, (t) => t.matchA), variantB: variant(trades, (t) => t.matchB) };
}
