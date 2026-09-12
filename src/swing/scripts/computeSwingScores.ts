/**
 * Runs the full Ranking Engine (spec §53) for one date across the whole
 * universe: Pattern Engine off each symbol's adjusted price history,
 * factor scores off the already-computed `indicators` row for that date
 * (not recomputed here — computeIndicators.ts is the single source of
 * truth for those), sector strength computed once across every symbol
 * present, then the composite Swing Score under every weight preset.
 *
 * Writes one row per symbol per date per preset into `swing_scores` — all
 * six presets in the same pass, since the factor scores are computed once
 * and combining them under a different weight vector is nearly free. That
 * makes preset-switching in the UI a read-time choice, not a recompute.
 *
 * Only computes the given date (default: the latest date in daily_ohlcv) —
 * unlike computeIndicators.ts, this does not backfill full history yet.
 * Scoring every historical day for every symbol is what the backtest
 * engine (spec §31) will need, and is deliberately a separate, later pass:
 * running it here for every symbol on every one of ~750 days would be a
 * lot of wasted work before there's a backtest to consume it.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/computeSwingScores.ts [YYYY-MM-DD]
 */
import { createClient } from '@supabase/supabase-js';
import type { Bar } from '../indicators/types.ts';
import { ema } from '../indicators/movingAverages.ts';
import { adjustForSplits } from '../indicators/splitAdjust.ts';
import { detectPatterns } from '../patterns/detect.ts';
import type { SetupType } from '../patterns/types.ts';
import { scoreSymbol } from '../scoring/swingScore.ts';
import { computeSectorStrength, sectorScoreFor, type StockSectorInput } from '../scoring/sectorStrength.ts';
import { PRESETS, type PresetName } from '../scoring/presets.ts';
import { fetchAllPages } from './dbPaging.ts';

interface OhlcvRow { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number; }
interface IndicatorRow {
  symbol: string; ema20: number | null; ema50: number | null; sma200: number | null;
  rsi14: number | null; adx14: number | null; atr14: number | null; atr_pct: number | null; vol_ratio: number | null;
  rs_vs_nifty_5d: number | null; rs_vs_nifty_20d: number | null; rs_vs_nifty_60d: number | null; rs_vs_nifty_120d: number | null;
}

// Most "exciting"/actionable tag first — what spec §23 means by "the
// primary setup should be shown prominently." Warning-style tags
// (EXTENDED, FAILED_BREAKOUT_RISK) only become the primary label when
// nothing more constructive is also present.
const SETUP_PRIORITY: SetupType[] = [
  'ATH_BREAKOUT', 'BREAKOUT', 'PULLBACK', 'VOLUME_ACCUMULATION',
  'EARLY_BREAKOUT', 'TREND_CONTINUATION', 'EXTENDED', 'FAILED_BREAKOUT_RISK',
];
function primarySetupType(setupTypes: SetupType[]): SetupType {
  for (const candidate of SETUP_PRIORITY) if (setupTypes.includes(candidate)) return candidate;
  return setupTypes[0] ?? 'TREND_CONTINUATION';
}

