import type { SimulatedIntradayTrade, IntradayTradeMetrics } from './types.ts';

/**
 * R-multiple denominated, not rupee/returnPct denominated — a signal-
 * level backtest across many different stocks and dates has no single
 * coherent equity curve (no capital constraints, no concurrent-position
 * limits, no portfolio-level sizing decisions), so reporting drawdown,
 * Sharpe, or Sortino here would look precise while meaning very little.
 * R-multiple is the right unit because every simulated trade already
 * risks the same 1R by construction (computePositionSize sizes to the
 * settings' risk_pct_per_trade) — same reasoning the swing backtest's
 * metrics.ts documents for its own, differently-shaped exclusions. Both
 * gross (price-only) and net (after realistic costs + slippage) are
 * reported side by side so the cost drag itself is visible, not buried.
 */
export function computeIntradayMetrics(trades: SimulatedIntradayTrade[]): IntradayTradeMetrics {
  const count = trades.length;
  if (count === 0) {
    return {
      count: 0, winRateGross: null, winRateNet: null, profitFactorGross: null, profitFactorNet: null,
      expectancyRGross: null, expectancyRNet: null, avgWinRNet: null, avgLossRNet: null, avgCostAsPctOfRisk: null,
    };
  }

  const winsGross = trades.filter((t) => t.rMultipleGross > 0);
  const lossesGross = trades.filter((t) => t.rMultipleGross <= 0);
  const grossWinSum = winsGross.reduce((s, t) => s + t.rMultipleGross, 0);
  const grossLossSum = lossesGross.reduce((s, t) => s + t.rMultipleGross, 0); // <= 0

  const winsNet = trades.filter((t) => t.rMultipleNet > 0);
  const lossesNet = trades.filter((t) => t.rMultipleNet <= 0);
  const netWinSum = winsNet.reduce((s, t) => s + t.rMultipleNet, 0);
  const netLossSum = lossesNet.reduce((s, t) => s + t.rMultipleNet, 0); // <= 0

  const profitFactor = (winSum: number, lossSum: number): number | null =>
    lossSum === 0 ? (winSum > 0 ? null : 0) : winSum / Math.abs(lossSum);

  return {
    count,
    winRateGross: winsGross.length / count,
    winRateNet: winsNet.length / count,
    profitFactorGross: profitFactor(grossWinSum, grossLossSum),
    profitFactorNet: profitFactor(netWinSum, netLossSum),
    expectancyRGross: trades.reduce((s, t) => s + t.rMultipleGross, 0) / count,
    expectancyRNet: trades.reduce((s, t) => s + t.rMultipleNet, 0) / count,
    avgWinRNet: winsNet.length ? netWinSum / winsNet.length : null,
    avgLossRNet: lossesNet.length ? netLossSum / lossesNet.length : null,
    avgCostAsPctOfRisk: trades.reduce((s, t) => s + (t.riskPerShare * t.shares > 0 ? t.costs / (t.riskPerShare * t.shares) : 0), 0) / count * 100,
  };
}

const SCORE_BUCKETS: Array<[number, number, string]> = [
  [0, 60, '<60'], [60, 70, '60-70'], [70, 80, '70-80'], [80, 90, '80-90'], [90, 101, '90+'],
];

export function scoreBucketFor(score: number): string {
  for (const [lo, hi, label] of SCORE_BUCKETS) if (score >= lo && score < hi) return label;
  return 'unknown';
}

export function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const list = out.get(k);
    if (list) list.push(item); else out.set(k, [item]);
  }
  return out;
}
