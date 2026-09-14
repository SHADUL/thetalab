/**
 * Rolls every symbol's full daily_ohlcv history up into weekly bars
 * (indicators/weekly.ts's aggregateWeekly) and writes them into
 * `weekly_ohlcv` — raw/unadjusted, same convention as daily_ohlcv itself;
 * split-adjustment happens downstream at compute time
 * (computeStructureScores.ts), not here, so there's one raw source of
 * truth for both daily and weekly bars, not two.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/computeWeeklyOhlcv.ts
 */
import { createClient } from '@supabase/supabase-js';
import type { Bar } from '../indicators/types.ts';
import { aggregateWeekly, mondayOf } from '../indicators/weekly.ts';
import { fetchAllPages } from './dbPaging.ts';

interface OhlcvRow { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number; }

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log('Loading daily_ohlcv (full universe)...');
  const rows = await fetchAllPages<OhlcvRow>(supabase, 'daily_ohlcv', 'symbol,date,open,high,low,close,volume', [['symbol', true], ['date', true]]);
  console.log(`  ${rows.length} rows loaded.`);

  const bySymbol = new Map<string, Bar[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push({ t: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
    bySymbol.set(r.symbol, list);
  }
  console.log(`  ${bySymbol.size} symbols.`);

  let symbolsDone = 0, rowsWritten = 0;
  for (const [symbol, bars] of bySymbol) {
    const weekly = aggregateWeekly(bars);
    const upsertRows = weekly.map((b) => ({
      symbol, week_start: mondayOf(b.t), week_end: b.t,
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
    }));
    const CHUNK = 500;
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const { error } = await supabase.from('weekly_ohlcv').upsert(upsertRows.slice(i, i + CHUNK), { onConflict: 'symbol,week_start' });
      if (error) throw new Error(`${symbol}: ${error.message}`);
    }
    rowsWritten += upsertRows.length;
    symbolsDone++;
    if (symbolsDone % 50 === 0 || symbolsDone === bySymbol.size) {
      console.log(`  ${symbolsDone}/${bySymbol.size} symbols (${rowsWritten} weekly rows so far)`);
    }
  }
  console.log(`Done. ${symbolsDone} symbols, ${rowsWritten} weekly rows written.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