const EMA20_TREND_LOOKBACK = 5; // sessions back to compare against for "rising"

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
  console.log(`Scoring universe for ${targetDate}...`);

  const { data: stocksData, error: stocksErr } = await supabase.from('stocks').select('symbol,sector').eq('active', true);
  if (stocksErr) throw stocksErr;
  const sectorBySymbol = new Map<string, string | null>((stocksData ?? []).map((s: { symbol: string; sector: string | null }) => [s.symbol, s.sector]));

  console.log('Loading indicators for the target date...');
  const indicatorRows = await fetchAllPages<IndicatorRow>(
    supabase, 'indicators',
    'symbol,ema20,ema50,sma200,rsi14,adx14,atr14,atr_pct,vol_ratio,rs_vs_nifty_5d,rs_vs_nifty_20d,rs_vs_nifty_60d,rs_vs_nifty_120d',
    [['symbol', true]], (q) => q.eq('date', targetDate),
  );
  const indicatorsBySymbol = new Map(indicatorRows.map((r) => [r.symbol, r]));
  if (indicatorsBySymbol.size === 0) throw new Error(`No indicators found for ${targetDate} — run computeIndicators.ts for this date first.`);
  console.log(`  ${indicatorsBySymbol.size} symbols have indicators for this date.`);

  console.log('Loading full daily_ohlcv (needed for pattern detection)...');
  const allOhlcv = await fetchAllPages<OhlcvRow>(
    supabase, 'daily_ohlcv', 'symbol,date,open,high,low,close,volume',
    [['symbol', true], ['date', true]], (q) => q.lte('date', targetDate),
  );
  const barsBySymbol = new Map<string, Bar[]>();
  for (const r of allOhlcv) {
    const list = barsBySymbol.get(r.symbol) ?? [];
    list.push({ t: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    barsBySymbol.set(r.symbol, list);
  }
  console.log(`  ${allOhlcv.length} rows across ${barsBySymbol.size} symbols.`);

  // Sector strength needs every symbol's return + breadth at once — computed
  // here, before the per-symbol loop, since it's inherently a
  // whole-universe statistic (spec §15), not something one stock's own
  // data could produce on its own.
  const sectorInputs: StockSectorInput[] = [];
  for (const [symbol, ind] of indicatorsBySymbol) {
    const bars = barsBySymbol.get(symbol);
    const lastClose = bars?.length ? adjustForSplits(bars)[bars.length - 1].c : null;
    sectorInputs.push({
      symbol, sector: sectorBySymbol.get(symbol) ?? null,
      return20d: ind.rs_vs_nifty_20d, return60d: ind.rs_vs_nifty_60d,
      aboveEma20: lastClose != null && ind.ema20 != null ? lastClose > ind.ema20 : null,
      aboveEma50: lastClose != null && ind.ema50 != null ? lastClose > ind.ema50 : null,
    });
  }
  const sectorStrengths = computeSectorStrength(sectorInputs);

  const presetNames = Object.keys(PRESETS) as PresetName[];
  let processed = 0, skipped = 0;
  const allRows: Record<string, unknown>[] = [];

  for (const [symbol, ind] of indicatorsBySymbol) {
    const rawBars = barsBySymbol.get(symbol);
    if (!rawBars || rawBars.length < 20) { skipped++; continue; } // not enough history to pattern-detect meaningfully
    const bars = adjustForSplits(rawBars);
    const asOfIdx = bars.findIndex((b) => b.t === targetDate);
    if (asOfIdx === -1) { skipped++; continue; } // symbol has no bar on this exact date (e.g. newly listed, or halted)

    const pattern = detectPatterns(bars, asOfIdx);

    const closes = bars.slice(0, asOfIdx + 1).map((b) => b.c);
    const ema20Series = ema(closes, 20);
    const ema20Rising = asOfIdx >= EMA20_TREND_LOOKBACK && ema20Series[asOfIdx] != null && ema20Series[asOfIdx - EMA20_TREND_LOOKBACK] != null
      ? ema20Series[asOfIdx]! > ema20Series[asOfIdx - EMA20_TREND_LOOKBACK]!
      : null;

    const sectorScore = sectorScoreFor(sectorBySymbol.get(symbol) ?? null, sectorStrengths);

    for (const presetName of presetNames) {
      const result = scoreSymbol({
        price: bars[asOfIdx].c,
        ema20: ind.ema20, ema50: ind.ema50, sma200: ind.sma200, ema20Rising,
        rsi14: ind.rsi14, adx14: ind.adx14,
        rs5d: ind.rs_vs_nifty_5d, rs20d: ind.rs_vs_nifty_20d, rs60d: ind.rs_vs_nifty_60d, rs120d: ind.rs_vs_nifty_120d,
        volRatio: ind.vol_ratio, atr: ind.atr14, atrPct: ind.atr_pct,
        sectorScore, pattern,
      }, presetName);

      allRows.push({
        symbol, date: targetDate, preset: presetName.toLowerCase(),
        trend_score: result.factors.trend, momentum_score: result.factors.momentum,
        relative_strength_score: result.factors.relativeStrength, setup_score: result.factors.setup,
        volume_score: result.factors.volume, sector_score: result.factors.sector,
        volatility_score: result.factors.volatility, risk_reward_score: result.factors.riskReward,
        swing_score: result.score,
        setup_type: primarySetupType(pattern.setupTypes),
        entry_status: pattern.entryStatus,
        extension_risk: pattern.extensionRisk,
        entry: result.tradePlan.entry, stop: result.tradePlan.stop,
        target: result.tradePlan.target, risk_reward: result.tradePlan.riskReward,
      });
    }
    processed++;
  }
  console.log(`Computed scores for ${processed} symbols (${skipped} skipped — insufficient history or no bar on this date), ${presetNames.length} presets each.`);

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    const { error } = await supabase.from('swing_scores').upsert(chunk, { onConflict: 'symbol,date,preset' });
    if (error) throw error;
    written += chunk.length;
  }
  console.log(`Done. ${written} rows written to swing_scores.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
