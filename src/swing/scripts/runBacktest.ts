/**
 * Backtest Engine (spec §31-34) — the first real validation of whether the
 * Swing Score means anything. Reuses the exact same point-in-time pieces
 * the live scanner uses (detectPatterns/computeTradePlan/scoreSymbol,
 * indicators already computed historically by computeIndicators.ts) so
 * there is no second "backtest version" of the ranking logic to drift out
 * of sync with what's actually live.
 *
 * Methodology, stated plainly rather than left implicit:
 *  - A "signal" is only counted on the day a symbol's entryStatus
 *    TRANSITIONS into BUY_ZONE or BREAKOUT_CONFIRMED from something else —
 *    not every day it stays there. A stock sitting in BUY_ZONE for two
 *    weeks straight is one trading decision, not fourteen independent
 *    samples; counting every day would inflate the sample size with
 *    heavily correlated repeats of the same setup.
 *  - Every signal is simulated forward for a fixed window (default 20
 *    trading days — a "swing" horizon, not a day-trade or a buy-and-hold
 *    one) via simulateTrade(): TARGET hit, STOP hit, or TIMEOUT. A day
 *    whose range crosses both stop and target is resolved as STOP first —
 *    the conservative reading, since daily OHLC alone can't say which
 *    happened first intraday.
 *  - The stock universe is today's Nifty 500 membership (how this
 *    project's universe was seeded), not a historical point-in-time index
 *    membership each day — a real survivorship-bias caveat on these
 *    results that this script cannot correct, only disclose.
 *  - Reports hit rate / profit factor / expectancy by score bucket, by
 *    regime, and by setup type. Deliberately does NOT report drawdown,
 *    Sharpe, or Sortino — see src/swing/backtest/metrics.ts for why.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/runBacktest.ts [maxHoldingDays]
 */
import { createClient } from '@supabase/supabase-js';
import type { Bar } from '../indicators/types.ts';
import { ema } from '../indicators/movingAverages.ts';
import { adjustForSplits } from '../indicators/splitAdjust.ts';
import { detectPatterns } from '../patterns/detect.ts';
import type { SetupType } from '../patterns/types.ts';
import { computeTradePlan } from '../scoring/riskReward.ts';
import { scoreSymbol } from '../scoring/swingScore.ts';
import { computeSectorStrength, sectorScoreFor, type StockSectorInput, type SectorStrength } from '../scoring/sectorStrength.ts';
import { PRESETS, type PresetName } from '../scoring/presets.ts';
import { simulateTrade } from '../backtest/simulate.ts';
import { classifyRegimeSeries } from '../backtest/regime.ts';
import { computeMetrics, scoreBucketFor, groupBy } from '../backtest/metrics.ts';
import type { ScoredTrade, Regime } from '../backtest/types.ts';
import { fetchAllPages } from './dbPaging.ts';

interface OhlcvRow { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number; }
interface IndicatorRow {
  symbol: string; date: string; ema20: number | null; ema50: number | null; sma200: number | null;
  rsi14: number | null; adx14: number | null; atr14: number | null; atr_pct: number | null; vol_ratio: number | null;
  rs_vs_nifty_5d: number | null; rs_vs_nifty_20d: number | null; rs_vs_nifty_60d: number | null; rs_vs_nifty_120d: number | null;
}

const ACTIONABLE: ReadonlySet<string> = new Set(['BUY_ZONE', 'BREAKOUT_CONFIRMED']);
const MIN_ASOF_IDX = 60; // warm-up floor — enough bars for EMA50/consolidation windows to mean something
const EMA20_TREND_LOOKBACK = 5;

