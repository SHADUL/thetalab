/** Late-start recovery (owner decision 25 Nov 2026): minutes before 09:46 may be filled from Kite candles. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveAscentService, type InstrumentPort, type StreamPort } from '../live/service.ts';
import { MemoryAscentStore } from '../live/store.ts';
import { NIFTY_INDEX_TOKEN } from '../live/adapter.ts';
import { planCatchUp, candleTicks, parseKiteCandles } from '../live/lateStart.ts';
import { at, instruments as mkInst } from './helpers.ts';
import { hhmm, RESEARCH_RULES_V1 } from '../core/rules.ts';

const D = '2026-11-25';
const weekday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };
const all = mkInst(['2026-12-01', '2026-12-08']);
/** Gap up 25,100 → 25,200, OR 25,180–25,230, upside breakout at 10:00 (same path as paper.test). */
const nifty = (t: number) => (t < at(D, '09:20:00') ? 25200 : t < at(D, '09:30:00') ? 25230 : t < at(D, '10:00:00') ? 25190 : 25260);
const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(store: MemoryAscentStore, loginAt: number | null) {
  let clock = 0;
  return {
    setClock: (t: number) => { clock = t; },
    d: {
      stream: { want() {}, onQuote: () => () => {}, status: () => ({ connected: true, subscribed: 5 }) } as StreamPort,
      fetchData: async (p: string) => {
        if (loginAt == null || clock < loginAt) throw new Error('Kite historical 403 TokenException');
        const day = p.match(/from=(\d{4}-\d{2}-\d{2})/)![1];
        const c: unknown[] = [];
        if (day === D) {
          for (let m = 555; at(D, `${hhmm(m)}:00`) + 60_000 <= clock; m++) { const v = nifty(at(D, `${hhmm(m)}:30`)); c.push([`${day}T${hhmm(m)}:00+0530`, v, v, v, v, 0]); }
        } else for (let m = 555; m <= 929; m++) c.push([`${day}T${hhmm(m)}:00+0530`, 0, 0, 0, m === 915 ? 25100 : m === 660 ? 25260 : m === 810 ? 25010 : 25120, 0]);
        return { candles: c };
      },
      instruments: { nearestExpiries: async () => ['2026-12-01', '2026-12-08'], strikes: async (e: string, lo: number, hi: number) => all.filter((i) => i.expiry === e && i.strike >= lo && i.strike <= hi) } as InstrumentPort,
      isTradingDay: weekday, mode: 'PAPER' as const, store, holder: 'A',
    },
  };
}

/** Drive the service; the live feed only delivers from `feedFrom` (the late login). */
async function run(s: LiveAscentService, setClock: (t: number) => void, from: string, to: string, feedFrom: number) {
  let vol = 100_000;
  for (let t = at(D, from); t <= at(D, to); t += 1000) {
    setClock(t);
    s.tick(t);
    await flush(); await flush();
    if (t >= feedFrom && t < at(D, '15:30:00')) s.onQuote({ token: NIFTY_INDEX_TOKEN, ltp: nifty(t), bid: null, ask: null, volume: null, receivedAt: t + 150 }, t);
    const e = s.engine;
    if (!e || t < feedFrom) continue;
    for (const tok of new Set([...e.wantedTokens(), ...s.presubscribed])) {
      const inst = all.find((i) => i.token === tok)!;
      const p = Math.max(nifty(t) - inst.strike, 0) + 40;
      vol += 65;
      s.onQuote({ token: tok, ltp: p, bid: p - 0.25, ask: p + 0.25, volume: vol, receivedAt: t + 300 }, t, { lastTradeTs: t, lastTradedQty: 65 });
    }
  }
  await s.flushWrites();
}

