/**
 * Archive-backed backfill orchestration (VWAP_STORAGE_MIGRATION_PLAN.md
 * task 10/11) — Kite -> chunk fetch -> Parquet partition -> archive
 * (R2/local), replacing the old Kite -> Postgres path (../data/backfill.ts,
 * left untouched and still tested — this is a NEW function, not a rewrite
 * of that one).
 *
 * The Postgres checkpoint table remains authoritative for resume
 * progress; this module only ever WRITES bars to the configured
 * `BarArchiveStore`, never to `vwap_minute_bars`. A checkpoint is updated
 * only after the archive write for that chunk is confirmed (task 10) —
 * never optimistically before the write, and never at all if drift is
 * detected between what the checkpoint claims and what the archive
 * actually holds (task 13's ARCHIVE_AHEAD_OF_CHECKPOINT /
 * CHECKPOINT_AHEAD_OF_ARCHIVE scenarios) — resuming on top of
 * unreconciled drift would risk silently missing or duplicating data.
 */
import type { KiteFetcher } from '../data/historicalBars.ts';
import { fetchHistoricalChunk, buildChunkWindows } from '../data/historicalBars.ts';
import type { ArchiveBarRow, PartitionKey } from '../data/barArchiveStore.ts';
import type { BarArchiveStoreWithIntegrity } from '../data/parquetBarArchiveStore.ts';
import { partitionKeyForTimestamp } from '../data/barArchiveStore.ts';
import { detectCheckpointArchiveDrift } from './checkpointDrift.ts';

export type ArchiveBackfillStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'NO_DATA' | 'DRIFT_DETECTED' | 'IN_PROGRESS';

export interface CheckpointRecord {
  earliestPersistedMs: number | null;
  latestPersistedMs: number | null;
  status: string;
}

export interface CheckpointStore {
  getCheckpoint(symbol: string): Promise<CheckpointRecord | null>;
  upsertCheckpoint(symbol: string, patch: {
    instrumentToken: number; earliestPersistedMs: number | null; latestPersistedMs: number | null;
    status: 'IN_PROGRESS' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'NO_DATA'; lastError?: string | null; storageBackend: 'LOCAL' | 'R2';
  }): Promise<{ ok: true } | { error: string }>;
}

export interface ArchiveBackfillSymbolParams {
  symbol: string;
  instrumentToken: number;
  overallFromISO: string;
  overallToISO: string;
  throttleMs: number;
  storageBackend: 'LOCAL' | 'R2';
  /** Caps how many chunk windows this single call processes — a serverless function has a hard execution-time limit, and a multi-year backfill is many chunks. Omit to process every remaining window in one call (fine for tests/local use). The checkpoint is updated after each chunk, so a bounded call is naturally resumable: the next call with the same params picks up exactly where this one stopped. */
  maxChunksPerCall?: number;
}

export interface ArchiveBackfillSymbolResult {
  symbol: string;
  status: ArchiveBackfillStatus;
  chunksAttempted: number;
  chunksFailed: number;
  barsWritten: number;
  earliestPersistedMs: number | null;
  latestPersistedMs: number | null;
  failedChunkDetails: Array<{ from: string; to: string; message: string }>;
  driftDetail?: string;
}

