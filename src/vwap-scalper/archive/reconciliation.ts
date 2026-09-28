/**
 * Postgres-vs-archive reconciliation (VWAP_STORAGE_MIGRATION_PLAN.md task
 * 8) — for every exported partition, compares row count, min/max
 * timestamp, and content hash between the Postgres source rows and the
 * archive's own integrity manifest (../data/partitionIntegrity.ts). A
 * mismatch is reported explicitly, never silently ignored or averaged
 * away — the Postgres copy is only ever considered redundant for a
 * partition that reconciles cleanly.
 */
import type { ArchiveBarRow } from '../data/barArchiveStore.ts';
import { computePartitionIntegrity, type PartitionIntegrity } from '../data/partitionIntegrity.ts';

export interface ReconciliationResult {
  status: 'MATCH' | 'MISMATCH';
  mismatches: string[];
  postgres: PartitionIntegrity;
  archive: PartitionIntegrity | null;
}

/** `postgresRows` is exactly what was read from `vwap_minute_bars` for this partition, mapped into `ArchiveBarRow` shape — never re-derived or approximated. */
export function reconcilePartition(postgresRows: ArchiveBarRow[], archiveManifest: PartitionIntegrity | null): ReconciliationResult {
  const postgresIntegrity = computePartitionIntegrity(postgresRows);
  const mismatches: string[] = [];

  if (archiveManifest === null) {
    mismatches.push('archive has no integrity manifest for this partition (never written, or write did not complete)');
    return { status: 'MISMATCH', mismatches, postgres: postgresIntegrity, archive: null };
  }
  if (postgresIntegrity.rowCount !== archiveManifest.rowCount) {
    mismatches.push(`row count mismatch: postgres=${postgresIntegrity.rowCount} archive=${archiveManifest.rowCount}`);
  }
  if (postgresIntegrity.earliestMs !== archiveManifest.earliestMs) {
    mismatches.push(`earliest timestamp mismatch: postgres=${postgresIntegrity.earliestMs} archive=${archiveManifest.earliestMs}`);
  }
  if (postgresIntegrity.latestMs !== archiveManifest.latestMs) {
    mismatches.push(`latest timestamp mismatch: postgres=${postgresIntegrity.latestMs} archive=${archiveManifest.latestMs}`);
  }
  if (postgresIntegrity.contentHash !== archiveManifest.contentHash) {
    mismatches.push(`content hash mismatch: postgres=${postgresIntegrity.contentHash} archive=${archiveManifest.contentHash}`);
  }

  return { status: mismatches.length === 0 ? 'MATCH' : 'MISMATCH', mismatches, postgres: postgresIntegrity, archive: archiveManifest };
}
