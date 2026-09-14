import type { SimulatedTrade, TradeMetrics } from './types.ts';

/**
 * Deliberately does NOT compute drawdown, Sharpe, or Sortino — those need
 * a single coherent equity curve from a real portfolio simulation (capital
 * constraints, concurrent positions, sizing), not a bag of independent,
 * overlapping signal-level trades. Reporting a fabricated Sharpe from
 * this data would look precise while meaning very little; what's below
 * (hit rate, profit factor, expectancy) is what a signal-level backtest
 * can honestly say. A rotation-aware portfolio backtest — literally
 * simulating what api/swing-autotrade-tick.js does, historically — is the
 * natural next phase for the rest.
 */
export function computeMetrics(trades: SimulatedTrade[]): TradeMetrics {
  const scored = trades.filter((t) => t.exitReason !== 'DATA_END');
  const count = scored.length;
  if (count === 0) {
    return {
      count: 0, targetHitRate: null, positiveReturnRate: null, profitFactor: null,
      expectancyPct: null, avgWinPct: null, avgLossPct: null, avgHoldingDays: null,
    };
  }

  const targetHits = scored.filter((t) => t.exitReason === 'TARGET').length;
  const wins = scored.filter((t) => t.returnPct > 0);
  const losses = scored.filter((t) => t.returnPct <= 0);
  const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = losses.reduce((s, t) => s + t.returnPct, 0); // <= 0

  return {
    count,
    targetHitRate: targetHits / count,
    positiveReturnRate: wins.length / count,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? null : 0) : grossWin / Math.abs(grossLoss),
    expectancyPct: scored.reduce((s, t) => s + t.returnPct, 0) / count,
    avgWinPct: wins.length ? grossWin / wins.length : null,
    avgLossPct: losses.length ? grossLoss / losses.length : null,
    avgHoldingDays: scored.reduce((s, t) => s + t.holdingDays, 0) / count,
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
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
