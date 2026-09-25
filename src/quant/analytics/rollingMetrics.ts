/**
 * Rolling forward-monitoring metrics (live-data-capture phase, Task 12) —
 * MONITORING metrics only, never a trigger to stop or modify BASELINE_V1
 * on their own. A caller (dashboard, alert) may choose to surface a weak
 * streak, but this module itself never decides to halt anything — that
 * stays the daily-risk-lock's job (dailyRiskLock.ts), a genuinely
 * different, safety-motivated mechanism.
 */

export interface ForwardTradeOutcome {
  netPnl: number;
  exitDate: string;
}

export interface RollingWindowMetrics {
  windowSize: number;
  tradeCount: number;
  expectancy: number | null;
  profitFactor: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
}

function summarize(trades: ForwardTradeOutcome[], windowSize: number): RollingWindowMetrics {
  if (trades.length === 0) {
    return { windowSize, tradeCount: 0, expectancy: null, profitFactor: null, winRate: null, avgWin: null, avgLoss: null };
  }
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  return {
    windowSize, tradeCount: trades.length,
    expectancy: netPnl / trades.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    winRate: wins.length / trades.length,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
  };
}

/**
 * @param chronologicalTrades Completed trades, OLDEST FIRST — the caller's
 *   responsibility to sort; this function trusts the given order rather
 *   than re-sorting (a forward ledger is naturally append-in-order, so
 *   re-sorting here would just be redundant work on the hot path).
 */
export function computeRollingWindows(chronologicalTrades: ForwardTradeOutcome[], windowSizes: number[] = [20, 30]): RollingWindowMetrics[] {
  return windowSizes.map((size) => summarize(chronologicalTrades.slice(-size), size));
}
