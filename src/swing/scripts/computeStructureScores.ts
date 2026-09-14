/**
 * Runs the Structure Score (src/swing/structure) for one date across the
 * whole universe — the second, independent scanning strategy alongside
 * computeSwingScores.ts's weighted Momentum Score. Reads daily EMA20 /
 * 52-week-high from the already-computed `indicators` table, yesterday's
 * volume from `daily_ohlcv`, and weekly RSI14 / this-week-vs-last-week
 * high from `weekly_ohlcv` (computeWeeklyOhlcv.ts — run that first, and
 * re-run it before this each day the same way computeIndicators.ts is
 * kept current before this script runs).
 *
 * Only computes the given date (default: latest) using the latest weekly
 * bar as "this week," even if that week is still in progress — correct
 * for a live daily scan (today's own high really is known today), unlike
 * a backtest over past dates, which would need to only use weeks that
 * had actually closed as of each historical day (see the point-in-time
 * discipline in src/swing/backtest and the Chartink-strategy analysis
 * that motivated weekly.ts in the first place).
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/computeStructureScores.ts [YYYY-MM-DD]
 */
import { createClient } from '@supabase/supabase-js';
import type { Bar } from '../indicators/types.ts';
import { rsi } from '../indicators/oscillators.ts';
import { adjustForSplits } from '../indicators/splitAdjust.ts';
import { evaluateStructureSetup } from '../structure/evaluate.ts';
import { fetchAllPages } from './dbPaging.ts';

interface OhlcvRow { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number; }
interface WeeklyRow { symbol: string; week_start: string; week_end: string | null; open: number; high: number; low: number; close: number; volume: number; }
interface IndicatorRow { symbol: string; ema20: number | null; high_52w: number | null; }

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  let targetDate = process.argv[2];
  if (!targetDate) {
    const { data } = await supabase.from('daily_ohlcv').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (!data?.date) throw new Error('daily_ohlcv is empty — run the backfill first.');
    targetDate = data.date;
  }
  console.log(`Computing Structure Scores for ${targetDate}...`);

  console.log('Loading indicators for the target date...');
  const indicatorRows = await fetchAllPages<IndicatorRow>(
    supabase, 'indicators', 'symbol,ema20,high_52w', [['symbol', true]], (q) => q.eq('date', targetDate));
  const indicatorsBySymbol = new Map(indicatorRows.map((r) => [r.symbol, r]));
  if (indicatorsBySymbol.size === 0) throw new Error(`No indicators found for ${targetDate} — run computeIndicators.ts first.`);
  console.log(`  ${indicatorsBySymbol.size} symbols.`);

  console.log('Loading daily_ohlcv up to the target date (for close + yesterday\'s volume)...');
  const dailyRows = await fetchAllPages<OhlcvRow>(
    supabase, 'daily_ohlcv', 'symbol,date,open,high,low,close,volume', [['symbol', true], ['date', true]], (q) => q.lte('date', targetDate));
  const dailyBySymbol = new Map<string, Bar[]>();
  for (const r of dailyRows) {
    const list = dailyBySymbol.get(r.symbol) ?? [];
    list.push({ t: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    dailyBySymbol.set(r.symbol, list);
  }
  console.log(`  ${dailyRows.length} rows across ${dailyBySymbol.size} symbols.`);

  console.log('Loading weekly_ohlcv up to the target date...');
  const weeklyRows = await fetchAllPages<WeeklyRow>(
    supabase, 'weekly_ohlcv', 'symbol,week_start,week_end,open,high,low,close,volume', [['symbol', true], ['week_start', true]],
    (q) => q.lte('week_start', targetDate));
  const weeklyBySymbol = new Map<string, Bar[]>();
  for (const r of weeklyRows) {
    const list = weeklyBySymbol.get(r.symbol) ?? [];
    list.push({ t: r.week_end ?? r.week_start, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    weeklyBySymbol.set(r.symbol, list);
  }
  console.log(`  ${weeklyRows.length} weekly rows across ${weeklyBySymbol.size} symbols. Run computeWeeklyOhlcv.ts first if this is 0.`);

  const rows: Record<string, unknown>[] = [];
  let processed = 0, skipped = 0;

  for (const [symbol, ind] of indicatorsBySymbol) {
    const rawDaily = dailyBySymbol.get(symbol);
    const rawWeekly = weeklyBySymbol.get(symbol);
    if (!rawDaily || !rawWeekly || rawWeekly.length < 2) { skipped++; continue; }

    const daily = adjustForSplits(rawDaily);
    const asOfIdx = daily.findIndex((b) => b.t === targetDate);
    if (asOfIdx === -1) { skipped++; continue; } // no bar on this exact date (newly listed, halted, etc.)
    const close = daily[asOfIdx].c;
    const yesterdayVolume = asOfIdx > 0 ? daily[asOfIdx - 1].v : null;

    const weekly = adjustForSplits(rawWeekly);
    const weeklyCloses = weekly.map((b) => b.c);
    const weeklyRsiSeries = rsi(weeklyCloses, 14);
    const thisWeek = weekly[weekly.length - 1];
    const lastWeek = weekly[weekly.length - 2];
    const weeklyRsi14 = weeklyRsiSeries[weeklyRsiSeries.length - 1];

    const result = evaluateStructureSetup({
      close, ema20: ind.ema20, high52w: ind.high_52w, yesterdayVolume,
      weeklyRsi14, weeklyHigh: thisWeek?.h ?? null, prevWeeklyHigh: lastWeek?.h ?? null,
    });

    rows.push({
      symbol, date: targetDate, passes_all: result.passesAll, score: result.score,
      gate_price_floor: result.gates.priceFloor, gate_liquidity: result.gates.liquidity,
      gate_near_52w_high: result.gates.near52wHigh, gate_above_ema20: result.gates.aboveDailyEma20,
      gate_weekly_rsi_ceiling: result.gates.weeklyRsiCeiling, gate_weekly_higher_high: result.gates.weeklyHigherHigh,
      proximity_score: result.factors.proximity, trend_score: result.factors.trend,
      weekly_momentum_score: result.factors.weeklyMomentum, weekly_breakout_score: result.factors.weeklyBreakout,
      close,
      pct_of_52w_high: ind.high_52w ? (close / ind.high_52w) * 100 : null,
      pct_above_ema20: ind.ema20 ? ((close - ind.ema20) / ind.ema20) * 100 : null,
      weekly_rsi14: weeklyRsi14, weekly_high: thisWeek?.h ?? null, prev_weekly_high: lastWeek?.h ?? null,
    });
    processed++;
  }
  const qualifying = rows.filter((r) => r.passes_all).length;
  console.log(`Computed ${processed} symbols (${skipped} skipped — no indicators/weekly data/bar on this date). ${qualifying} pass every gate.`);

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('structure_scores').upsert(chunk, { onConflict: 'symbol,date' });
    if (error) throw error;
    written += chunk.length;
  }
  console.log(`Done. ${written} rows written to structure_scores.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