test('planCatchUp: candles only for unobserved minutes before 09:46; waits for a mid-minute join; never fills the signal window', () => {
  const R = RESEARCH_RULES_V1;
  const candles = new Map(Array.from({ length: 40 }, (_, i) => [555 + i, { label: 555 + i, o: 1, h: 2, l: 0.5, c: 1.5 }]));
  const live = (fromMs: number, toMs: number) => Array.from({ length: Math.floor((toMs - fromMs) / 1000) + 1 }, (_, i) => ({ exchTs: fromMs + i * 1000, recvTs: fromMs + i * 1000 + 200, price: 100 }));
  // joined 09:30:20 → at 09:30:40 the forming minute is partial: wait
  let p = planCatchUp(D, at(D, '09:30:40'), live(at(D, '09:30:20'), at(D, '09:30:40')), candles, R);
  assert.ok(!p.ok && p.retry);
  // at 09:31:10: 09:15–09:30 from candles (09:30 was partial), 09:31 live
  p = planCatchUp(D, at(D, '09:31:10'), live(at(D, '09:30:20'), at(D, '09:31:10')), candles, R);
  assert.ok(p.ok);
  assert.deepEqual([p.candleMinutes[0], p.candleMinutes.at(-1), p.candleMinutes.length], [555, 570, 16]);
  assert.deepEqual(p.liveMinutes, [571]);
  // missing Kite candle → retry
  const gap = new Map(candles); gap.delete(560);
  p = planCatchUp(D, at(D, '09:31:10'), live(at(D, '09:30:20'), at(D, '09:31:10')), gap, R);
  assert.ok(!p.ok && p.retry);
  // login 09:47:10: 09:46 not observed live → never
  p = planCatchUp(D, at(D, '09:48:05'), live(at(D, '09:47:10'), at(D, '09:48:05')), candles, R);
  assert.ok(!p.ok && !p.retry);
  assert.match(p.why, /09:46/);
  // no live feed yet → retry
  p = planCatchUp(D, at(D, '09:31:10'), [], candles, R);
  assert.ok(!p.ok && p.retry);
});

test('candleTicks reproduce the candle OHLC inside its minute; parseKiteCandles maps labels', () => {
  const ts = candleTicks(D, { label: 555, o: 10, h: 12, l: 9, c: 11 });
  assert.deepEqual(ts.map((t) => t.price), [10, 9, 12, 11]);
  assert.ok(ts.every((t) => t.exchTs >= at(D, '09:15:00') && t.exchTs < at(D, '09:16:00')));
  const m = parseKiteCandles(D, { candles: [[`${D}T09:15:00+0530`, 1, 2, 0.5, 1.5, 0]] });
  assert.equal(m.get(555)!.c, 1.5);
});

test('late login at 09:30: DATA_ERROR first, then the session is rebuilt and trades exactly like a normally observed day', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const x = deps(store, at(D, '09:30:20'));
  const s = new LiveAscentService(x.d);
  await run(s, x.setClock, '08:55:00', '09:20:00', at(D, '09:30:20'));
  assert.equal(s.engine!.state, 'DATA_ERROR');
  assert.match(s.engine!.outcome!.detail!, /Kite login expired or missing/, 'clear message instead of "15:15 bar missing"');
  await run(s, x.setClock, '09:20:01', '15:31:30', at(D, '09:30:20'));
  const e = s.engine!;
  assert.ok(e.recovery, 'marked as rebuilt');
  assert.ok(e.recovery!.candleMinutes.includes(555) && !e.recovery!.candleMinutes.some((m) => m >= 586), 'only minutes before 09:46 from candles');
  assert.equal(s.recoveryStatus.state, 'DONE');
  // Compare with a normally observed session on the same prices.
  const ref = new MemoryAscentStore(); ref.control.autoStart = true;
  const y = deps(ref, at(D, '08:00:00'));
  const n = new LiveAscentService(y.d);
  await run(n, y.setClock, '08:55:00', '15:31:30', at(D, '09:15:00'));
  assert.equal(e.reference?.price, n.engine!.reference?.price);
  assert.equal(e.or?.high, n.engine!.or?.high);
  assert.equal(e.or?.low, n.engine!.or?.low);
  assert.equal(e.signal?.bar, n.engine!.signal?.bar);
  assert.equal(e.trade?.tradingsymbol, n.engine!.trade?.tradingsymbol);
  assert.equal(store.trades.size, 1);
  assert.ok(store.sessions.get(D)!.recovery, 'marker persisted in the session snapshot (journal shows LATE START)');
  const seqs = [...store.events.keys()].map((k) => Number(k.split('|')[1]));
  assert.equal(new Set(seqs).size, seqs.length, 'audit numbering continues — nothing overwritten');
  assert.ok([...store.events.values()].some((ev) => ev.trigger === 'late_start_recovered'));
});

test('late login after 09:46: no recovery — the day stays a no-trade', async () => {
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const x = deps(store, at(D, '09:47:10'));
  const s = new LiveAscentService(x.d);
  await run(s, x.setClock, '08:55:00', '10:30:00', at(D, '09:47:10'));
  assert.equal(s.engine!.state, 'DATA_ERROR');
  assert.equal(s.engine!.recovery, null);
  assert.equal(store.trades.size, 0);
});
