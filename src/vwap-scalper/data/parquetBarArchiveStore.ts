/**
 * A concrete `BarArchiveStore` composing an `ObjectStorageClient` with the
 * DuckDB Parquet codec (VWAP_STORAGE_MIGRATION_PLAN.md §3). Works with ANY
 * `ObjectStorageClient` implementation — local filesystem (dev/test) or
 * Cloudflare R2 (production, see ../archive/r2ObjectStorage.ts) — with
 * zero changes to this file. Pick the backend via
 * ../archive/backendSelection.ts, never by choosing a different store
 * implementation.
 *
 * Every write goes through a local scratch file first (DuckDB writes/reads
 * local files only), then gets uploaded/downloaded via the client — this
 * module is the only place that stitches those two steps together.
 */
import fs from 'node:fs';
import os from 'node:crypto';
import path from 'node:path';
import type {
  ArchiveBarRow,
  BarArchiveStore,
  ObjectStorageClient,
  PartitionCoverage,
  PartitionKey,
} from './barArchiveStore.ts';
import { partitionPath } from './barArchiveStore.ts';
import { readParquetFile, writeParquetFile } from './parquetCodec.ts';
import { computePartitionIntegrity, mergeDedupeBars, type PartitionIntegrity } from './partitionIntegrity.ts';
import { withBoundedRetry } from '../archive/retry.ts';

function parsePartitionPath(p: string): PartitionKey | null {
  const m = p.match(/^symbol=([^/]+)\/year=(\d+)\/month=(\d+)\/bars\.parquet$/);
  if (!m) return null;
  return { symbol: m[1], year: Number(m[2]), month: Number(m[3]) };
}

function manifestPath(objectPath: string): string {
  return objectPath.replace(/\.parquet$/, '.manifest.json');
}

export interface BarArchiveStoreWithIntegrity extends BarArchiveStore {
  /** Reads the sidecar integrity manifest written by `writeBars`, for reconciliation (VWAP_STORAGE_MIGRATION_PLAN.md task 8). Not part of the base `BarArchiveStore` interface. */
  readIntegrityManifest(key: PartitionKey): Promise<PartitionIntegrity | null>;
}

export function createBarArchiveStore(
  client: ObjectStorageClient,
  scratchDir: string,
): BarArchiveStoreWithIntegrity {
  fs.mkdirSync(scratchDir, { recursive: true });
  const scratchFile = (ext: string) => path.join(scratchDir, `${os.randomUUID()}.${ext}`);

  // Bounded retry (VWAP_STORAGE_MIGRATION_PLAN.md task 13: partial upload
  // retry / network timeout) — a plain object-storage call has no
  // TRANSIENT/PERMANENT signal like Kite's API does, so every failure gets
  // the same fixed number of attempts, then gives up loudly. `notFound` is
  // an expected state, never retried.
  async function downloadWithRetry(objectPath: string, localPath: string) {
    let last: Awaited<ReturnType<typeof client.download>> | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await client.download(objectPath, localPath);
      if (!('error' in last) || last.notFound) return last; // success, or a genuine "doesn't exist" — never retried
      if (attempt < 3) await new Promise((r) => setTimeout(r, 50 * attempt));
    }
    return last!;
  }
  async function uploadWithRetry(objectPath: string, localPath: string) {
    return withBoundedRetry(() => client.upload(objectPath, localPath), 3, 50);
  }

  async function readExistingRows(key: PartitionKey): Promise<ArchiveBarRow[]> {
    const objectPath = partitionPath(key);
    if (!(await client.exists(objectPath))) return [];
    const local = scratchFile('parquet');
    try {
      const result = await downloadWithRetry(objectPath, local);
      if ('error' in result) return []; // treated as "no prior partition" — writeBars still proceeds with just the incoming rows
      return await readParquetFile(local);
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  return {
    async writeBars(key, rows) {
      const objectPath = partitionPath(key);
      // Read/merge/dedupe-by-(symbol,timestamp) BEFORE replacing the
      // partition (task 6) — writing the same or an overlapping partition
      // twice must never produce duplicate bars or silently drop
      // previously-archived rows that the new write doesn't happen to
      // include (e.g. a resumed backfill chunk that only covers part of
      // a month).
      const existing = await readExistingRows(key);
      const merged = mergeDedupeBars(existing, rows);
      const integrity = computePartitionIntegrity(merged);

      const localParquet = scratchFile('parquet');
      const localManifest = scratchFile('json');
      try {
        await writeParquetFile(localParquet, merged);
        const uploadResult = await uploadWithRetry(objectPath, localParquet);
        if ('error' in uploadResult) return { error: uploadResult.error };

        fs.writeFileSync(localManifest, JSON.stringify(integrity, null, 2));
        const manifestResult = await uploadWithRetry(manifestPath(objectPath), localManifest);
        if ('error' in manifestResult) return { error: `bars written but manifest upload failed: ${manifestResult.error}` };

        return { ok: true, rowCount: merged.length };
      } finally {
        fs.rmSync(localParquet, { force: true });
        fs.rmSync(localManifest, { force: true });
      }
    },

    /** Reads the sidecar integrity manifest written by `writeBars` — used for reconciliation (VWAP_STORAGE_MIGRATION_PLAN.md task 8), not part of the `BarArchiveStore` interface. */
    async readIntegrityManifest(key: PartitionKey): Promise<PartitionIntegrity | null> {
      const objectPath = manifestPath(partitionPath(key));
      if (!(await client.exists(objectPath))) return null;
      const local = scratchFile('json');
      try {
        const result = await downloadWithRetry(objectPath, local);
        if ('error' in result) return null;
        return JSON.parse(fs.readFileSync(local, 'utf8'));
      } finally {
        fs.rmSync(local, { force: true });
      }
    },

    async readBars(key) {
      const objectPath = partitionPath(key);
      if (!(await client.exists(objectPath))) {
        return { ok: true, rows: [], notFound: true };
      }
      const local = scratchFile('parquet');
      try {
        const result = await downloadWithRetry(objectPath, local);
        if ('error' in result) {
          if (result.notFound) return { ok: true, rows: [], notFound: true };
          return { error: result.error };
        }
        const rows = await readParquetFile(local);
        return { ok: true, rows };
      } finally {
        fs.rmSync(local, { force: true });
      }
    },

    async listPartitions(symbol) {
      const prefix = symbol ? `symbol=${symbol}/` : '';
      const result = await client.list(prefix);
      if ('error' in result) return { error: result.error };
      const keys = result.paths
        .map(parsePartitionPath)
        .filter((k): k is PartitionKey => k !== null);
      return { ok: true, keys };
    },

    async partitionExists(key) {
      return client.exists(partitionPath(key));
    },

    async getCoverage(key): Promise<PartitionCoverage | null> {
      const result = await this.readBars(key);
      if (!('ok' in result) || !result.ok || result.rows.length === 0) return null;
      const timestamps = result.rows.map((r) => r.t);
      return {
        partitionKey: key,
        rowCount: result.rows.length,
        earliestMs: Math.min(...timestamps),
        latestMs: Math.max(...timestamps),
      };
    },
  };
}
