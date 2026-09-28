/**
 * The object-storage abstraction for raw 1-minute bar history
 * (VWAP_STORAGE_MIGRATION_PLAN.md) — raw OHLCV bars live here, NOT
 * primarily in Postgres, after the disk-exhaustion incident documented in
 * that file. Postgres keeps only checkpoints, manifests, coverage, and
 * research results (see this module's own callers).
 *
 * Deliberately vendor-agnostic: `ObjectStorageClient` is the ONLY part
 * that differs per backend (Supabase Storage / S3 / R2 / local
 * filesystem) — everything else (the Parquet codec, partitioning scheme,
 * `BarArchiveStore` itself) is identical regardless of which backend is
 * actually configured. Swapping backends means writing one new
 * `ObjectStorageClient` implementation, nothing else.
 */
import type { Bar } from '../types.ts';

export interface ArchiveBarRow extends Bar {
  symbol: string;
  instrumentToken: number;
  oi: number | null;
  source: 'KITE_HISTORICAL' | 'KITE_FORWARD_CAPTURE';
  ingestionVersion: string;
}

export interface PartitionKey {
  symbol: string;
  year: number;
  month: number; // 1-12
}

/** `vwap-bars/symbol={symbol}/year={year}/month={month:02}/bars.parquet` — deterministic, so the same (symbol, year, month) always maps to the same path, making writes naturally idempotent by overwrite. */
export function partitionPath(key: PartitionKey): string {
  const month = String(key.month).padStart(2, '0');
  return `symbol=${key.symbol}/year=${key.year}/month=${month}/bars.parquet`;
}

export function partitionKeyForTimestamp(symbol: string, epochMs: number): PartitionKey {
  const d = new Date(epochMs);
  return { symbol, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Minimal object-storage primitives — an upload/download/list surface any backend can implement, never a vendor-specific SDK type leaking into this module. */
export interface ObjectStorageClient {
  upload(path: string, localFilePath: string): Promise<{ ok: true } | { error: string }>;
  download(path: string, localFilePath: string): Promise<{ ok: true } | { error: string; notFound?: boolean }>;
  list(prefix: string): Promise<{ ok: true; paths: string[] } | { error: string }>;
  exists(path: string): Promise<boolean>;
}

export interface PartitionCoverage {
  partitionKey: PartitionKey;
  rowCount: number;
  earliestMs: number;
  latestMs: number;
}

export interface BarArchiveStore {
  /** Writes ALL rows for exactly one (symbol, year, month) partition, overwriting any existing file at that path — the write is the idempotency mechanism: re-running with the same input always produces the same output file, never a duplicate. */
  writeBars(key: PartitionKey, rows: ArchiveBarRow[]): Promise<{ ok: true; rowCount: number } | { error: string }>;
  readBars(key: PartitionKey): Promise<{ ok: true; rows: ArchiveBarRow[] } | { ok: true; rows: []; notFound: true } | { error: string }>;
  /** All partition keys currently archived for a symbol (or every symbol, if omitted), for coverage reporting. */
  listPartitions(symbol?: string): Promise<{ ok: true; keys: PartitionKey[] } | { error: string }>;
  partitionExists(key: PartitionKey): Promise<boolean>;
  getCoverage(key: PartitionKey): Promise<PartitionCoverage | null>;
}
