/**
 * Kite historical-data fetcher, chunked to Kite's own documented <=60-
 * calendar-day-per-request window limit for the `minute` interval
 * (VWAP_SCALPER_DATA_FOUNDATION Task 4). Confirmed empirically this phase
 * (VWAP_KITE_HISTORY_CAPABILITY.md) that real 1-minute data extends many
 * YEARS back — the 60-day figure is a per-request limit, not a total
 * depth limit — so a full backfill is a sequence of many chunk requests
 * working backwards, not one call.
 *
 * Retry policy: a TRANSIENT failure (network error, 5xx, 429) is retried
 * with bounded exponential backoff; a PERMANENT failure (401/403 token
 * invalid, 400 bad request) is never retried — it is reported immediately
 * so the caller can stop rather than burn its retry budget on something
 * that will never succeed.
 */
import type { Bar } from '../types.ts';

export interface KiteFetcher {
  (url: string): Promise<{ status: number; body: string }>;
}

export interface FetchChunkResult {
  bars: Bar[];
  error: null;
}
export interface FetchChunkError {
  bars: null;
  error: { kind: 'TRANSIENT' | 'PERMANENT'; message: string; httpStatus: number | null };
}

const CHUNK_MAX_DAYS = 60;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

function classifyHttpError(status: number): 'TRANSIENT' | 'PERMANENT' {
  if (status === 429 || status >= 500) return 'TRANSIENT';
  return 'PERMANENT'; // 400, 401, 403, 404 — retrying will never succeed.
}

function parseKiteHistoricalBody(body: string): Bar[] | null {
  try {
    const data = JSON.parse(body);
    if (data.status !== 'success') return null;
    const candles = data.data?.candles ?? [];
    return candles
      .filter((c: unknown): c is [string, number, number, number, number, number] => Array.isArray(c))
      .map((c: [string, number, number, number, number, number]) => ({ t: new Date(c[0]).getTime(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
  } catch {
    return null;
  }
}

/** One <=60-day chunk, with bounded retry on transient failures only. Never retries forever — MAX_RETRIES is a hard cap, and a PERMANENT error is never retried at all. */
export async function fetchHistoricalChunk(
  fetcher: KiteFetcher,
  instrumentToken: number,
  fromDateISO: string,
  toDateISO: string,
): Promise<FetchChunkResult | FetchChunkError> {
  const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/minute?from=${fromDateISO}&to=${toDateISO}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: { status: number; body: string };
    try {
      response = await fetcher(url);
    } catch (err: any) {
      if (attempt === MAX_RETRIES) return { bars: null, error: { kind: 'TRANSIENT', message: `network error after ${MAX_RETRIES} retries: ${err.message}`, httpStatus: null } };
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    if (response.status === 200) {
      const bars = parseKiteHistoricalBody(response.body);
      if (bars === null) return { bars: null, error: { kind: 'PERMANENT', message: `could not parse a successful response body: ${response.body.slice(0, 200)}`, httpStatus: response.status } };
      return { bars, error: null };
    }

    const kind = classifyHttpError(response.status);
    if (kind === 'PERMANENT') return { bars: null, error: { kind: 'PERMANENT', message: response.body.slice(0, 300), httpStatus: response.status } };
    if (attempt === MAX_RETRIES) return { bars: null, error: { kind: 'TRANSIENT', message: `still failing after ${MAX_RETRIES} retries: ${response.body.slice(0, 200)}`, httpStatus: response.status } };
    await sleep(BASE_BACKOFF_MS * 2 ** attempt);
  }
  // Unreachable, but keeps the return type exhaustive.
  return { bars: null, error: { kind: 'TRANSIENT', message: 'exhausted retries', httpStatus: null } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Splits [overallFrom, overallTo] into consecutive <=60-day windows, oldest-first. */
export function buildChunkWindows(overallFromISO: string, overallToISO: string): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  let cursor = new Date(`${overallFromISO}T00:00:00Z`);
  const end = new Date(`${overallToISO}T00:00:00Z`);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_MAX_DAYS - 1);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    windows.push({ from: cursor.toISOString().slice(0, 10), to: actualEnd.toISOString().slice(0, 10) });
    cursor = new Date(actualEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}
