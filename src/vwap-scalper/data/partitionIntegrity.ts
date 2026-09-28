/**
 * Per-partition integrity metadata (VWAP_STORAGE_MIGRATION_PLAN.md task 7)
 * — computed on every write, used later for Postgres-vs-archive
 * reconciliation (task 8) and for detecting a corrupt/truncated partition
 * on read.
 */
import { createHash } from 'node:crypto';
import type { ArchiveBarRow } from './barArchiveStore.ts';

export const ARCHIVE_SCHEMA_VERSION = 'v1';

export interface PartitionIntegrity {
  rowCount: number;
  earliestMs: number | null;
  latestMs: number | null;
  contentHash: string;
  schemaVersion: string;
}

/** Deterministic — sorted by (symbol, t) before hashing, so row input order never changes the result. Rows must already be deduplicated by (symbol, t) by the caller. */
export function computePartitionIntegrity(rows: ArchiveBarRow[]): PartitionIntegrity {
  if (rows.length === 0) {
    return { rowCount: 0, earliestMs: null, latestMs: null, contentHash: createHash('sha256').digest('hex'), schemaVersion: ARCHIVE_SCHEMA_VERSION };
  }
  const sorted = [...rows].sort((a, b) => (a.symbol === b.symbol ? a.t - b.t : a.symbol.localeCompare(b.symbol)));
  const hash = createHash('sha256');
  for (const r of sorted) {
    hash.update(`${r.symbol}|${r.instrumentToken}|${r.t}|${r.o}|${r.h}|${r.l}|${r.c}|${r.v}|${r.oi ?? 'null'}|${r.source}|${r.ingestionVersion}\n`);
  }
  const timestamps = sorted.map((r) => r.t);
  return {
    rowCount: sorted.length,
    earliestMs: Math.min(...timestamps),
    latestMs: Math.max(...timestamps),
    contentHash: hash.digest('hex'),
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
  };
}

/** Merges `incoming` rows into `existing`, deduplicated by (symbol, t). On a key collision the incoming row wins (last-write-wins) — this is what makes re-writing a partition idempotent instead of appending duplicates. */
export function mergeDedupeBars(existing: ArchiveBarRow[], incoming: ArchiveBarRow[]): ArchiveBarRow[] {
  const byKey = new Map<string, ArchiveBarRow>();
  for (const r of existing) byKey.set(`${r.symbol}|${r.t}`, r);
  for (const r of incoming) byKey.set(`${r.symbol}|${r.t}`, r);
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}
