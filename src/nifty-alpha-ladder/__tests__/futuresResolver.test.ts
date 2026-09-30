import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNfoFutures, resolveNearestFuture } from '../live/futuresResolver.ts';

// A real (trimmed) sample of Kite's actual instruments/NFO dump, captured
// 2026-09-30 — the quoted `name` field is the exact real formatting that
// broke a naive unquoted string-equality check during live verification.
const REAL_SAMPLE_CSV = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
12468226,48704,NIFTY26OCTFUT,"NIFTY",0,2026-10-27,0,0.1,65,FUT,NFO-FUT,NFO
15736578,61471,NIFTY26NOVFUT,"NIFTY",0,2026-11-23,0,0.1,65,FUT,NFO-FUT,NFO
15072002,58875,NIFTY26DECFUT,"NIFTY",0,2026-12-29,0,0.1,65,FUT,NFO-FUT,NFO
9999999,1234,BANKNIFTY26OCTFUT,"BANKNIFTY",0,2026-10-27,0,0.1,35,FUT,NFO-FUT,NFO
1111111,5555,NIFTY26SEPFUT,"NIFTY",0,2026-09-30,0,0.1,65,FUT,NFO-FUT,NFO
2222222,6666,NIFTYOPT,"NIFTY",100,2026-10-27,25000,0.05,65,CE,NFO-OPT,NFO
`;

test('parseNfoFutures: strips the quoted name field and keeps only FUT rows', () => {
  const rows = parseNfoFutures(REAL_SAMPLE_CSV);
  assert.equal(rows.length, 5); // the CE option row is excluded
  assert.ok(rows.every((r) => r.instrumentType === 'FUT'));
  assert.ok(rows.every((r) => r.name === 'NIFTY' || r.name === 'BANKNIFTY')); // unquoted, exact match possible
});

test('resolveNearestFuture: never returns a BANKNIFTY or options row for the NIFTY underlying', () => {
  const rows = parseNfoFutures(REAL_SAMPLE_CSV);
  const nearest = resolveNearestFuture(rows, 'NIFTY', '2026-11-01');
  assert.equal(nearest?.tradingsymbol, 'NIFTY26NOVFUT');
});

test('resolveNearestFuture: a contract expiring exactly today is still eligible (>= todayISO), not treated as already expired', () => {
  const rows = parseNfoFutures(REAL_SAMPLE_CSV);
  const nearest = resolveNearestFuture(rows, 'NIFTY', '2026-09-30');
  assert.equal(nearest?.expiry, '2026-09-30');
  assert.equal(nearest?.tradingsymbol, 'NIFTY26SEPFUT');
});

test('resolveNearestFuture: a contract that expired yesterday is excluded, next month becomes nearest', () => {
  const rows = parseNfoFutures(REAL_SAMPLE_CSV);
  const nearest = resolveNearestFuture(rows, 'NIFTY', '2026-10-01');
  assert.equal(nearest?.tradingsymbol, 'NIFTY26OCTFUT');
});

test('resolveNearestFuture: returns null (never fabricates) when no contract exists for the underlying', () => {
  const rows = parseNfoFutures(REAL_SAMPLE_CSV);
  assert.equal(resolveNearestFuture(rows, 'SENSEX', '2026-09-30'), null);
});
