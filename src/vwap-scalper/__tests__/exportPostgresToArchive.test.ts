import { test } from 'node:test';
import assert from 'node:assert/strict';

import { supabasePostgresBarReader } from '../archive/exportPostgresToArchive.ts';

/**
 * Regression test for a real bug found during the production R2 export
 * (VWAP_R2_ARCHIVE_READINESS_REPORT.md follow-up): `readBarsForPartition`
 * used a single unbounded `.select('*')`, which Supabase/PostgREST
 * silently truncates at its default 1000-row response cap. Every real
 * month with >1000 bars (i.e. almost every one) was exported and
 * "reconciled" against only its first 1000 rows — a false MATCH, since
 * the reconciliation compared the truncated read against itself, never
 * against the true Postgres total. Fixed by paginating with `.range()`
 * until a page comes back short of the page size.
 */
function fakeSupabaseWithRows(totalRows: number, pageSize: number) {
  const allRows = Array.from({ length: totalRows }, (_, i) => ({
    symbol: 'RELIANCE', instrument_token: 738561,
    timestamp: new Date(Date.parse('2026-01-01T03:45:00.000Z') + i * 60_000).toISOString(),
    open: 100, high: 101, low: 99, close: 100.5, volume: 1000, oi: null,
    source: 'KITE_HISTORICAL', ingestion_version: 'v1',
  }));

  let rangeCallCount = 0;
  return {
    client: {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          gte() { return this; },
          lt() { return this; },
          order() { return this; },
          range(from: number, to: number) {
            rangeCallCount++;
            return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
          },
        };
      },
    },
    getRangeCallCount: () => rangeCallCount,
  };
}

test('readBarsForPartition returns ALL rows for a partition with more than one page (1000+) of data, not just the first page', async () => {
  const { client, getRangeCallCount } = fakeSupabaseWithRows(2500, 1000);
  const reader = supabasePostgresBarReader(client);
  const rows = await reader.readBarsForPartition('RELIANCE', 2026, 1);

  assert.equal(rows.length, 2500, 'must return every row across all pages, not truncate at the first page size');
  assert.equal(getRangeCallCount(), 3, 'expected exactly 3 page requests for 2500 rows at page size 1000 (1000+1000+500)');
});

test('readBarsForPartition returns exactly the rows for a partition smaller than one page, in a single request', async () => {
  const { client, getRangeCallCount } = fakeSupabaseWithRows(42, 1000);
  const reader = supabasePostgresBarReader(client);
  const rows = await reader.readBarsForPartition('RELIANCE', 2026, 1);

  assert.equal(rows.length, 42);
  assert.equal(getRangeCallCount(), 1);
});

test('readBarsForPartition returns an empty array (never throws) for a genuinely empty partition', async () => {
  const { client } = fakeSupabaseWithRows(0, 1000);
  const reader = supabasePostgresBarReader(client);
  const rows = await reader.readBarsForPartition('RELIANCE', 2026, 1);
  assert.equal(rows.length, 0);
});

test('readBarsForPartition handles an EXACT page-size boundary (1000 rows) correctly — one full page plus a confirming empty page, not an off-by-one truncation', async () => {
  const { client, getRangeCallCount } = fakeSupabaseWithRows(1000, 1000);
  const reader = supabasePostgresBarReader(client);
  const rows = await reader.readBarsForPartition('RELIANCE', 2026, 1);

  assert.equal(rows.length, 1000);
  assert.equal(getRangeCallCount(), 2, 'a full first page must trigger one more request to confirm there is no further data');
});
