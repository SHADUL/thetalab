import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bhavcopyUrl, parseUdiffBhavcopy } from '../backtest/bhavcopy.ts';

const HEADER = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4';

function row({
  ticker = 'NIFTY', expiry = '2026-09-29', strike = 25000, right = 'CE',
  close = 120.5, settle = 120.5, oi = 5000, volume = 800, underlying = 24950, lot = 65,
} = {}) {
  return [
    '2026-09-15', '2026-09-15', 'FO', 'NSE', 'IDO', '12345', '', ticker, '',
    expiry, expiry, strike.toFixed(2), right, `${ticker}NAME`,
    close.toFixed(2), close.toFixed(2), close.toFixed(2), close.toFixed(2), close.toFixed(2), close.toFixed(2),
    underlying.toFixed(2), settle.toFixed(2), oi, 0, volume, '0.00', 10, 'F1', lot, '', '', '', '', '',
  ].join(',');
}

test('bhavcopyUrl routes NIFTY/BANKNIFTY to NSE (zipped) and SENSEX to BSE (plain CSV)', () => {
  const nifty = bhavcopyUrl('NIFTY', '2026-09-15');
  assert.match(nifty.url, /nsearchives\.nseindia\.com/);
  assert.equal(nifty.zipped, true);

  const bank = bhavcopyUrl('BANKNIFTY', '2026-09-15');
  assert.match(bank.url, /nsearchives\.nseindia\.com/);

  const sensex = bhavcopyUrl('SENSEX', '2026-09-15');
  assert.match(sensex.url, /bseindia\.com/);
  assert.equal(sensex.zipped, false);
});

test('bhavcopyUrl refuses an unconfigured symbol rather than guessing a URL', () => {
  assert.throws(() => bhavcopyUrl('RANDOMSTOCK', '2026-09-15'));
});

test('parseUdiffBhavcopy matches the ticker exactly, not as a substring (NIFTY vs BANKNIFTY)', () => {
  const csv = [HEADER, row({ ticker: 'NIFTY' }), row({ ticker: 'BANKNIFTY', strike: 58000 })].join('\n');
  const day = parseUdiffBhavcopy(csv, 'NIFTY', '2026-09-15');
  assert.equal(day.rows.length, 1);
  assert.equal(day.rows[0].strike, 25000);
});

test('parseUdiffBhavcopy extracts spot and lot size from the row data, not a hardcoded assumption', () => {
  const csv = [HEADER, row({ underlying: 24987.65, lot: 75 })].join('\n');
  const day = parseUdiffBhavcopy(csv, 'NIFTY', '2026-09-15');
  assert.equal(day.spot, 24987.65);
  assert.equal(day.lotSize, 75);
});

test('parseUdiffBhavcopy prefers SttlmPric over ClsPric, falling back only when settlement is zero', () => {
  const csv = [HEADER, row({ close: 100, settle: 115.5 })].join('\n');
  const day = parseUdiffBhavcopy(csv, 'NIFTY', '2026-09-15');
  assert.equal(day.rows[0].settle, 115.5);
});

test('parseUdiffBhavcopy falls back to ClsPric when SttlmPric is zero (an untraded strike with no computed settlement)', () => {
  const csv = [HEADER, row({ close: 42.1, settle: 0 })].join('\n');
  const day = parseUdiffBhavcopy(csv, 'NIFTY', '2026-09-15');
  assert.equal(day.rows[0].settle, 42.1);
});

test('parseUdiffBhavcopy drops a row with no usable settlement price at all, rather than keeping a zero', () => {
  const csv = [HEADER, row({ close: 0, settle: 0 })].join('\n');
  const day = parseUdiffBhavcopy(csv, 'NIFTY', '2026-09-15');
  assert.equal(day.rows.length, 0);
});

test('parseUdiffBhavcopy drops futures/non-option rows (OptnTp not CE/PE)', () => {
  const futRow = row({ ticker: 'NIFTY' }).split(',');
  futRow[12] = ''; // OptnTp blank, as a futures row would have
  const csv = [HEADER, futRow.join(',')].join('\n');
  const day = parseUdiffBhavcopy(csv, 'NIFTY', '2026-09-15');
  assert.equal(day.rows.length, 0);
});
