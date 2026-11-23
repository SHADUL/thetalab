import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuoteAdapter, NIFTY_INDEX_TOKEN } from '../live/adapter.ts';
import { parseDayCandles, loadPrevSession, previousTradingDay, candleLabel } from '../live/history.ts';
import { validateInstruments, selectContract, type Instrument } from '../core/contracts.ts';
import { LiveAscentService, type InstrumentPort, type StreamPort } from '../live/service.ts';
import { RESEARCH_RULES_V1 as R, hhmm } from '../core/rules.ts';
import { at, instruments as mkInst } from './helpers.ts';

const weekday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };
const kiteTs = (date: string, label: number) => `${date}T${hhmm(label)}:00+0530`;
const dayCandles = (date: string, o: { drop?: number[]; c1515?: number } = {}) => {
  const out: unknown[] = [];
  for (let m = 555; m <= 929; m++) if (!(o.drop ?? []).includes(m)) out.push([kiteTs(date, m), 1, 1, 1, m === 915 ? (o.c1515 ?? 25100) : 25000 + (m % 40), 0]);
  return out;
};

/* ---------------- adapter ---------------- */

test('adapter: index quotes need an exchange timestamp; receipt time is never used instead', () => {
  const a = new QuoteAdapter();
  const q = { token: NIFTY_INDEX_TOKEN, ltp: 25000, bid: null, ask: null, volume: null, receivedAt: 1_000_500 };
  assert.equal(a.adapt(q, null, () => false).kind, 'DROP');
  assert.equal(a.stats.noExchangeTs, 1);
  const ev = a.adapt(q, 1_000_000, () => false);
  assert.deepEqual(ev, { kind: 'INDEX', tick: { exchTs: 1_000_000, recvTs: 1_000_500, price: 25000 } });
});

test('adapter: an option print is a trade only when cumulative volume rises (first packet is never a trade)', () => {
  const a = new QuoteAdapter();
  const q = (volume: number, ltp = 200) => ({ token: 77, ltp, bid: 199.5, ask: 200.5, volume, receivedAt: 5 });
  const ev1 = a.adapt(q(1000), 1, () => true);
  assert.equal(ev1.kind === 'OPTION' && ev1.tick.traded, false, 'first packet: LTP may be stale');
  const ev2 = a.adapt(q(1000, 201), 2, () => true);
  assert.equal(ev2.kind === 'OPTION' && ev2.tick.traded, false, 'same volume: quote update, no trade');
  const ev3 = a.adapt(q(1065, 201.5), 3, () => true);
  assert.ok(ev3.kind === 'OPTION' && ev3.tick.traded && ev3.tick.ltp === 201.5);
  const ev4 = a.adapt(q(10), 4, () => true);
  assert.equal(ev4.kind === 'OPTION' && ev4.tick.traded, false, 'volume reset is not a trade');
  assert.equal(a.stats.volumeResets, 1);
  assert.equal(a.adapt(q(2000), 5, () => false).kind, 'DROP', 'contracts the engine did not ask for are ignored');
});

/* ---------------- history ---------------- */

test('history: Kite candle timestamps map to start-labelled IST bars', () => {
  assert.deepEqual(candleLabel('2026-11-20T09:15:00+0530'), { date: '2026-11-20', label: 555 });
  assert.deepEqual(candleLabel('2026-11-20T15:15:00+0530'), { date: '2026-11-20', label: 915 });
  assert.equal(candleLabel('garbage'), null);
});

test('history: session bars only, duplicates and bad rows rejected, 15:15 close reported, out-of-order sorted', () => {
  const c = dayCandles('2026-11-20', { drop: [600, 601] });
  c.push([kiteTs('2026-11-20', 700), 1, 1, 1, 99999, 0]);            // duplicate label → first wins
  c.push(['2026-11-20T09:14:00+0530', 1, 1, 1, 25000, 0]);           // pre-open
  c.push(['2026-11-21T09:15:00+0530', 1, 1, 1, 25000, 0]);           // other day
  c.push([kiteTs('2026-11-20', 800), 1, 1, 1, -5, 0]);               // bad close (but label already present → duplicate check order)
  c.reverse();                                                         // out of order
  const { prev, report } = parseDayCandles('2026-11-20', c);
  assert.equal(report.bars, 373);
  assert.deepEqual(report.missingLabels, [600, 601]);
  assert.equal(report.close1515, 25100);
  assert.ok(report.rejected >= 3);
  assert.ok(prev.bars.every((b, i) => i === 0 || b.label > prev.bars[i - 1].label));
});

