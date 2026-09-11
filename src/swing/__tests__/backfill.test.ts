import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseBhavcopy, isStaleResponse } from '../scripts/backfillDailyOhlcv.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, 'bhavcopySample.csv'), 'utf8');

test('parseBhavcopy extracts EQ rows with correctly reordered ISO dates', () => {
  const rows = parseBhavcopy(sample);
  assert.equal(rows.length, 2, 'only the two EQ rows should survive — BE and GS are not equity cash-market series');

  const reliance = rows.find((r) => r.symbol === 'RELIANCE');
  assert.ok(reliance);
  assert.equal(reliance!.date, '2026-09-09');
  assert.equal(reliance!.open, 1283.5);
  assert.equal(reliance!.high, 1294.7);
  assert.equal(reliance!.low, 1277.2);
  assert.equal(reliance!.close, 1279);
  assert.equal(reliance!.volume, 12152819);
});

test('parseBhavcopy excludes non-EQ series (BE, GS, ...)', () => {
  const rows = parseBhavcopy(sample);
  assert.ok(!rows.some((r) => r.symbol === '3IINFOLTD'), 'BE series should be filtered out');
  assert.ok(!rows.some((r) => r.symbol === '574GS2026'), 'GS series should be filtered out');
});

test('isStaleResponse catches NSE serving a previous trading day back on a weekend/holiday', () => {
  const rows = parseBhavcopy(sample); // every row here is dated 2026-09-09
  assert.equal(isStaleResponse(rows, '2026-09-09'), false, 'the date actually requested is never stale');
  assert.equal(isStaleResponse(rows, '2026-09-12'), true, 'a Saturday request answered with Wednesday\'s file is stale');
});

test('isStaleResponse treats a genuinely empty response as not stale', () => {
  assert.equal(isStaleResponse([], '2026-09-12'), false, 'empty-but-200 is a different, already-handled case');
});
