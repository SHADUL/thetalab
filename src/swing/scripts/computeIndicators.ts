/**
 * Runs the indicator engine (src/swing/indicators) over every symbol's full
 * daily_ohlcv history and writes one row per symbol per day into
 * `indicators` — not just the latest day, even though that's all the
 * scanner UI will read at first, because the backtest engine (spec §31)
 * needs the whole history and computing it twice later would mean two
 * implementations to keep in sync instead of one.
 *
 * Relative strength reads NIFTY's close from market_regime (seeded by
 * seedNiftyClose.ts) joined by date, not by array position — the two
 * series can have minor date differences at the edges and joining by date
 * degrades to null there instead of silently misaligning.
 *
 * "ATH" here means the highest high seen within the data this project
 * actually has (currently ~3 years back), not a verified true all-time
 * high — flagged in the column's own naming/comments rather than presented
 * as more than it is.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/computeIndicators.ts [symbol]
 *
 * An optional single symbol arg recomputes just that one, for spot-checking
 * without waiting on the full universe.
 */
import { createClient } from '@supabase/supabase-js';
import type { Bar } from '../indicators/types.ts';
import { ema, sma } from '../indicators/movingAverages.ts';
import { rsi, macd } from '../indicators/oscillators.ts';
import { atr, atrPct, adx } from '../indicators/trend.ts';
import { bollinger } from '../indicators/bands.ts';
import { volumeRatio } from '../indicators/volume.ts';
import { adjustForSplits } from '../indicators/splitAdjust.ts';

interface OhlcvRow { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number; }

const TRADING_DAYS_52W = 252;

function rollingMax(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    out[i] = Math.max(...values.slice(start, i + 1));
  }
  return out;
}
function rollingMin(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    out[i] = Math.min(...values.slice(start, i + 1));
  }
  return out;
}
function cumMax(values: number[]): number[] {
  const out: number[] = new Array(values.length);
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) { m = Math.max(m, values[i]); out[i] = m; }
  return out;
}
function returnOver(closes: number[], i: number, n: number): number | null {
  if (i - n < 0) return null;
  const prev = closes[i - n];
  return prev === 0 ? null : ((closes[i] - prev) / prev) * 100;
}
function pct(a: number, b: number | null): number | null {
  return b == null || b === 0 ? null : ((a - b) / b) * 100;
}

/** Pure: takes one symbol's bars (ascending by date, raw/unadjusted) plus a
 *  date->NIFTY-close lookup, returns one row per bar ready to upsert into
 *  `indicators`. Split/bonus-adjusts internally before computing anything —
 *  every indicator here is derived from the adjusted series, never the raw
 *  one, so a caller can't accidentally skip that step. */
