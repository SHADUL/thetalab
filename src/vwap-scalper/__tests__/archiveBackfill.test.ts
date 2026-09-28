import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:crypto';
import path from 'node:path';

import { backfillSymbolToArchive } from '../archive/archiveBackfill.ts';
import type { CheckpointStore, CheckpointRecord } from '../archive/archiveBackfill.ts';
import { createLocalObjectStorage } from '../data/localObjectStorage.ts';
import { createBarArchiveStore } from '../data/parquetBarArchiveStore.ts';
import type { KiteFetcher } from '../data/historicalBars.ts';

class InMemoryCheckpointStore implements CheckpointStore {
  checkpoints = new Map<string, CheckpointRecord & { storageBackend: string }>();
  async getCheckpoint(symbol: string) {
    return this.checkpoints.get(symbol) ?? null;
  }
  async upsertCheckpoint(symbol: string, patch: any) {
    this.checkpoints.set(symbol, { earliestPersistedMs: patch.earliestPersistedMs, latestPersistedMs: patch.latestPersistedMs, status: patch.status, storageBackend: patch.storageBackend });
    return { ok: true as const };
  }
}

function tmpDir(): string {
  const dir = path.join('/tmp', `vwap-archive-backfill-test-${os.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function successBody(candles: Array<[string, number, number, number, number, number]>) {
  return { status: 200, body: JSON.stringify({ status: 'success', data: { candles } }) };
}

test('a successful archive backfill writes bars into the archive (never Postgres) and marks the checkpoint COMPLETE only after a verified write', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  const fetcher: KiteFetcher = async () => successBody([['2026-01-01T09:15:00+0530', 100, 101, 99, 100, 1000]]);

  const result = await backfillSymbolToArchive(
    { fetcher, archiveStore, checkpoints },
    { symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2026-01-01', overallToISO: '2026-01-01', throttleMs: 0, storageBackend: 'LOCAL' },
  );

  assert.equal(result.status, 'COMPLETE');
  assert.ok(result.barsWritten > 0);
  const checkpoint = await checkpoints.getCheckpoint('RELIANCE');
  assert.equal(checkpoint?.status, 'COMPLETE');

  const readBack = await archiveStore.readBars({ symbol: 'RELIANCE', year: 2026, month: 1 });
  assert.ok('rows' in readBack && readBack.rows.length > 0, 'bars must actually be in the archive, not just reported as written');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('re-running an archive backfill over an already-COMPLETE range does not re-fetch or re-write anything', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  let fetchCount = 0;
  const fetcher: KiteFetcher = async () => { fetchCount++; return successBody([['2026-01-01T09:15:00+0530', 100, 101, 99, 100, 1000]]); };
  const params = { symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2026-01-01', overallToISO: '2026-01-01', throttleMs: 0, storageBackend: 'LOCAL' as const };

  await backfillSymbolToArchive({ fetcher, archiveStore, checkpoints }, params);
  const countAfterFirst = fetchCount;
  const second = await backfillSymbolToArchive({ fetcher, archiveStore, checkpoints }, params);

  assert.equal(second.status, 'COMPLETE');
  assert.equal(fetchCount, countAfterFirst, 'no new fetch should happen for an already-complete, already-archived range');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a permanent error stops the symbol immediately and reports FAILED, never partially resumed as if it succeeded', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  const fetcher: KiteFetcher = async () => ({ status: 401, body: '{"status":"error","message":"Invalid token"}' });

  const result = await backfillSymbolToArchive(
    { fetcher, archiveStore, checkpoints },
    { symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2020-01-01', overallToISO: '2026-01-01', throttleMs: 0, storageBackend: 'LOCAL' },
  );
  assert.equal(result.status, 'FAILED');
  assert.ok(result.failedChunkDetails.length > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('DRIFT_DETECTED: if the checkpoint claims coverage the archive does not actually have, the backfill refuses to resume rather than silently trusting the checkpoint', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  // Simulate a stale/corrupted checkpoint claiming coverage through a
  // timestamp that was never actually written to the archive.
  await checkpoints.upsertCheckpoint('RELIANCE', {
    instrumentToken: 738561, earliestPersistedMs: Date.parse('2026-01-01T03:45:00.000Z'),
    latestPersistedMs: Date.parse('2026-01-15T09:44:00.000Z'), status: 'PARTIAL', storageBackend: 'LOCAL',
  });

  const fetcher: KiteFetcher = async () => successBody([]);
  const result = await backfillSymbolToArchive(
    { fetcher, archiveStore, checkpoints },
    { symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2026-01-01', overallToISO: '2026-01-31', throttleMs: 0, storageBackend: 'LOCAL' },
  );

  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.ok(result.driftDetail?.includes('CHECKPOINT_AHEAD_OF_ARCHIVE'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a chunk spanning a month boundary writes into BOTH monthly partitions correctly', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  const fetcher: KiteFetcher = async () => successBody([
    ['2026-01-31T09:15:00+0530', 100, 101, 99, 100, 1000],
    ['2026-02-02T09:15:00+0530', 100, 101, 99, 100, 1000],
  ]);

  const result = await backfillSymbolToArchive(
    { fetcher, archiveStore, checkpoints },
    { symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2026-01-31', overallToISO: '2026-02-02', throttleMs: 0, storageBackend: 'LOCAL' },
  );

  assert.equal(result.status, 'COMPLETE');
  const jan = await archiveStore.readBars({ symbol: 'RELIANCE', year: 2026, month: 1 });
  const feb = await archiveStore.readBars({ symbol: 'RELIANCE', year: 2026, month: 2 });
  assert.ok('rows' in jan && jan.rows.length === 1);
  assert.ok('rows' in feb && feb.rows.length === 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('maxChunksPerCall bounds a single call to IN_PROGRESS, and a second call with the same params resumes and reaches COMPLETE — never re-fetching an already-written chunk', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  const requestedWindows: string[] = [];
  const fetcher: KiteFetcher = async (url: string) => {
    const from = new URL(url).searchParams.get('from')!;
    const to = new URL(url).searchParams.get('to')!;
    requestedWindows.push(from);
    // Realistic: a real Kite response covers bars across the WHOLE window,
    // not just its first day — so the returned latestMs must reach the
    // window's own `to` date for the resume-from-checkpoint logic to
    // correctly advance past this entire window on the next call.
    return successBody([[`${from}T09:15:00+0530`, 100, 101, 99, 100, 1000], [`${to}T09:15:00+0530`, 100, 101, 99, 100, 1000]]);
  };
  // A wide enough range to produce several 60-day chunks.
  const params = {
    symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2023-01-01', overallToISO: '2023-12-31',
    throttleMs: 0, storageBackend: 'LOCAL' as const, maxChunksPerCall: 2,
  };

  const first = await backfillSymbolToArchive({ fetcher, archiveStore, checkpoints }, params);
  assert.equal(first.status, 'IN_PROGRESS');
  assert.equal(first.chunksAttempted, 2);
  assert.equal(requestedWindows.length, 2);

  // Keep calling with the SAME params (as a real resumable orchestrator
  // loop would) until it reaches a terminal status.
  let result = first;
  let iterations = 1;
  while (result.status === 'IN_PROGRESS' && iterations < 20) {
    result = await backfillSymbolToArchive({ fetcher, archiveStore, checkpoints }, params);
    iterations++;
  }

  assert.equal(result.status, 'COMPLETE');
  assert.equal(new Set(requestedWindows).size, requestedWindows.length, 'no chunk window should ever be requested twice across resumed calls');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a PERMANENT error during a bounded call still reports FAILED immediately, not IN_PROGRESS', async () => {
  const dir = tmpDir();
  const archiveStore = createBarArchiveStore(createLocalObjectStorage(path.join(dir, 'store')), path.join(dir, 'scratch'));
  const checkpoints = new InMemoryCheckpointStore();
  const fetcher: KiteFetcher = async () => ({ status: 401, body: '{"status":"error","message":"Invalid token"}' });

  const result = await backfillSymbolToArchive(
    { fetcher, archiveStore, checkpoints },
    { symbol: 'RELIANCE', instrumentToken: 738561, overallFromISO: '2020-01-01', overallToISO: '2026-01-01', throttleMs: 0, storageBackend: 'LOCAL', maxChunksPerCall: 2 },
  );
  assert.equal(result.status, 'FAILED');

  fs.rmSync(dir, { recursive: true, force: true });
});
