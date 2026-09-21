import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKiteOptionsCSV,
  filterActiveInstruments,
  buildInstrumentKey,
  indexInstruments,
  OPTIONS_SYMBOLS,
} from '../optionsInstrumentMaster.js';

const HEADER = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange';

// `name` defaults to a quoted value because that's what Kite's real dump
// actually sends (confirmed against a live response: `"NIFTY"`, literal
// quote characters) — every test below exercises that real-world shape by
// default, not an idealized unquoted one.
function csvRow({
  token = 256265, exchangeToken = 1001, tradingsymbol = 'NIFTY26D0325000CE', name = '"NIFTY"',
  lastPrice = 0, expiry = '2026-12-03', strike = 25000, tick = 0.05, lot = 65, type = 'CE',
  segment = 'NFO-OPT', exchange = 'NFO',
} = {}) {
  return [token, exchangeToken, tradingsymbol, name, lastPrice, expiry, strike, tick, lot, type, segment, exchange].join(',');
}

test('parseKiteOptionsCSV keeps only CE/PE rows for the wanted symbols on their correct exchange', () => {
  const csv = [
    HEADER,
    csvRow(), // NIFTY CE, NFO — kept
    csvRow({ tradingsymbol: 'NIFTY26D0325000PE', type: 'PE' }), // kept
    csvRow({ tradingsymbol: 'RELIANCE26D03', name: '"RELIANCE"', type: 'FUT', segment: 'NFO-FUT' }), // wrong symbol — dropped
    csvRow({ tradingsymbol: 'SENSEX26D0381000CE', name: '"SENSEX"', exchange: 'NFO' }), // SENSEX on wrong exchange — dropped
    csvRow({ tradingsymbol: 'SENSEX26D0381000CE', name: '"SENSEX"', exchange: 'BFO' }), // kept
  ].join('\n');

  const rows = parseKiteOptionsCSV(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tradingsymbol).sort(), ['NIFTY26D0325000CE', 'NIFTY26D0325000PE', 'SENSEX26D0381000CE'].sort());
  const nifty = rows.find((r) => r.tradingsymbol === 'NIFTY26D0325000CE');
  assert.equal(nifty.symbol, 'NIFTY');
  assert.equal(nifty.exchange, 'NFO');
  assert.equal(nifty.strike, 25000);
  assert.equal(nifty.right, 'CE');
  assert.equal(nifty.instrument_token, 256265);
  assert.equal(nifty.lot_size, 65);
  assert.equal(nifty.tick_size, 0.05);
});

test('parseKiteOptionsCSV reads fields after `name` from the end of the row, unaffected by a longer row', () => {
  // Simulates a row with one extra unexpected column inserted between
  // `tradingsymbol` and `name` (a shape mismatch, not a comma-in-name
  // scenario — that one doesn't apply here since a clean, comma-free
  // `name` is what real Kite index-option rows always have). Every field
  // this parser actually filters/reads that comes AFTER `name` — expiry,
  // strike, tick_size, lot_size, instrument_type, segment, exchange —
  // must still resolve correctly by counting from the row's end.
  const longerRow = '256265,1001,extra-column,NIFTY26D0325000CE,NIFTY,0,2026-12-03,25000,0.05,65,CE,NFO-OPT,NFO';
  const csv = [HEADER, longerRow].join('\n');
  const rows = parseKiteOptionsCSV(csv);
  // tradingsymbol/instrument_token are front-indexed, so they land on the
  // wrong (shifted) cells here — that's expected and out of scope for
  // this test. What matters is that the from-the-end fields are correct.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'NIFTY');
  assert.equal(rows[0].expiry, '2026-12-03');
  assert.equal(rows[0].strike, 25000);
  assert.equal(rows[0].right, 'CE');
  assert.equal(rows[0].lot_size, 65);
  assert.equal(rows[0].tick_size, 0.05);
  assert.equal(rows[0].exchange, 'NFO');
});

test('parseKiteOptionsCSV handles real captured Kite dump lines (quoted name, mixed FUT/CE rows)', () => {
  // Verbatim sample lines from a live /instruments/NFO and /instruments/BFO
  // response (captured 2026-09-20) — `name` really is wrapped in literal
  // double quotes, which is exactly what caused the very first production
  // run of this sync to silently parse zero rows before this was fixed.
  const nfoFutureRow = '17512194,68407,NIFTY26SEPFUT,"NIFTY",0,2026-09-29,0,0.1,65,FUT,NFO-FUT,NFO';
  const bfoFutureRow = '216455429,845529,BANKEX26SEPFUT,"BANKEX",0,2026-09-24,0,0.05,30,FUT,BFO-FUT,BFO';
  const nfoOptionRow = '17512195,68408,NIFTY26SEP25000CE,"NIFTY",0,2026-09-29,25000,0.05,65,CE,NFO-OPT,NFO';
  const csv = [HEADER, nfoFutureRow, bfoFutureRow, nfoOptionRow].join('\n');

  const rows = parseKiteOptionsCSV(csv);
  // Both futures rows are dropped (instrument_type FUT, not CE/PE; BANKEX
  // isn't even a wanted symbol) — only the genuine option row survives.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'NIFTY');
  assert.equal(rows[0].tradingsymbol, 'NIFTY26SEP25000CE');
  assert.equal(rows[0].right, 'CE');
  assert.equal(rows[0].strike, 25000);
});

test('parseKiteOptionsCSV drops rows with invalid numeric fields', () => {
  const csv = [HEADER, csvRow({ strike: 0 }), csvRow({ token: 'not-a-number' })].join('\n');
  assert.equal(parseKiteOptionsCSV(csv).length, 0);
});

test('parseKiteOptionsCSV handles CRLF line endings', () => {
  const csv = [HEADER, csvRow()].join('\r\n');
  const rows = parseKiteOptionsCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exchange, 'NFO');
});

test('filterActiveInstruments drops expired contracts, keeps today and future', () => {
  const instruments = [
    { expiry: '2026-01-01' },
    { expiry: '2026-09-20' },
    { expiry: '2026-09-25' },
  ];
  const active = filterActiveInstruments(instruments, '2026-09-20');
  assert.deepEqual(active.map((i) => i.expiry), ['2026-09-20', '2026-09-25']);
});

test('buildInstrumentKey/indexInstruments round-trip a lookup', () => {
  const inst = { symbol: 'NIFTY', expiry: '2026-09-25', strike: 25000, right: 'CE', tradingsymbol: 'NIFTY26D0325000CE' };
  const map = indexInstruments([inst]);
  assert.equal(map.get(buildInstrumentKey(inst)), inst);
  assert.equal(map.get(buildInstrumentKey({ ...inst, strike: 25050 })), undefined);
});

test('OPTIONS_SYMBOLS maps each supported underlying to its correct exchange', () => {
  assert.equal(OPTIONS_SYMBOLS.NIFTY, 'NFO');
  assert.equal(OPTIONS_SYMBOLS.BANKNIFTY, 'NFO');
  assert.equal(OPTIONS_SYMBOLS.SENSEX, 'BFO');
});