export function computeSymbolIndicators(rawBars: Bar[], niftyClose: Map<string, number>) {
  const bars = adjustForSplits(rawBars);
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const volumes = bars.map((b) => b.v);

  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema100 = ema(closes, 100), sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const adx14 = adx(bars, 14);
  const atr14 = atr(bars, 14), atrPct14 = atrPct(bars, 14);
  const macdSeries = macd(closes);
  const bb = bollinger(closes, 20);
  const volRatio = volumeRatio(volumes, 20);
  const high52w = rollingMax(highs, TRADING_DAYS_52W);
  const low52w = rollingMin(lows, TRADING_DAYS_52W);
  const ath = cumMax(highs);

  const niftySeries = bars.map((b) => niftyClose.get(b.t) ?? null);

  return bars.map((b, i) => {
    const stockR5 = returnOver(closes, i, 5), stockR20 = returnOver(closes, i, 20);
    const stockR60 = returnOver(closes, i, 60), stockR120 = returnOver(closes, i, 120);
    const niftyAt = (n: number) => (i - n < 0 ? null : niftySeries[i - n]);
    const niftyRetOver = (n: number) => {
      const cur = niftySeries[i], prev = niftyAt(n);
      return cur == null || prev == null || prev === 0 ? null : ((cur - prev) / prev) * 100;
    };

    return {
      symbol: undefined as unknown as string, // filled by the caller, which knows the symbol
      date: b.t,
      ema20: ema20[i], ema50: ema50[i], ema100: ema100[i], sma200: sma200[i],
      rsi14: rsi14[i],
      adx14: adx14[i]?.adx ?? null, plus_di: adx14[i]?.plusDI ?? null, minus_di: adx14[i]?.minusDI ?? null,
      atr14: atr14[i], atr_pct: atrPct14[i],
      macd: macdSeries[i]?.macd ?? null, macd_signal: macdSeries[i]?.signal ?? null, macd_histogram: macdSeries[i]?.histogram ?? null,
      bb_upper: bb[i]?.upper ?? null, bb_lower: bb[i]?.lower ?? null, bb_bandwidth_pct: bb[i]?.bandwidthPct ?? null,
      vol_avg20: sma(volumes, 20)[i], vol_avg50: sma(volumes, 50)[i], vol_ratio: volRatio[i],
      high_52w: high52w[i], low_52w: low52w[i], high_ath: ath[i],
      dist_52w_high_pct: pct(b.c, high52w[i]), dist_ath_pct: pct(b.c, ath[i]),
      rs_vs_nifty_5d: stockR5 != null && niftyRetOver(5) != null ? stockR5 - niftyRetOver(5)! : null,
      rs_vs_nifty_20d: stockR20 != null && niftyRetOver(20) != null ? stockR20 - niftyRetOver(20)! : null,
      rs_vs_nifty_60d: stockR60 != null && niftyRetOver(60) != null ? stockR60 - niftyRetOver(60)! : null,
      rs_vs_nifty_120d: stockR120 != null && niftyRetOver(120) != null ? stockR120 - niftyRetOver(120)! : null,
      rs_vs_sector_20d: null, // needs sector_strength built first — separate pass
    };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js's generic client type
// doesn't unify cleanly across separately-inferred createClient() calls; this script only ever
// touches .from().select().order().range(), so the precision isn't worth fighting for here.
//
// PostgREST caps any unpaginated select() at a default row limit (1000) —
// silently, no error, no indication which rows survived without an
// explicit order. Every multi-row read in this script goes through this
// one paginator specifically so that cap can never bite again quietly.
async function fetchAllPages<T>(
  supabase: any, table: string, select: string, orderBy: [string, boolean][], filter?: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    let query = supabase.from(table).select(select);
    for (const [col, asc] of orderBy) query = query.order(col, { ascending: asc });
    if (filter) query = filter(query);
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchAllOhlcv(supabase: any, onlySymbol?: string): Promise<OhlcvRow[]> {
  return fetchAllPages<OhlcvRow>(
    supabase, 'daily_ohlcv', 'symbol,date,open,high,low,close,volume',
    [['symbol', true], ['date', true]],
    onlySymbol ? (q: any) => q.eq('symbol', onlySymbol) : undefined,
  );
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const onlySymbol = process.argv[2];

  console.log('Loading NIFTY close history...');
  const regimeRows = await fetchAllPages<{ date: string; nifty_close: number | null }>(
    supabase, 'market_regime', 'date,nifty_close', [['date', true]]);
  const niftyClose = new Map<string, number>(
    regimeRows.filter((r) => r.nifty_close != null).map((r) => [r.date, r.nifty_close!]));
  console.log(`  ${niftyClose.size} NIFTY close dates loaded.`);

  console.log('Loading daily_ohlcv' + (onlySymbol ? ` for ${onlySymbol}` : ' (full universe)') + '...');
  const allRows = await fetchAllOhlcv(supabase, onlySymbol);
  console.log(`  ${allRows.length} rows loaded.`);

  const bySymbol = new Map<string, Bar[]>();
  for (const r of allRows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push({ t: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    bySymbol.set(r.symbol, list);
  }
  console.log(`  ${bySymbol.size} symbols to process.`);

  let symbolsDone = 0, rowsWritten = 0;
  for (const [symbol, bars] of bySymbol) {
    const rows = computeSymbolIndicators(bars, niftyClose).map((r) => ({ ...r, symbol }));
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('indicators').upsert(rows.slice(i, i + CHUNK), { onConflict: 'symbol,date' });
      if (error) throw new Error(`${symbol}: ${error.message}`);
    }
    rowsWritten += rows.length;
    symbolsDone++;
    if (symbolsDone % 25 === 0 || symbolsDone === bySymbol.size) {
      console.log(`  ${symbolsDone}/${bySymbol.size} symbols (${rowsWritten} rows written so far)`);
    }
  }

  console.log(`Done. ${symbolsDone} symbols, ${rowsWritten} indicator rows written.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