// Mirrors computeSwingScores.ts's local helper — small enough that a
// shared module would be more indirection than the duplication costs.
const SETUP_PRIORITY: SetupType[] = [
  'ATH_BREAKOUT', 'BREAKOUT', 'PULLBACK', 'VOLUME_ACCUMULATION',
  'EARLY_BREAKOUT', 'TREND_CONTINUATION', 'EXTENDED', 'FAILED_BREAKOUT_RISK',
];
function primarySetupType(setupTypes: SetupType[]): SetupType {
  for (const candidate of SETUP_PRIORITY) if (setupTypes.includes(candidate)) return candidate;
  return setupTypes[0] ?? 'TREND_CONTINUATION';
}

function summarize(trades: ScoredTrade[]) {
  const overall = computeMetrics(trades);
  const byBucket = Object.fromEntries(
    [...groupBy(trades, (t) => scoreBucketFor(t.score))].map(([bucket, ts]) => [bucket, { ...computeMetrics(ts), sampleScoreAvg: ts.reduce((s, t) => s + t.score, 0) / ts.length }]),
  );
  const byRegime = Object.fromEntries(
    [...groupBy(trades, (t) => (t.regime ?? 'UNKNOWN') as string)].map(([regime, ts]) => [regime, computeMetrics(ts)]),
  );
  const bySetup = Object.fromEntries(
    [...groupBy(trades, (t) => t.setupType)].map(([setup, ts]) => [setup, computeMetrics(ts)]),
  );
  return { overall, byScoreBucket: byBucket, byRegime, bySetupType: bySetup };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const maxHoldingDays = Number(process.argv[2] ?? 20);
  console.log(`Backtest: maxHoldingDays=${maxHoldingDays}, actionable statuses=${[...ACTIONABLE].join('/')}`);

  console.log('Loading stocks (sector map — includes inactive/delisted, to avoid survivorship bias on that axis)...');
  const stocksData = await fetchAllPages<{ symbol: string; sector: string | null }>(supabase, 'stocks', 'symbol,sector', [['symbol', true]]);
  const sectorBySymbol = new Map(stocksData.map((s) => [s.symbol, s.sector]));
  console.log(`  ${sectorBySymbol.size} symbols.`);

  console.log('Loading NIFTY close history for regime classification...');
  const regimeRows = await fetchAllPages<{ date: string; nifty_close: number | null }>(supabase, 'market_regime', 'date,nifty_close', [['date', true]]);
  const niftyDates = regimeRows.filter((r) => r.nifty_close != null).map((r) => r.date);
  const niftyCloses = regimeRows.filter((r) => r.nifty_close != null).map((r) => r.nifty_close!);
  const regimeByDate: Map<string, Regime> = classifyRegimeSeries(niftyDates, niftyCloses);
  console.log(`  ${regimeByDate.size} dates classified.`);

  console.log('Loading full indicators history (this is the slow part — ~340k rows)...');
  const indicatorRows = await fetchAllPages<IndicatorRow>(
    supabase, 'indicators',
    'symbol,date,ema20,ema50,sma200,rsi14,adx14,atr14,atr_pct,vol_ratio,rs_vs_nifty_5d,rs_vs_nifty_20d,rs_vs_nifty_60d,rs_vs_nifty_120d',
    [['symbol', true], ['date', true]],
  );
  console.log(`  ${indicatorRows.length} indicator rows.`);
  const indicatorsBySymbol = new Map<string, Map<string, IndicatorRow>>();
  const indicatorRowsByDate = new Map<string, IndicatorRow[]>();
  for (const row of indicatorRows) {
    let bySym = indicatorsBySymbol.get(row.symbol);
    if (!bySym) { bySym = new Map(); indicatorsBySymbol.set(row.symbol, bySym); }
    bySym.set(row.date, row);
    const list = indicatorRowsByDate.get(row.date);
    if (list) list.push(row); else indicatorRowsByDate.set(row.date, [row]);
  }

  console.log('Loading full daily_ohlcv history...');
  const ohlcvRows = await fetchAllPages<OhlcvRow>(supabase, 'daily_ohlcv', 'symbol,date,open,high,low,close,volume', [['symbol', true], ['date', true]]);
  console.log(`  ${ohlcvRows.length} OHLCV rows.`);
  const rawBarsBySymbol = new Map<string, Bar[]>();
  for (const r of ohlcvRows) {
    const list = rawBarsBySymbol.get(r.symbol) ?? [];
    list.push({ t: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    rawBarsBySymbol.set(r.symbol, list);
  }
  const adjustedBarsBySymbol = new Map<string, Bar[]>();
  const closeBySymbolDate = new Map<string, Map<string, number>>();
  for (const [symbol, raw] of rawBarsBySymbol) {
    const adjusted = adjustForSplits(raw);
    adjustedBarsBySymbol.set(symbol, adjusted);
    closeBySymbolDate.set(symbol, new Map(adjusted.map((b) => [b.t, b.c])));
  }

  console.log('Computing daily sector strength across the whole universe (one pass per date)...');
  const sectorStrengthByDate = new Map<string, Map<string, SectorStrength>>();
  for (const [date, rows] of indicatorRowsByDate) {
    const inputs: StockSectorInput[] = rows.map((r) => {
      const close = closeBySymbolDate.get(r.symbol)?.get(date) ?? null;
      return {
        symbol: r.symbol, sector: sectorBySymbol.get(r.symbol) ?? null,
        return20d: r.rs_vs_nifty_20d, return60d: r.rs_vs_nifty_60d,
        aboveEma20: close != null && r.ema20 != null ? close > r.ema20 : null,
        aboveEma50: close != null && r.ema50 != null ? close > r.ema50 : null,
      };
    });
    sectorStrengthByDate.set(date, computeSectorStrength(inputs));
  }
  console.log(`  ${sectorStrengthByDate.size} dates.`);

  console.log('Generating signals and simulating outcomes...');
  const presetNames = Object.keys(PRESETS) as PresetName[];
  const allTrades: ScoredTrade[] = [];
  let signalsSeen = 0, skippedNoStop = 0, symbolsProcessed = 0;

  for (const [symbol, bars] of adjustedBarsBySymbol) {
    if (bars.length < MIN_ASOF_IDX + 1) continue;
    const symbolIndicators = indicatorsBySymbol.get(symbol);
    if (!symbolIndicators) continue;
    const ema20Series = ema(bars.map((b) => b.c), 20);
    const sector = sectorBySymbol.get(symbol) ?? null;

    let wasActionable = false;
    for (let asOfIdx = MIN_ASOF_IDX; asOfIdx < bars.length; asOfIdx++) {
      const date = bars[asOfIdx].t;
      const ind = symbolIndicators.get(date);
      if (!ind) { wasActionable = false; continue; }

      const pattern = detectPatterns(bars, asOfIdx);
      const isActionable = ACTIONABLE.has(pattern.entryStatus);
      const isNewSignal = isActionable && !wasActionable;
      wasActionable = isActionable;
      if (!isNewSignal) continue;

      signalsSeen++;
      const price = bars[asOfIdx].c;
      const tradePlan = computeTradePlan({ price, atr: ind.atr14, ema20: ind.ema20, ema50: ind.ema50, pattern });
      if (tradePlan.stop == null) { skippedNoStop++; continue; }

      const sim = simulateTrade(bars, asOfIdx, tradePlan.stop, tradePlan.target, maxHoldingDays);
      if (!sim) continue;

      const ema20Rising = asOfIdx >= EMA20_TREND_LOOKBACK && ema20Series[asOfIdx] != null && ema20Series[asOfIdx - EMA20_TREND_LOOKBACK] != null
        ? ema20Series[asOfIdx]! > ema20Series[asOfIdx - EMA20_TREND_LOOKBACK]!
        : null;
      const sectorScore = sectorScoreFor(sector, sectorStrengthByDate.get(date) ?? new Map());
      const setupType = primarySetupType(pattern.setupTypes);
      const regime = regimeByDate.get(date) ?? null;

      for (const presetName of presetNames) {
        const result = scoreSymbol({
          price, ema20: ind.ema20, ema50: ind.ema50, sma200: ind.sma200, ema20Rising,
          rsi14: ind.rsi14, adx14: ind.adx14,
          rs5d: ind.rs_vs_nifty_5d, rs20d: ind.rs_vs_nifty_20d, rs60d: ind.rs_vs_nifty_60d, rs120d: ind.rs_vs_nifty_120d,
          volRatio: ind.vol_ratio, atr: ind.atr14, atrPct: ind.atr_pct,
          sectorScore, pattern,
        }, presetName);

        allTrades.push({
          ...sim, symbol, preset: presetName.toLowerCase(), score: result.score,
          setupType, entryStatus: pattern.entryStatus, regime,
        });
      }
    }
    symbolsProcessed++;
    if (symbolsProcessed % 50 === 0) console.log(`  ${symbolsProcessed}/${adjustedBarsBySymbol.size} symbols, ${signalsSeen} signals so far...`);
  }

  console.log(`Done generating: ${symbolsProcessed} symbols, ${signalsSeen} signals, ${skippedNoStop} skipped (no structural stop), ${allTrades.length} scored trades (signals x ${presetNames.length} presets).`);

  const dataEndCount = allTrades.filter((t) => t.exitReason === 'DATA_END').length;
  if (dataEndCount > 0) console.log(`  ${dataEndCount} trade-rows excluded from metrics as DATA_END (too recent to know the outcome yet).`);

  console.log('\n=== Results by preset ===\n');
  const summaryByPreset: Record<string, ReturnType<typeof summarize>> = {};
  for (const presetName of presetNames) {
    const preset = presetName.toLowerCase();
    const presetTrades = allTrades.filter((t) => t.preset === preset);
    const summary = summarize(presetTrades);
    summaryByPreset[preset] = summary;

    const o = summary.overall;
    console.log(`--- ${presetName} (${o.count} trades) ---`);
    console.log(`  Target-hit rate: ${o.targetHitRate != null ? (o.targetHitRate * 100).toFixed(1) + '%' : '—'}   Positive-return rate: ${o.positiveReturnRate != null ? (o.positiveReturnRate * 100).toFixed(1) + '%' : '—'}`);
    console.log(`  Profit factor: ${o.profitFactor?.toFixed(2) ?? '—'}   Expectancy: ${o.expectancyPct?.toFixed(2) ?? '—'}%   Avg holding: ${o.avgHoldingDays?.toFixed(1) ?? '—'} days`);
    console.log('  By score bucket:');
    for (const [bucket, m] of Object.entries(summary.byScoreBucket)) {
      console.log(`    ${bucket.padEnd(6)}  n=${String(m.count).padEnd(5)}  target-hit=${m.targetHitRate != null ? (m.targetHitRate * 100).toFixed(1) + '%' : '—'}  expectancy=${m.expectancyPct?.toFixed(2) ?? '—'}%`);
    }
    console.log('  By regime:');
    for (const [regime, m] of Object.entries(summary.byRegime)) {
      console.log(`    ${regime.padEnd(9)}  n=${String(m.count).padEnd(5)}  target-hit=${m.targetHitRate != null ? (m.targetHitRate * 100).toFixed(1) + '%' : '—'}  expectancy=${m.expectancyPct?.toFixed(2) ?? '—'}%`);
    }
    console.log('');
  }

  console.log('Writing run summary to backtest_runs...');
  const { error } = await supabase.from('backtest_runs').insert({
    params: { maxHoldingDays, actionableStatuses: [...ACTIONABLE], minAsOfIdx: MIN_ASOF_IDX, presets: presetNames.map((p) => p.toLowerCase()) },
    summary: { signalsSeen, skippedNoStop, dataEndCount, byPreset: summaryByPreset },
  });
  if (error) throw error;
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
