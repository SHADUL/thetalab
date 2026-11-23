import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathFromMinuteBars, histReplay, weeklyExpiries, histInstruments, type HistDay, type MinuteCandle } from '../sim/historical.ts';

const weekday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5 && d !== '2026-11-24'; };

/** A real-shaped day: gap up 25,100 → 25,200, OR 25,180–25,230, upside breakout at 10:00. */
function day(o: { dipToPrevAt?: number } = {}): HistDay {
  const bars: MinuteCandle[] = [];
  for (let m = 555; m <= 929; m++) {
    const c = m < 560 ? 25200 : m < 570 ? 25230 : m < 600 ? 25190 : 25260;
    const prev = bars.length ? bars[bars.length - 1].c : 25200;
    bars.push({ label: m, o: m === 555 ? 25200 : prev, h: Math.max(prev, c) + 2, l: m === o.dipToPrevAt ? 25099 : Math.min(prev, c) - 2, c });
  }
  const prevBars = Array.from({ length: 375 }, (_, i) => ({ label: 555 + i, close: i === 360 ? 25100 : i === 100 ? 25260 : i === 200 ? 25010 : 25120 }));
  return { kind: 'NIFTY_ASCENT_HIST_DAY', date: '2026-11-18', prevDate: '2026-11-17', bars, prevBars, vixPrevClose: 12, expiries: ['2026-11-24', '2026-12-01'], lotSize: 65, strikeStep: 50, source: 'KITE_HISTORICAL', fetchedAt: '' };
}

test('path: every minute close is exact, the 09:15 open is the first tick, intra-minute high/low are reached', () => {
  const bars: MinuteCandle[] = [{ label: 555, o: 100, h: 110, l: 95, c: 105 }, { label: 556, o: 105, h: 108, l: 90, c: 92 }];
  const p = pathFromMinuteBars(bars);
  assert.equal(p[0], 100);
  assert.equal(p[59], 105); assert.equal(p[60 + 59], 92);
  assert.equal(Math.max(...p.slice(0, 60)), 110); assert.equal(Math.min(...p.slice(0, 60)), 95);
  assert.equal(p[20], 95, 'up candle: low first'); assert.equal(p[60 + 20], 108, 'down candle: high first');
  assert.ok(Number.isNaN(p[2 * 60]), 'no data → no ticks (never invented)');
});

test('expiries: Tuesday weeklies, moved to the previous trading day when Tuesday is a holiday', () => {
  assert.deepEqual(weeklyExpiries('2026-11-23', weekday), ['2026-11-23', '2026-12-01']);
  assert.deepEqual(weeklyExpiries('2026-11-25', weekday), ['2026-12-01', '2026-12-08']);
  assert.deepEqual(weeklyExpiries('2026-11-17', weekday), ['2026-11-17', '2026-11-23']);
});

test('historical replay drives the real engine: reference = real open, exact closes, signal and modelled fills', () => {
  const e = histReplay(day()).runToEnd();
  assert.equal(e.reference!.price, 25200);
  assert.equal(e.prevClose, 25100);
  assert.equal(e.signal?.bot, 'GAP_AND_GO');
  assert.equal(e.signal?.right, 'CE');
  assert.equal(e.index.get(600)!.close, 25260);
  assert.equal(e.positionsToday <= 1, true);
});

test('an intra-minute low touching the previous close fills the gap (tick-based Q3) even though no close does', () => {
  const e = histReplay(day({ dipToPrevAt: 590 })).runToEnd();
  assert.ok(e.gapFill && e.gapFill.price <= 25100);
  assert.equal(e.standDown?.reason, 'filled');
});

test('historical replay is deterministic and uses listed strikes / both expiries', () => {
  const a = histReplay(day()).runToEnd(), b = histReplay(day()).runToEnd();
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  const inst = histInstruments(day());
  assert.deepEqual([...new Set(inst.map((i) => i.expiry))], ['2026-11-24', '2026-12-01']);
  assert.ok(inst.every((i) => i.strike % 50 === 0 && i.lotSize === 65));
});