export async function backfillSymbolToArchive(
  deps: { fetcher: KiteFetcher; archiveStore: BarArchiveStoreWithIntegrity; checkpoints: CheckpointStore },
  params: ArchiveBackfillSymbolParams,
): Promise<ArchiveBackfillSymbolResult> {
  const existing = await deps.checkpoints.getCheckpoint(params.symbol);

  // Drift check (task 13) — before trusting the checkpoint's
  // latestPersistedMs to decide what to resume from, confirm the archive
  // partition covering that exact timestamp actually agrees. A crash
  // between "archive write done" and "checkpoint updated" (or vice versa)
  // in an earlier run would otherwise silently resume from the wrong
  // point.
  if (existing?.latestPersistedMs != null) {
    const key = partitionKeyForTimestamp(params.symbol, existing.latestPersistedMs);
    const coverage = await deps.archiveStore.getCoverage(key);
    const drift = detectCheckpointArchiveDrift(existing.latestPersistedMs, coverage?.latestMs ?? null);
    if (drift !== 'CONSISTENT') {
      return {
        symbol: params.symbol, status: 'DRIFT_DETECTED', chunksAttempted: 0, chunksFailed: 0, barsWritten: 0,
        earliestPersistedMs: existing.earliestPersistedMs, latestPersistedMs: existing.latestPersistedMs,
        failedChunkDetails: [],
        driftDetail: `${drift}: checkpoint.latestPersistedMs=${existing.latestPersistedMs}, archive partition ${key.symbol} ${key.year}-${key.month} latestMs=${coverage?.latestMs ?? 'null'}`,
      };
    }
  }

  const resumeFromISO = existing?.latestPersistedMs != null
    ? new Date(existing.latestPersistedMs + 60_000).toISOString().slice(0, 10)
    : params.overallFromISO;

  if (existing?.status === 'COMPLETE' && existing.latestPersistedMs !== null) {
    const latestPersistedDateISO = new Date(existing.latestPersistedMs).toISOString().slice(0, 10);
    if (latestPersistedDateISO >= params.overallToISO) {
      return {
        symbol: params.symbol, status: 'COMPLETE', chunksAttempted: 0, chunksFailed: 0, barsWritten: 0,
        earliestPersistedMs: existing.earliestPersistedMs, latestPersistedMs: existing.latestPersistedMs, failedChunkDetails: [],
      };
    }
  }

  const allWindows = buildChunkWindows(resumeFromISO, params.overallToISO);
  const windows = params.maxChunksPerCall != null ? allWindows.slice(0, params.maxChunksPerCall) : allWindows;
  const boundedThisCall = windows.length < allWindows.length;
  let barsWritten = 0;
  let chunksFailed = 0;
  const failedChunkDetails: Array<{ from: string; to: string; message: string }> = [];
  let earliestMs: number | null = existing?.earliestPersistedMs ?? null;
  let latestMs: number | null = existing?.latestPersistedMs ?? null;

  for (const window of windows) {
    const result = await fetchHistoricalChunk(deps.fetcher, params.instrumentToken, window.from, window.to);
    if (result.error) {
      chunksFailed++;
      failedChunkDetails.push({ from: window.from, to: window.to, message: result.error.message });
      if (result.error.kind === 'PERMANENT') {
        await deps.checkpoints.upsertCheckpoint(params.symbol, {
          instrumentToken: params.instrumentToken, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs,
          status: 'FAILED', lastError: result.error.message, storageBackend: params.storageBackend,
        });
        return { symbol: params.symbol, status: 'FAILED', chunksAttempted: windows.indexOf(window) + 1, chunksFailed, barsWritten, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs, failedChunkDetails };
      }
      continue; // TRANSIENT — already retried inside fetchHistoricalChunk
    }

    if (result.bars.length > 0) {
      const rows: ArchiveBarRow[] = result.bars.map((b) => ({
        ...b, symbol: params.symbol, instrumentToken: params.instrumentToken, oi: null,
        source: 'KITE_HISTORICAL', ingestionVersion: 'v1',
      }));

      // Group by (year, month) partition — a chunk window can straddle a
      // month boundary, and each partition must be written as ONE
      // deterministic file (task 5: no per-minute objects).
      const byPartition = new Map<string, { key: PartitionKey; rows: ArchiveBarRow[] }>();
      for (const row of rows) {
        const key = partitionKeyForTimestamp(row.symbol, row.t);
        const partitionId = `${key.symbol}|${key.year}|${key.month}`;
        if (!byPartition.has(partitionId)) byPartition.set(partitionId, { key, rows: [] });
        byPartition.get(partitionId)!.rows.push(row);
      }

      let chunkWriteFailed = false;
      for (const { key, rows: partitionRows } of byPartition.values()) {
        const writeResult = await deps.archiveStore.writeBars(key, partitionRows);
        if ('error' in writeResult) {
          chunkWriteFailed = true;
          failedChunkDetails.push({ from: window.from, to: window.to, message: `archive write failed for ${key.symbol} ${key.year}-${key.month}: ${writeResult.error}` });
          continue;
        }
        // Verify (task 10: "checkpoint only after archive write +
        // verification succeeds") — confirm the manifest actually reflects
        // at least as many rows as this chunk contributed, not just that
        // upload() returned ok.
        const manifest = await deps.archiveStore.readIntegrityManifest(key);
        if (!manifest || manifest.rowCount < partitionRows.length) {
          chunkWriteFailed = true;
          failedChunkDetails.push({ from: window.from, to: window.to, message: `archive write for ${key.symbol} ${key.year}-${key.month} could not be verified (manifest missing or short)` });
          continue;
        }
      }

      if (chunkWriteFailed) {
        chunksFailed++;
        continue;
      }

      barsWritten += rows.length;
      const chunkFirstMs = result.bars[0].t, chunkLastMs = result.bars[result.bars.length - 1].t;
      if (earliestMs === null || chunkFirstMs < earliestMs) earliestMs = chunkFirstMs;
      if (latestMs === null || chunkLastMs > latestMs) latestMs = chunkLastMs;

      // Checkpoint updated only now — after every partition this chunk
      // touched has a verified write. A crash before this point simply
      // means the next run re-fetches this one chunk (safe: writeBars
      // merges/dedupes, so re-writing is idempotent).
      await deps.checkpoints.upsertCheckpoint(params.symbol, {
        instrumentToken: params.instrumentToken, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs,
        status: 'IN_PROGRESS', lastError: null, storageBackend: params.storageBackend,
      });
    }

    await sleep(params.throttleMs);
  }

  // A bounded call that got through all its allotted chunks without a
  // terminal FAILED and still has more windows left overall is
  // IN_PROGRESS, not COMPLETE/PARTIAL/NO_DATA — those final classifications
  // only apply once every window up to overallToISO has actually been
  // attempted. The checkpoint already reflects everything written so far,
  // so the next call resumes correctly regardless of which status this
  // one returns.
  const status: 'FAILED' | 'IN_PROGRESS' | 'NO_DATA' | 'PARTIAL' | 'COMPLETE' =
    barsWritten === 0 && chunksFailed === windows.length ? 'FAILED'
    : boundedThisCall ? 'IN_PROGRESS'
    : barsWritten === 0 ? 'NO_DATA'
    : chunksFailed > 0 ? 'PARTIAL'
    : 'COMPLETE';

  await deps.checkpoints.upsertCheckpoint(params.symbol, {
    instrumentToken: params.instrumentToken, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs,
    status, lastError: failedChunkDetails.length ? failedChunkDetails[failedChunkDetails.length - 1].message : null,
    storageBackend: params.storageBackend,
  });

  return { symbol: params.symbol, status, chunksAttempted: windows.length, chunksFailed, barsWritten, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs, failedChunkDetails };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
