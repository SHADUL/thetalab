/**
 * The backtest engine's read path against archive-backed Parquet
 * partitions (VWAP_STORAGE_MIGRATION_PLAN.md task 14) — downloads and
 * reads only the (symbol, year, month) partitions that actually overlap
 * the requested [fromMs, toMs) range, never the whole multi-year archive.
 * A 3-year, 50-symbol backtest touches at most ~36 partitions per symbol,
 * not the full dataset.
 */
import type { ArchiveBarRow, BarArchiveStore, PartitionKey } from '../data/barArchiveStore.ts';

/** Every (year, month) partition key that could contain a bar in [fromMs, toMs), inclusive of partial months at either end. */
export function partitionsInRange(symbol: string, fromMs: number, toMs: number): PartitionKey[] {
  const keys: PartitionKey[] = [];
  const start = new Date(fromMs);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1; // 1-12
  const end = new Date(toMs);
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push({ symbol, year, month });
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return keys;
}

/** Reads exactly the bars for `symbol` within [fromMs, toMs), fetching only the overlapping partitions. Returns bars sorted chronologically. */
export async function readBarsForSymbolRange(
  store: BarArchiveStore,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<ArchiveBarRow[]> {
  const keys = partitionsInRange(symbol, fromMs, toMs);
  const allRows: ArchiveBarRow[] = [];

  for (const key of keys) {
    const result = await store.readBars(key);
    if ('error' in result) throw new Error(`readBarsForSymbolRange(${symbol}): partition ${key.year}-${key.month} failed: ${result.error}`);
    for (const row of result.rows) {
      if (row.t >= fromMs && row.t < toMs) allRows.push(row);
    }
  }

  return allRows.sort((a, b) => a.t - b.t);
}
