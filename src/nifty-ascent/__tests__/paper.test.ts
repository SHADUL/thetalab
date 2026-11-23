/** Phase 4 — live PAPER mode of the service: lease, persistence, recovery, controls. Paper fills only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveAscentService, type InstrumentPort, type StreamPort } from '../live/service.ts';
import { MemoryAscentStore } from '../live/store.ts';
import { NIFTY_INDEX_TOKEN } from '../live/adapter.ts';
import { at, instruments as mkInst } from './helpers.ts';
import { hhmm } from '../core/rules.ts';

const D = '2026-11-25';
const weekday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };
const all = mkInst(['2026-12-01', '2026-12-08']);
const deps = (store: MemoryAscentStore, holder: string) => ({
  stream: { want() {}, onQuote: () => () => {}, status: () => ({ connected: true, subscribed: 5 }) } as StreamPort,
  fetchData: async (p: string) => { const day = p.match(/from=(\d{4}-\d{2}-\d{2})/)![1]; const c = []; for (let m = 555; m <= 929; m++) c.push([`${day}T${hhmm(m)}:00+0530`, 0, 0, 0, m === 915 ? 25100 : m === 660 ? 25260 : m === 810 ? 25010 : 25120, 0]); return { candles: c }; },
  instruments: { nearestExpiries: async () => ['2026-12-01', '2026-12-08'], strikes: async (e: string, lo: number, hi: number) => all.filter((i) => i.expiry === e && i.strike >= lo && i.strike <= hi) } as InstrumentPort,
  isTradingDay: weekday, mode: 'PAPER' as const, store, holder,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Gap up 25,100 → 25,200, OR 25,180–25,230, upside breakout at 10:00. */
const nifty = (t: number) => (t < at(D, '09:20:00') ? 25200 : t < at(D, '09:30:00') ? 25230 : t < at(D, '10:00:00') ? 25190 : 25260);
let vol = 100_000;

/** Drive a service second by second with index ticks and real-shaped option quotes (+LTT metadata). */
async function run(s: LiveAscentService, from: string, to: string, o: { premium?: (t: number) => number; onSecond?: (t: number) => void | Promise<void>; staleOptions?: boolean } = {}) {
  for (let t = at(D, from); t <= at(D, to); t += 1000) {
    await o.onSecond?.(t);
    s.tick(t);
    await flush();
    if (t >= at(D, '09:15:00') && t < at(D, '15:30:00')) s.onQuote({ token: NIFTY_INDEX_TOKEN, ltp: nifty(t), bid: null, ask: null, volume: null, receivedAt: t + 150 }, t);
    const e = s.engine;
    if (!e) continue;
    for (const tok of new Set([...e.wantedTokens(), ...s.presubscribed])) {
      const inst = all.find((i) => i.token === tok)!;
      const p = o.premium ? o.premium(t) : Math.max(nifty(t) - inst.strike, 0) + 40;
      vol += 65;
      s.onQuote({ token: tok, ltp: p, bid: p - 0.25, ask: p + 0.25, volume: vol, receivedAt: t + (o.staleOptions ? 5000 : 300) }, t, { lastTradeTs: t, lastTradedQty: 65 });
    }
  }
  await s.flushWrites();
}

test('paper mode: engine starts PAUSED; without START or auto-start a real signal is recorded but never entered', async () => {
  const store = new MemoryAscentStore();
  const s = new LiveAscentService(deps(store, 'A'));
  await run(s, '08:55:00', '10:05:00');
  assert.equal(s.engine!.engineStatus, 'PAUSED');
  assert.equal(s.engine!.signal?.right, 'CE');
  assert.equal(s.engine!.positionsToday, 0);
  assert.equal(store.trades.size, 0);
  assert.ok([...store.events.values()].some((e) => e.trigger === 'entries_disabled'), 'audit trail persisted');
});

test('paper mode with auto-start: fills at real bid/ask quotes, manages the position, persists order, trade and journal', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const s = new LiveAscentService(deps(store, 'A'));
  await run(s, '08:55:00', '15:31:30');
  const e = s.engine!;
  assert.equal(e.positionsToday, 1);
  assert.ok(e.trade && e.trade.exitReason === 'TIME_EXIT');
  assert.equal(e.trade!.expiry >= D, true);
  assert.equal(e.trade!.qty, 65);
  assert.equal(store.trades.size, 1);
  assert.equal(store.trades.get(D)!.net, e.trade!.net);
  assert.equal(store.orders.get(`${D}|ENTRY`)!.status, 'FILLED');
  assert.equal(store.orders.get(`${D}|EXIT`)!.status, 'FILLED');
  const entry = store.orders.get(`${D}|ENTRY`)!;
  assert.ok(entry.fill!.quoteAgeMs <= 2000 && entry.fill!.price > entry.fill!.quoteAsk, 'fill = fresh ask + slippage');
  assert.equal(store.sessions.get(D)!.positionsToday, 1);
  assert.deepEqual((await store.history(10)).map((t) => t.date), [D]);
});

test('stale option quotes are never filled: the entry is rejected and the day ends without a trade', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const s = new LiveAscentService(deps(store, 'A'));
  await run(s, '08:55:00', '10:05:00', { staleOptions: true });
  assert.equal(s.engine!.positionsToday, 0);
  assert.equal(s.engine!.entryOrder?.status, 'REJECTED');
  assert.equal(store.orders.get(`${D}|ENTRY`)!.status, 'REJECTED');
  assert.equal(store.trades.size, 0);
});

