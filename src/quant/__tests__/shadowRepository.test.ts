import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupeIvHistoryRows, type IvHistoryRow } from '../execution/shadowRepository.ts';

function ivRow(overrides: Partial<IvHistoryRow> = {}): IvHistoryRow {
  return {
    capturedAt: '2026-09-25T10:00:00Z', symbol: 'NIFTY', expiry: '2026-10-30', atmStrike: 24000,
    atmCallIv: 0.14, atmPutIv: 0.145, combinedAtmIv: 0.1425, calendarDte: 30, tradingSessionHorizon: 21,
    spot: 24000, indiaVix: 13, ...overrides,
  };
}

test('dedupeIvHistoryRows keeps exactly one row per (symbol, expiry) within a batch', () => {
  const rows = [
    ivRow({ expiry: '2026-10-30' }),
    ivRow({ expiry: '2026-10-30', combinedAtmIv: 0.15 }), // duplicate within the same scan — last write wins
    ivRow({ expiry: '2026-11-27' }),
  ];
  const deduped = dedupeIvHistoryRows(rows);
  assert.equal(deduped.length, 2);
  const oct = deduped.find((r) => r.expiry === '2026-10-30')!;
  assert.equal(oct.combinedAtmIv, 0.15);
});

test('dedupeIvHistoryRows keeps different symbols with the same expiry as separate rows', () => {
  const rows = [ivRow({ symbol: 'NIFTY' }), ivRow({ symbol: 'BANKNIFTY' })];
  assert.equal(dedupeIvHistoryRows(rows).length, 2);
});

test('dedupeIvHistoryRows on an empty array returns an empty array', () => {
  assert.deepEqual(dedupeIvHistoryRows([]), []);
});