test('history: loads the previous TRADING day, skips an unlisted holiday with no candles, never requests today', async () => {
  const asked: string[] = [];
  const fetchData = async (path: string) => {
    asked.push(path);
    const day = path.match(/from=(\d{4}-\d{2}-\d{2})/)![1];
    return { candles: day === '2026-11-20' ? [] : dayCandles(day) };
  };
  assert.equal(previousTradingDay('2026-11-23', weekday), '2026-11-20');
  const { prev, report } = await loadPrevSession('2026-11-23', fetchData, weekday);
  assert.equal(prev.date, '2026-11-19');
  assert.deepEqual(report.skippedDays, ['2026-11-20']);
  assert.ok(asked.every((p) => !p.includes('2026-11-23')));
  assert.match(asked[0], /^\/instruments\/historical\/256265\/minute\?from=2026-11-20\+09:15:00&to=2026-11-20\+15:30:00$/);
});

/* ---------------- instrument master and contract selection ---------------- */

const row = (o: Partial<Instrument>): Instrument => ({ token: 1, tradingsymbol: 'X', strike: 25000, right: 'CE', expiry: '2026-11-24', lotSize: 65, ...o });

test('instruments: bad rows, expired contracts, duplicates and mixed lot sizes are removed and reported', () => {
  const rows = [
    row({ token: 1, strike: 25000 }), row({ token: 2, strike: 25050 }),
    row({ token: 0, strike: 25100 }), row({ token: 3, strike: -1 }), row({ token: 4, right: 'XX' as any }),
    row({ token: 5, expiry: '2026-11-17' }), row({ token: 6, lotSize: 0 }),
    row({ token: 7, strike: 25200 }), row({ token: 8, strike: 25200 }),        // duplicate key
    row({ token: 9, expiry: '2026-12-01', lotSize: 65 }), row({ token: 10, expiry: '2026-12-01', strike: 25050, lotSize: 75 }), // mixed lots
  ];
  const { valid, report } = validateInstruments(rows, '2026-11-23');
  assert.deepEqual(valid.map((r) => r.token), [1, 2]);
  assert.equal(report.issues.length, 7);
  assert.deepEqual(report.expiries, ['2026-11-24']);
  assert.deepEqual(report.lotSizes, { '2026-11-24': 65 });
});

test('selector: CE 150 ITM below / PE 150 ITM above the signal close, tie deeper ITM, lot size from the master', () => {
  const inst = mkInst(['2026-11-24', '2026-12-01'], 65);
  const ce = selectContract(inst, '2026-11-23', 'CE', 25298.34, R);
  assert.ok(ce.ok && ce.strike === 25150 && ce.expiry === '2026-11-24' && ce.instrument.lotSize === 65 && ce.itmPoints === 148.34);
  const pe = selectContract(inst, '2026-11-23', 'PE', 24927.89, R);
  assert.ok(pe.ok && pe.strike === 25100);
  const tieCe = selectContract(inst, '2026-11-23', 'CE', 25125, R), tiePe = selectContract(inst, '2026-11-23', 'PE', 25125, R);
  assert.ok(tieCe.ok && tieCe.strike === 24950 && tiePe.ok && tiePe.strike === 25300);
  assert.ok(selectContract(mkInst(['2026-11-24'], 75), '2026-11-23', 'CE', 25300, R).ok);
});

test('selector: expiry day rolls to the next listed expiry (PROVISIONAL Q9) and says so', () => {
  const s = selectContract(mkInst(['2026-11-24', '2026-12-01']), '2026-11-24', 'CE', 25300, R);
  assert.ok(s.ok && s.expiry === '2026-12-01' && s.expiryRolled);
  const none = selectContract(mkInst(['2026-11-24']), '2026-11-24', 'CE', 25300, R);
  assert.ok(!none.ok && none.code === 'expiry_missing');
});

test('selector: strike interval comes from the listing; a missing exact strike is rejected, never substituted', () => {
  const hundreds = mkInst(['2026-11-24']).filter((i) => i.strike % 100 === 0);
  const s = selectContract(hundreds, '2026-11-23', 'CE', 25298, R);
  assert.ok(s.ok && s.step === 100 && s.strike === 25100); // 25,148 → nearest 100 = 25,100
  const gap = mkInst(['2026-11-24']).filter((i) => i.strike !== 25150);
  const miss = selectContract(gap, '2026-11-23', 'CE', 25298.34, R);
  assert.ok(!miss.ok && miss.code === 'contract_missing' && /25150/.test(miss.detail));
  assert.ok(!selectContract([], '2026-11-23', 'CE', 25000, R).ok);
});

/* ---------------- observe-only service ---------------- */