test('restart recovery: a new process resumes the open paper position from the database and exits it once', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const a = new LiveAscentService(deps(store, 'A'));
  await run(a, '08:55:00', '11:00:00');
  assert.equal(a.engine!.state, 'POSITION_OPEN');
  // Process A dies. B starts 100 s later (A's 90 s lease has expired).
  const b = new LiveAscentService(deps(store, 'B'));
  await run(b, '11:01:40', '15:31:30');
  const e = b.engine!;
  assert.ok(e.events.some((x) => x.trigger === 'restored'));
  assert.equal(e.positionsToday, 1, 'never re-entered');
  assert.ok(e.trade);
  assert.equal(store.trades.size, 1);
  assert.equal([...store.events.values()].filter((x) => x.kind === 'FILL' && x.trigger === 'entry_fill').length, 1);
});

test('single-engine lease: a second instance cannot start or trade while the first holds the lease', async () => {
  const store = new MemoryAscentStore();
  const a = new LiveAscentService(deps(store, 'A'));
  const b = new LiveAscentService(deps(store, 'B'));
  await run(a, '08:55:00', '08:55:15');
  await run(b, '08:55:00', '08:55:15');
  assert.equal(a.leaseOk, true);
  assert.equal(b.leaseOk, false);
  const r = await b.control('START');
  assert.equal(r.ok, false);
  assert.match(r.message, /lease/);
  assert.equal((await a.control('START')).ok, true);
});

test('database failure blocks new entries; the engine is stopped before the signal and nothing is filled', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const s = new LiveAscentService(deps(store, 'A'));
  await run(s, '08:55:00', '09:50:00');
  assert.equal(s.engine!.engineStatus, 'RUNNING');
  store.fail = true;
  await run(s, '09:50:01', '10:05:00');
  assert.equal(s.storeOk, false);
  assert.equal(s.engine!.engineStatus, 'RUNNING', "the owner's START is not overwritten");
  assert.match(String(s.engine!.externalBlock), /database|lease/, 'a failing database also fails the lease renewal');
  assert.equal(s.engine!.positionsToday, 0);
});

test('a restart before the lease is re-acquired never leaves entries stopped for the day', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const a = new LiveAscentService(deps(store, 'A'));
  await run(a, '08:55:00', '09:40:05'); // dies just after the 09:39 bar is confirmed and saved
  assert.equal(a.engine!.engineStatus, 'RUNNING');
  // Restart (a restart that loses a whole minute in a signal window is DATA_ERROR by the approved policy): new process, previous lease still valid for a while → temporarily blocked, then lifted.
  const b = new LiveAscentService(deps(store, 'B'));
  await run(b, '09:40:30', '09:41:00');
  assert.equal(b.engine!.engineStatus, 'RUNNING', 'restored as RUNNING, not stopped');
  assert.ok(b.engine!.externalBlock, 'blocked while the old lease is still held');
  await run(b, '09:41:01', '10:05:00');
  assert.equal(b.engine!.externalBlock, null, 'block lifted once the lease is acquired');
  assert.equal(b.engine!.positionsToday, 1, 'the 10:00 breakout is traded');
});

test('KILL / FLATTEN closes the open paper position at a fresh bid and persists the kill switch into the next session', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const s = new LiveAscentService(deps(store, 'A'));
  await run(s, '08:55:00', '10:30:00');
  assert.equal(s.engine!.state, 'POSITION_OPEN');
  assert.equal((await s.control('KILL')).ok, true);
  await run(s, '10:30:01', '10:31:00');
  assert.equal(s.engine!.trade?.exitReason, 'KILL_FLATTEN');
  assert.equal(store.control.killSwitch, true);
  const r = await s.control('START');
  assert.equal(r.ok, false);
  assert.match(r.message, /kill switch/);
});

test('observe mode refuses every control and auto-start', async () => {
  const store = new MemoryAscentStore();
  const s = new LiveAscentService({ ...deps(store, 'A'), mode: 'OBSERVE', store: undefined });
  for (const a of ['START', 'STOP_ENTRIES', 'KILL', 'RELEASE'] as const) assert.match((await s.control(a)).message, /NOT ENABLED/);
  assert.equal((await s.setAutoStart(true)).ok, false);
  assert.throws(() => new LiveAscentService({ ...deps(store, 'A'), store: undefined }), /requires the database/);
});

test('late start mid-session: waits for the previous session to load, then logs missed minutes as one summary line', async () => {
  const store = new MemoryAscentStore();
  const logs: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const d = deps(store, 'A');
  const slowFetch = async (p: string) => { await gate; return d.fetchData(p); };
  const s = new LiveAscentService({ ...d, fetchData: slowFetch, log: (m) => logs.push(m) });
  s.tick(at(D, '14:48:00')); await flush();
  s.tick(at(D, '14:48:01')); await flush();
  assert.equal(s.engine == null, true, 'no engine before the first preparation attempt finishes');
  release(); await flush(); await flush(); await flush();
  for (let t = at(D, '14:48:02'); t <= at(D, '14:48:06'); t += 1000) { s.tick(t); await flush(); await flush(); }
  assert.ok(s.engine);
  assert.equal(s.engine!.prevClose, 25100, 'previous session loaded — not a false DATA_ERROR from missing history');
  assert.equal(s.engine!.state, 'DATA_ERROR', 'unobserved opening range → no trade today');
  const lines = logs.filter((l) => l.includes('missing_bar'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\d+ minutes without a valid NIFTY tick \(09:15–14:47\)/);
});
