/**
 * Exports existing Postgres `vwap_minute_bars` rows to archive Parquet
 * partitions (VWAP_STORAGE_MIGRATION_PLAN.md task 8). One partition
 * (symbol, year, month) per call, in bounded batches by construction —
 * callers loop over the partitions they need, never load the whole
 * multi-year table into memory here.
 *
 * NEVER deletes Postgres rows — this module only reads. Deleting
 * `vwap_minute_bars` rows is explicitly deferred until after the archive
 * migration is proven and the user approves it (VWAP_STORAGE_MIGRATION_PLAN.md's
 * own stop condition).
 */
import type { ArchiveBarRow, PartitionKey } from '../data/barArchiveStore.ts';
import type { BarArchiveStoreWithIntegrity } from '../data/parquetBarArchiveStore.ts';
import { reconcilePartition, type ReconciliationResult } from './reconciliation.ts';

export interface PostgresBarReader {
  /** Reads every bar for exactly this (symbol, year, month) from `vwap_minute_bars` — no synthetic/derived rows, exactly what's persisted. */
  readBarsForPartition(symbol: string, year: number, month: number): Promise<ArchiveBarRow[]>;
}

export type ExportPartitionResult =
  | { status: 'NO_DATA'; key: PartitionKey }
  | { status: 'WRITE_FAILED'; key: PartitionKey; error: string }
  | { status: 'RECONCILED'; key: PartitionKey; reconciliation: ReconciliationResult }
  | { status: 'MISMATCH'; key: PartitionKey; reconciliation: ReconciliationResult };

export async function exportPartitionToArchive(
  deps: { reader: PostgresBarReader; archiveStore: BarArchiveStoreWithIntegrity },
  key: PartitionKey,
): Promise<ExportPartitionResult> {
  const rows = await deps.reader.readBarsForPartition(key.symbol, key.year, key.month);
  if (rows.length === 0) return { status: 'NO_DATA', key };

  const writeResult = await deps.archiveStore.writeBars(key, rows);
  if ('error' in writeResult) return { status: 'WRITE_FAILED', key, error: writeResult.error };

  const manifest = await deps.archiveStore.readIntegrityManifest(key);
  const reconciliation = reconcilePartition(rows, manifest);

  return reconciliation.status === 'MATCH'
    ? { status: 'RECONCILED', key, reconciliation }
    : { status: 'MISMATCH', key, reconciliation };
}

/** Production adapter — bounded to one calendar month per query by construction, never the whole table. Typed loosely, same reason as every other Supabase adapter in this codebase (see orderIntent.ts's own header comment). */
export function supabasePostgresBarReader(supabase: any): PostgresBarReader {
  return {
    async readBarsForPartition(symbol, year, month) {
      const monthStr = String(month).padStart(2, '0');
      const rangeStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      const rangeEnd = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)).toISOString();
      const { data, error } = await supabase
        .from('vwap_minute_bars')
        .select('*')
        .eq('symbol', symbol)
        .gte('timestamp', rangeStart)
        .lt('timestamp', rangeEnd)
        .order('timestamp', { ascending: true });
      if (error) throw new Error(`readBarsForPartition(${symbol}, ${year}-${monthStr}) failed: ${error.message}`);
      return (data ?? []).map((row: any): ArchiveBarRow => ({
        symbol: row.symbol,
        instrumentToken: row.instrument_token,
        t: Date.parse(row.timestamp),
        o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume,
        oi: row.oi ?? null,
        source: row.source,
        ingestionVersion: row.ingestion_version,
      }));
    },
  };
}