function fakes(o: { failHistory?: number } = {}) {
  const wants: number[][] = [];
  let listener: ((q: any, ts: number | null) => void) | null = null;
  const stream: StreamPort = { want: (t) => { wants.push(t); }, onQuote: (fn) => { listener = fn; return () => { listener = null; }; }, status: () => ({ connected: true }) };
  let fails = o.failHistory ?? 0;
  const fetchData = async (path: string) => {
    if (fails > 0) { fails--; throw new Error('Kite 503'); }
    const day = path.match(/from=(\d{4}-\d{2}-\d{2})/)![1];
    return { candles: dayCandles(day) };
  };
  const all = mkInst(['2026-11-24', '2026-12-01']);
  const instruments: InstrumentPort = {
    nearestExpiries: async (today, n) => ['2026-11-24', '2026-12-01'].filter((e) => e >= today).slice(0, n),
    strikes: async (e, lo, hi) => all.filter((i) => i.expiry === e && i.strike >= lo && i.strike <= hi),
  };
  return { stream, fetchData, instruments, wants, emit: (q: any, ts: number | null) => listener?.(q, ts) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('service: prepares at 08:50, creates a PAUSED engine, subscribes NIFTY from 09:00, refuses any start', async () => {
  const D = '2026-11-23';
  const f = fakes();
  const logs: string[] = [];
  const s = new LiveAscentService({ ...f, isTradingDay: weekday, log: (m) => logs.push(m) });
  s.tick(at(D, '08:49:59'));
  assert.equal(s.engine == null, true);
  s.tick(at(D, '08:50:00')); await flush(); await flush();
  s.tick(at(D, '08:50:01'));
  assert.ok(s.engine);
  assert.equal(s.engine!.engineStatus, 'PAUSED');
  assert.equal(s.engine!.prevClose, 25100);
  assert.equal(s.engine!.instruments.length > 0, true);
  assert.equal(f.wants.length, 0, 'no subscription before 09:00');
  s.tick(at(D, '09:00:00'));
  assert.deepEqual(f.wants[0], [NIFTY_INDEX_TOKEN]);
  assert.throws(() => s.control('START'), /not enabled in Phase 3/);
  assert.ok(logs.some((l) => /created PAUSED/.test(l)));
});

test('service: history failures retry every minute; still unavailable at 09:14 → engine with DATA_ERROR, no trade', async () => {
  const D = '2026-11-23';
  const f = fakes({ failHistory: 1000 });
  const s = new LiveAscentService({ ...f, isTradingDay: weekday });
  for (let t = at(D, '08:50:00'); t <= at(D, '09:14:00'); t += 1000) { s.tick(t); await flush(); }
  assert.ok(s.engine);
  assert.equal(s.engine!.state, 'DATA_ERROR');
  const s2 = new LiveAscentService({ ...fakes({ failHistory: 1 }), isTradingDay: weekday });
  for (let t = at(D, '08:50:00'); t <= at(D, '08:52:00'); t += 1000) { s2.tick(t); await flush(); }
  assert.ok(s2.engine && s2.engine.prevClose === 25100, 'recovered on the retry a minute later');
});

test('service: non-trading days do nothing; a new IST date starts a fresh day', async () => {
  const f = fakes();
  const s = new LiveAscentService({ ...f, isTradingDay: weekday });
  s.tick(at('2026-11-22', '10:00:00')); await flush();
  assert.equal(s.engine == null, true);
  s.tick(at('2026-11-23', '08:55:00')); await flush(); await flush(); s.tick(at('2026-11-23', '08:55:01'));
  const first = s.engine;
  s.tick(at('2026-11-24', '08:55:00')); await flush(); await flush(); s.tick(at('2026-11-24', '08:55:01'));
  assert.ok(first && s.engine && s.engine !== first && s.engine.date === '2026-11-24');
});

test('service: observe-only signal records the contract it WOULD select, but never orders or fills', async () => {
  const D = '2026-11-23';
  const f = fakes();
  const s = new LiveAscentService({ ...f, isTradingDay: weekday });
  s.tick(at(D, '08:55:00')); await flush(); await flush();
  const price = (t: number) => (t < at(D, '09:20:00') ? 25200 : t < at(D, '09:30:00') ? 25230 : t < at(D, '10:00:00') ? 25180 : 25260);
  for (let t = at(D, '08:55:01'); t <= at(D, '10:05:00'); t += 1000) {
    s.tick(t);
    if (t >= at(D, '09:15:00')) s.onQuote({ token: NIFTY_INDEX_TOKEN, ltp: price(t), bid: null, ask: null, volume: null, receivedAt: t + 150 }, t);
  }
  const e = s.engine!;
  assert.equal(e.signal?.right, 'CE');
  assert.equal(e.entryOrder, null);
  assert.equal(e.positionsToday, 0);
  assert.ok(e.events.some((x) => x.trigger === 'entries_disabled'));
  assert.ok(s.wouldSelect?.ok && s.wouldSelect.strike === 25100);
  assert.equal(s.snapshot().engine?.wouldSelect, s.wouldSelect);
});

/* ---------------- contract expiry safety (owner item 3) ---------------- */

import { FIXTURES } from '../sim/fixtures.ts';
import { Replay, simInstruments, kiteOptionSymbol } from '../sim/market.ts';

test('selector never chooses a contract that expired before the session date', () => {
  const date = '2026-11-23';
  const inst = mkInst(['2026-11-10', '2026-11-17', '2026-11-24']); // two already expired
  for (const right of ['CE', 'PE'] as const) for (let ref = 24000; ref <= 26000; ref += 37.5) {
    const s = selectContract(inst, date, right, ref, R);
    if (s.ok) assert.ok(s.expiry >= date && s.instrument.expiry >= date, `${right} ${ref} → ${s.expiry}`);
  }
  const onlyExpired = selectContract(mkInst(['2026-11-10', '2026-11-17']), date, 'CE', 25000, R);
  assert.ok(!onlyExpired.ok && onlyExpired.code === 'expiry_missing');
  assert.equal(validateInstruments(mkInst(['2026-11-17']), date).valid.length, 0, 'validation drops expired rows too');
});

test('every replay fixture trades only contracts whose expiry is on or after its session date', () => {
  for (const fx of FIXTURES) {
    const e = new Replay(fx).runToEnd();
    for (const i of simInstruments(fx)) assert.ok(i.expiry >= fx.date, `${fx.id}: listed ${i.tradingsymbol}`);
    if (e.trade) assert.ok(e.trade.expiry >= fx.date && (fx.date !== e.trade.expiry), `${fx.id}: ${e.trade.tradingsymbol} expires ${e.trade.expiry}`);
  }
  const f = FIXTURES.find((x) => x.id === 'filled-williams-ce')!;
  const t = new Replay(f).runToEnd().trade!;
  assert.deepEqual([f.date, t.expiry, t.tradingsymbol], ['2026-11-06', '2026-11-10', 'NIFTY26N1025250CE']);
});

test('simulation symbols follow the Kite weekly / monthly convention', () => {
  assert.equal(kiteOptionSymbol('NIFTY', '2026-11-10', 25250, 'CE'), 'NIFTY26N1025250CE');
  assert.equal(kiteOptionSymbol('NIFTY', '2026-11-24', 25000, 'PE'), 'NIFTY26NOV25000PE'); // last Tuesday → monthly
  assert.equal(kiteOptionSymbol('NIFTY', '2026-12-01', 25000, 'CE'), 'NIFTY26D0125000CE');
});

/* ---------------- observation report (owner item 2) ---------------- */

test('service: logs the OR snapshot, 15-minute health lines and a full end-of-session observation report', async () => {
  const D = '2026-11-23';
  const f = fakes();
  const logs: string[] = [];
  let saved: any = null;
  const s = new LiveAscentService({ ...f, isTradingDay: weekday, log: (m) => logs.push(m), saveReport: (_d, r) => { saved = r; } });
  s.tick(at(D, '08:55:00')); await flush(); await flush();
  const price = (t: number) => (t < at(D, '09:20:00') ? 25200 : t < at(D, '09:30:00') ? 25230 : t < at(D, '09:31:00') ? 25180 : t < at(D, '10:05:00') ? 25210 : t < at(D, '10:05:30') ? 25098 : 25210);
  for (let t = at(D, '08:55:01'); t <= at(D, '15:31:05'); t += 1000) {
    s.tick(t);
    if (t >= at(D, '09:15:00') && t < at(D, '15:30:00') && !(t >= at(D, '13:00:00') && t < at(D, '13:01:00'))) s.onQuote({ token: NIFTY_INDEX_TOKEN, ltp: price(t), bid: null, ask: null, volume: null, receivedAt: t + 180 }, t);
  }
  assert.ok(logs.some((l) => l.startsWith('OBSERVATION opening_range')));
  assert.ok(logs.filter((l) => l.startsWith('OBSERVATION health')).length >= 20);
  assert.ok(saved && logs.some((l) => l.startsWith('OBSERVATION report')));
  assert.equal(saved.mode, 'OBSERVE_ONLY');
  assert.equal(saved.previousSession.close1515, 25100);
  assert.equal(saved.reference.price, 25200);
  assert.deepEqual([saved.gap.direction, saved.gap.points], ['UP', 100]);
  assert.equal(saved.openingRange.closes.length, 31);
  assert.deepEqual([saved.openingRange.high, saved.openingRange.low, saved.openingRange.width], [25230, 25180, 50]);
  assert.ok(saved.gapFill && saved.gapFill.price === 25098);
  assert.deepEqual(saved.dataQuality.missing, ['13:00']);
  assert.equal(saved.dataQuality.indexLag.avgMs, 180);
  assert.equal(saved.perMinute.rows.length, 375);
  assert.equal(saved.dataQuality.adapter.noExchangeTs, 0);
});
