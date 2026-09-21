/**
 * CLI backtest runner — fetches real NSE/BSE bhavcopy for a date range,
 * replays it through the exact production decision + exit pipeline
 * (simulate.ts), and reports the resulting trades and portfolio metrics.
 *
 * Usage:
 *   node --experimental-strip-types src/options-auto/scripts/runBacktest.ts SYMBOL FROM_DATE TO_DATE [capital]
 *   node --experimental-strip-types src/options-auto/scripts/runBacktest.ts NIFTY 2024-01-01 2025-12-31 500000
 */
import { fetchHistoricalChainDay } from './fetchBhavcopy.ts';
import { simulateSymbol, type SimulateParams } from '../backtest/simulate.ts';
import { computeMetrics, runMonteCarlo } from '../backtest/metrics.ts';

function fmtInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function eachDate(fromISO: string, toISO: string): string[] {
  const dates: string[] = [];
  let cur = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  while (cur <= end) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return dates;
}

async function main() {
  const [symbol, fromDate, toDate, capitalArg] = process.argv.slice(2);
  if (!symbol || !fromDate || !toDate) {
    console.error('Usage: runBacktest.ts SYMBOL FROM_DATE TO_DATE [capital]');
    process.exit(1);
  }
  const capital = capitalArg ? Number(capitalArg) : 500_000;

  const candidateDates = eachDate(fromDate, toDate);
  console.log(`Fetching ${candidateDates.length} weekday(s) of bhavcopy for ${symbol} (${fromDate} to ${toDate})...`);

  const days = [];
  let fetched = 0, missing = 0;
  for (const date of candidateDates) {
    const day = await fetchHistoricalChainDay(symbol, date);
    if (day && day.rows.length > 0) { days.push(day); fetched++; }
    else missing++;
    if ((fetched + missing) % 50 === 0) console.log(`  ...${fetched + missing}/${candidateDates.length} (${fetched} with data, ${missing} missing/holiday)`);
  }
  console.log(`Done: ${fetched} trading days with real data, ${missing} missing (weekends/holidays already excluded from the candidate list; this is bhavcopy-not-found days within it).`);

  if (days.length < 10) {
    console.error('Fewer than 10 trading days of real data — not enough to run a meaningful backtest.');
    process.exit(1);
  }

  // An empty list here is intentional: simulate.ts falls back to
  // [2,4,6] x that day's own inferred strike step when none is supplied,
  // which adapts correctly per symbol (NIFTY/BANKNIFTY ~50-100pt steps,
  // SENSEX ~100pt) without a hardcoded guess here.
  const params: SimulateParams = { wingWidths: [] };

  console.log(`\nSimulating ${symbol} from ${days[0].date} to ${days[days.length - 1].date}...`);
  const trades = simulateSymbol(days, symbol, params);
  const metrics = computeMetrics(trades, capital);
  const monteCarlo = runMonteCarlo(trades, capital);

  console.log(`\n=== ${symbol} backtest: ${fromDate} to ${toDate} (starting capital ${fmtInr(capital)}) ===`);
  console.log(`Trades: ${metrics.tradeCount} real outcome(s), ${metrics.dataEndCount} still-open-at-window-end (excluded from stats)`);
  if (metrics.tradeCount === 0) {
    console.log('No trades were entered in this window — either no candidate ever cleared the quality threshold, or the DTE/strike data was too sparse. Not necessarily a bug: "the system must be comfortable doing nothing" is the whole point of the NO_TRADE engine.');
    return;
  }
  console.log(`Win rate: ${metrics.winRate!.toFixed(1)}%`);
  console.log(`Profit factor: ${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor!.toFixed(2) : '∞ (no losing trades)'}`);
  console.log(`Expectancy per trade: ${fmtInr(metrics.expectancy!)}`);
  console.log(`Avg win: ${fmtInr(metrics.avgWin ?? 0)} | Avg loss: ${fmtInr(metrics.avgLoss ?? 0)}`);
  console.log(`Avg holding period: ${metrics.avgHoldingDays!.toFixed(1)} days`);
  console.log(`Total net P&L: ${fmtInr(metrics.totalNetPnl)}`);
  console.log(`Max drawdown: ${fmtInr(metrics.drawdown.maxDrawdownAmount)} (${metrics.drawdown.maxDrawdownPct.toFixed(1)}%), peak ${metrics.drawdown.peakDate} -> trough ${metrics.drawdown.troughDate}`);
  console.log(`Sharpe (per-trade approximation — see metrics.ts header): ${metrics.sharpe?.toFixed(2) ?? 'n/a (fewer than 10 trades)'}`);
  console.log(`Sortino: ${metrics.sortino?.toFixed(2) ?? 'n/a (fewer than 10 trades)'}`);

  if (monteCarlo) {
    console.log(`\n=== Monte Carlo (${monteCarlo.paths} bootstrap paths over the real trade sequence) ===`);
    console.log(`Median final equity: ${fmtInr(monteCarlo.medianFinalEquity)} (5th pct: ${fmtInr(monteCarlo.p5FinalEquity)}, 95th pct: ${fmtInr(monteCarlo.p95FinalEquity)})`);
    console.log(`Median max drawdown: ${monteCarlo.medianMaxDrawdownPct.toFixed(1)}% (95th pct: ${monteCarlo.p95MaxDrawdownPct.toFixed(1)}%)`);
    console.log(`Probability of ruin (equity hit zero on a simulated path): ${(monteCarlo.probabilityOfRuin * 100).toFixed(2)}%`);
  } else {
    console.log('\nMonte Carlo skipped — fewer than 10 real trade outcomes to bootstrap from.');
  }

  console.log('\n=== Every trade ===');
  for (const t of trades) {
    const pnlStr = t.netPnl != null ? fmtInr(t.netPnl) : 'n/a';
    console.log(`${t.entryDate} -> ${t.exitDate ?? '(open)'} | ${t.strategyLabel} | score ${t.qualityScore.toFixed(0)} | ${t.exitReason ?? 'OPEN'} | net P&L ${pnlStr}`);
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
