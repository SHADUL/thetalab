/**
 * Portfolio-level metrics — genuinely computable here, unlike swing's and
 * intraday's signal-level backtests, specifically BECAUSE simulate.ts
 * holds one position at a time. That constraint turns the trade sequence
 * into an honest chronological equity curve with no concurrent-position
 * capital-allocation ambiguity to resolve, which is exactly what
 * src/swing/backtest/metrics.ts and src/intraday/backtest/metrics.ts each
 * say, in their own header comments, they can't honestly provide.
 *
 * One real, stated limitation: Sharpe/Sortino below are computed from
 * PER-TRADE returns, not a true daily mark-to-market equity curve. Trades
 * here have irregular holding periods (a few days to a few weeks), so
 * annualizing per-trade returns is an approximation practitioners commonly
 * use, not the textbook daily-return Sharpe. A genuine daily-repricing
 * equity curve (re-marking every open day, not just entry/exit) would be
 * more correct and is a reasonable future improvement, not built here.
 *
 * DATA_END trades (the backtest window ran out before any real exit
 * condition triggered) are excluded from every metric below — same
 * "not a real outcome" treatment src/swing/backtest/simulate.ts already
 * establishes for its own out-of-data case.
 */
import type { SimulatedTrade } from './simulate.ts';

export interface EquityPoint {
  date: string;
  equity: number;
  tradeIndex: number;
}

export interface DrawdownResult {
  maxDrawdownAmount: number;
  maxDrawdownPct: number;
  peakDate: string | null;
  troughDate: string | null;
}

export interface BacktestMetrics {
  tradeCount: number;
  dataEndCount: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgHoldingDays: number | null;
  totalNetPnl: number;
  equityCurve: EquityPoint[];
  drawdown: DrawdownResult;
  /** Approximated from per-trade returns — see this file's header. Null with too few trades to mean anything (<10). */
  sharpe: number | null;
  sortino: number | null;
}

function realOutcomes(trades: SimulatedTrade[]): SimulatedTrade[] {
  return trades.filter((t) => t.exitReason !== 'DATA_END' && t.netPnl !== null);
}

export function buildEquityCurve(trades: SimulatedTrade[], startingCapital: number): EquityPoint[] {
  const ordered = realOutcomes(trades).slice().sort((a, b) => a.exitDate!.localeCompare(b.exitDate!));
  let equity = startingCapital;
  return ordered.map((t, i) => {
    equity += t.netPnl!;
    return { date: t.exitDate!, equity, tradeIndex: i };
  });
}

export function computeDrawdown(equityCurve: EquityPoint[]): DrawdownResult {
  let peak = equityCurve[0]?.equity ?? 0;
  let peakDate = equityCurve[0]?.date ?? null;
  let maxDrawdownAmount = 0;
  let maxDrawdownPct = 0;
  let troughDate: string | null = null;

  for (const point of equityCurve) {
    if (point.equity > peak) { peak = point.equity; peakDate = point.date; }
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdownAmount) {
      maxDrawdownAmount = drawdown;
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
      troughDate = point.date;
    }
  }
  return { maxDrawdownAmount, maxDrawdownPct, peakDate, troughDate };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

const MIN_TRADES_FOR_RATIOS = 10;

export function computeMetrics(trades: SimulatedTrade[], startingCapital: number): BacktestMetrics {
  const real = realOutcomes(trades);
  const wins = real.filter((t) => t.netPnl! > 0);
  const losses = real.filter((t) => t.netPnl! <= 0);
  const returns = real.map((t) => t.netPnl! / startingCapital);

  const equityCurve = buildEquityCurve(trades, startingCapital);
  const drawdown = computeDrawdown(equityCurve);

  const grossWin = wins.reduce((s, t) => s + t.netPnl!, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl!, 0));

  const avgReturn = mean(returns);
  const sd = stddev(returns, avgReturn);
  const downside = returns.filter((r) => r < 0);
  const downsideSd = downside.length >= 2 ? stddev(downside, mean(downside)) : 0;

  const holdingDays = real.map((t) => Math.round((Date.parse(t.exitDate!) - Date.parse(t.entryDate)) / 86_400_000));

  return {
    tradeCount: real.length,
    dataEndCount: trades.length - real.length,
    winRate: real.length ? (wins.length / real.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    expectancy: real.length ? mean(real.map((t) => t.netPnl!)) : null,
    avgWin: wins.length ? mean(wins.map((t) => t.netPnl!)) : null,
    avgLoss: losses.length ? mean(losses.map((t) => t.netPnl!)) : null,
    avgHoldingDays: holdingDays.length ? mean(holdingDays) : null,
    totalNetPnl: real.reduce((s, t) => s + t.netPnl!, 0),
    equityCurve,
    drawdown,
    sharpe: real.length >= MIN_TRADES_FOR_RATIOS && sd > 0 ? (avgReturn / sd) * Math.sqrt(real.length) : null,
    sortino: real.length >= MIN_TRADES_FOR_RATIOS && downsideSd > 0 ? (avgReturn / downsideSd) * Math.sqrt(real.length) : null,
  };
}

export interface MonteCarloResult {
  paths: number;
  medianFinalEquity: number;
  p5FinalEquity: number;
  p95FinalEquity: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  /** Fraction of simulated paths whose equity ever fell to zero or below. */
  probabilityOfRuin: number;
}

/**
 * Bootstrap resampling (with replacement) of the REAL trade P&L sequence
 * — a standard, well-understood technique for stress-testing a trade
 * distribution's tail risk independent of the specific order those trades
 * happened to occur in. Requires at least MIN_TRADES_FOR_RATIOS real
 * outcomes; returns null rather than a number built from too few samples
 * to mean anything.
 */
export function runMonteCarlo(trades: SimulatedTrade[], startingCapital: number, paths = 2000): MonteCarloResult | null {
  const real = realOutcomes(trades);
  if (real.length < MIN_TRADES_FOR_RATIOS) return null;
  const pnls = real.map((t) => t.netPnl!);

  const finalEquities: number[] = [];
  const maxDrawdownPcts: number[] = [];
  let ruinCount = 0;

  for (let p = 0; p < paths; p++) {
    let equity = startingCapital;
    let peak = equity;
    let maxDd = 0;
    let ruined = false;
    for (let i = 0; i < pnls.length; i++) {
      const sample = pnls[Math.floor(Math.random() * pnls.length)];
      equity += sample;
      if (equity <= 0) ruined = true;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }
    finalEquities.push(equity);
    maxDrawdownPcts.push(maxDd);
    if (ruined) ruinCount++;
  }

  finalEquities.sort((a, b) => a - b);
  maxDrawdownPcts.sort((a, b) => a - b);
  const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

  return {
    paths,
    medianFinalEquity: percentile(finalEquities, 0.5),
    p5FinalEquity: percentile(finalEquities, 0.05),
    p95FinalEquity: percentile(finalEquities, 0.95),
    medianMaxDrawdownPct: percentile(maxDrawdownPcts, 0.5),
    p95MaxDrawdownPct: percentile(maxDrawdownPcts, 0.95),
    probabilityOfRuin: ruinCount / paths,
  };
}
