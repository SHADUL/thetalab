/**
 * Backfill orchestration (VWAP_SCALPER_DATA_FOUNDATION Task 4/5) — resumes
 * from a symbol's own checkpoint rather than re-fetching already-persisted
 * windows, throttles between chunk requests to stay well under Kite's
 * documented historical-data rate limit, and never silently drops a
 * symbol whose chunk fails: a FAILED/PARTIAL status is reported, not
 * hidden.
 */
import type { KiteFetcher } from './historicalBars.ts';
import { fetchHistoricalChunk, buildChunkWindows } from './historicalBars.ts';
import type { BarRepository, BarRow } from './barRepository.ts';

export type BackfillStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'NO_DATA';

export interface SymbolBackfillResult {
  symbol: string;
  status: BackfillStatus;
  chunksAttempted: number;
  chunksFailed: number;
  barsPersisted: number;
  earliestPersistedMs: number | null;
  latestPersistedMs: number | null;
  failedChunkDetails: Array<{ from: string; to: string; message: string }>;
}

export interface BackfillSymbolParams {
  symbol: string;
  instrumentToken: number;
  overallFromISO: string; // "YYYY-MM-DD" — the oldest date to attempt.
  overallToISO: string; // "YYYY-MM-DD" — the newest date to attempt.
  throttleMs: number; // delay between chunk requests — caller sets this conservatively.
}

export async function backfillSymbol(
  deps: { fetcher: KiteFetcher; repo: BarRepository },
  params: BackfillSymbolParams,
): Promise<SymbolBackfillResult> {
  const existing = await deps.repo.getCheckpoint(params.symbol);
  // Resume from just after whatever's already persisted, going backward is
  // not needed here — chunk windows are built oldest-first, so resuming
  // means skipping windows already covered by [nothing persisted yet] up
  // to the checkpoint's own latest timestamp.
  const resumeFromISO = existing?.latestPersistedMs != null
    ? new Date(existing.latestPersistedMs + 60_000).toISOString().slice(0, 10)
    : params.overallFromISO;

  if (existing?.status === 'COMPLETE' && existing.latestPersistedMs !== null) {
    const latestPersistedDateISO = new Date(existing.latestPersistedMs).toISOString().slice(0, 10);
    if (latestPersistedDateISO >= params.overallToISO) {
      return {
        symbol: params.symbol, status: 'COMPLETE', chunksAttempted: 0, chunksFailed: 0, barsPersisted: 0,
        earliestPersistedMs: existing.earliestPersistedMs, latestPersistedMs: existing.latestPersistedMs, failedChunkDetails: [],
      };
    }
  }

  const windows = buildChunkWindows(resumeFromISO, params.overallToISO);
  let barsPersisted = 0;
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
        // A permanent error (bad token, bad request) will never succeed on
        // retry — stop this symbol's backfill entirely rather than
        // burning through every remaining window pointlessly.
        await deps.repo.upsertCheckpoint(params.symbol, {
          instrumentToken: params.instrumentToken, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs,
          status: 'FAILED', lastError: result.error.message,
        });
        return { symbol: params.symbol, status: 'FAILED', chunksAttempted: windows.indexOf(window) + 1, chunksFailed, barsPersisted, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs, failedChunkDetails };
      }
      // TRANSIENT (already retried inside fetchHistoricalChunk) — record and move on to the next window; this symbol becomes PARTIAL, not FAILED.
      continue;
    }

    if (result.bars.length > 0) {
      const rows: BarRow[] = result.bars.map((b) => ({ ...b, symbol: params.symbol, instrumentToken: params.instrumentToken, source: 'KITE_HISTORICAL' }));
      const upsertResult = await deps.repo.upsertBars(rows);
      if ('error' in upsertResult) {
        chunksFailed++;
        failedChunkDetails.push({ from: window.from, to: window.to, message: `persistence failed: ${upsertResult.error}` });
        continue;
      }
      barsPersisted += upsertResult.count;
      const chunkFirstMs = result.bars[0].t, chunkLastMs = result.bars[result.bars.length - 1].t;
      if (earliestMs === null || chunkFirstMs < earliestMs) earliestMs = chunkFirstMs;
      if (latestMs === null || chunkLastMs > latestMs) latestMs = chunkLastMs;
    }

    await sleep(params.throttleMs);
  }

  const status: BackfillStatus = barsPersisted === 0 && chunksFailed === windows.length ? 'FAILED'
    : barsPersisted === 0 ? 'NO_DATA'
    : chunksFailed > 0 ? 'PARTIAL'
    : 'COMPLETE';

  await deps.repo.upsertCheckpoint(params.symbol, {
    instrumentToken: params.instrumentToken, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs,
    status, lastError: failedChunkDetails.length ? failedChunkDetails[failedChunkDetails.length - 1].message : null,
  });

  return { symbol: params.symbol, status, chunksAttempted: windows.length, chunksFailed, barsPersisted, earliestPersistedMs: earliestMs, latestPersistedMs: latestMs, failedChunkDetails };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
