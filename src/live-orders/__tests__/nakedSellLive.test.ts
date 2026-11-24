/**
 * Naked Sell LIVE end to end with a FAKE broker, a fake database and mocked Kite
 * market-data reads — no network, no real order. Covers entry gating, real-fill
 * records, the broker stop, exits, the "could not record" emergency close and
 * coexistence with PAPER.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { black76 } from '../../quant/pricing/black76.ts';
import { LiveOrderRunner, type Strategy } from '../runner.ts';
import { FakeBroker, MemoryLiveStore } from '../memory.ts';
import { defaultControl, type LiveControlState } from '../control.ts';
import { FakeSupabase } from './fakeSupabase.ts';
import { __setLiveForTests } from '../../../server/liveOrders/index.ts';
import { runTick, flattenLive } from '../../../api/naked-sell.ts';

const EXPIRY = '2026-12-01';
const istMs = (hm: string) => Date.parse(`2026-11-25T${hm}:00+05:30`);
let premiumFactor = 1;
let spotNow = 26_300;

class TestBroker extends FakeBroker {
  margin = 120_000; cash = 500_000;
  async availableCash() { return this.cash; }
  async orderMargin() { return this.margin; }
  async quote(_ex: any, sym: string) {
    const m = /NIFTY\d{8}(\d+)(CE|PE)$/.exec(sym);
    if (!m) return null;
    const mid = Math.max(0.05, pePrice(Number(m[1]), spotNow, clock) * premiumFactor);
    return { bid: Math.round(mid * 0.995 * 20) / 20, ask: Math.round(mid * 1.005 * 20) / 20, ltp: mid };
  }
}

function pePrice(strike: number, spot: number, nowMs: number) {
  const T = (Date.parse(`${EXPIRY}T15:30:00+05:30`) - nowMs) / (365 * 864e5);
  return black76({ forward: spot * Math.exp(0.065 * T), strike, timeToExpiry: T, vol: 0.14, rate: 0.065, right: 'PE' }).price;
}

let sb: FakeSupabase, broker: TestBroker, store: MemoryLiveStore, ctl: LiveControlState, clock: number;
const realFetch = globalThis.fetch;

function setup(o: { armed?: boolean; paper?: boolean; liveSettings?: Partial<Record<string, number>> } = {}) {
  sb = new FakeSupabase();
  clock = istMs('11:45');
  sb.clock = () => new Date(clock).toISOString();
  premiumFactor = 1; spotNow = 26_300;
  sb.rows('naked_sell_settings').push({ id: 1, enabled: true, paper_enabled: o.paper ?? true, shadow_enabled: false, symbols: ['NIFTY'], lots: 2, target_delta: 0.3, tp_pct: 40, sl_pct: 40, entry_start_min: 585, entry_end_min: 870, square_off_min: 925, max_entries_per_day: 5, max_daily_loss: 10000, cooldown_min: 15, allow_expiry_day: false, max_spread_pct: 5, min_volume: 100 });
  sb.rows('kite_session').push({ id: 1, access_token: 'test-token' });
  let tok = 9000;
  for (const e of [EXPIRY, '2026-12-08']) for (let k = 25_000; k <= 27_000; k += 50) for (const r of ['CE', 'PE']) {
    sb.rows('options_instruments').push({ symbol: 'NIFTY', exchange: 'NFO', expiry: e, strike: k, option_right: r, tradingsymbol: `NIFTY${e.replace(/-/g, '')}${k}${r}`, lot_size: 65, instrument_token: tok++ });
  }
  broker = new TestBroker(); store = new MemoryLiveStore();
  ctl = { ...defaultControl('NAKED_SELL'), armed: o.armed ?? true, settings: { ...defaultControl('NAKED_SELL').settings, ...(o.liveSettings ?? {}) } as Record<string, number> };
  const runner = new LiveOrderRunner('NAKED_SELL', { broker, store, now: () => clock, sleep: async (ms) => { clock += ms; } });
  __setLiveForTests({
    broker, store: Object.assign(store, { recent: async () => [], migration: true }),
    control: { load: async () => ctl, save: async (_s: Strategy, p: any) => (ctl = { ...ctl, ...p }) },
    runner: () => runner, cached: () => ctl, refresh: async () => ctl,
  } as any);
  process.env.LIVE_ORDERS = 'on';
  process.env.KITE_API_KEY = 'test-key';
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    if (url.pathname.startsWith('/instruments/historical/')) {
      const candles = Array.from({ length: 36 }, (_, i) => {
        const t = new Date(istMs('09:15') + i * 5 * 60_000 + 330 * 60_000).toISOString().slice(0, 19) + '+0530';
        const c = 26_000 + i * 10;
        return [t, c - 2, c + 5, c - 5, c, 1000];
      });
      return body({ candles });
    }
    if (url.pathname === '/quote') {
      const out: Record<string, unknown> = {};
      for (const k of url.searchParams.getAll('i')) {
        if (k === 'NSE:NIFTY 50') { out[k] = { last_price: spotNow, instrument_token: 256265 }; continue; }
        const m = /NIFTY\d{8}(\d+)(CE|PE)$/.exec(k);
        if (!m) continue;
        const mid = Math.max(0.05, pePrice(Number(m[1]), spotNow, clock) * premiumFactor);
        out[k] = { last_price: mid, volume: 50_000, oi: 1, depth: { buy: [{ price: Math.round(mid * 0.995 * 20) / 20 }], sell: [{ price: Math.round(mid * 1.005 * 20) / 20 }] } };
      }
      return body(out);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  }) as typeof fetch;
}
beforeEach(() => setup());
after(() => { globalThis.fetch = realFetch; __setLiveForTests(undefined); delete process.env.LIVE_ORDERS; });

const positions = (mode?: string) => sb.rows('naked_sell_positions').filter((p) => !mode || p.mode === mode);
const logs = () => sb.rows('naked_sell_log').map((l) => l.message as string);

test('armed: LIVE sells 1 lot with a real fill, own levels and a broker stop; PAPER unchanged at 2 lots', async () => {
  await runTick(sb as any, clock, { forceScan: true });
  const live = positions('LIVE'), paper = positions('PAPER');
  assert.equal(paper.length, 1, 'paper still trades');
  assert.equal(paper[0].lots, 2);
  assert.equal(live.length, 1, logs().join('\n'));
  const p = live[0];
  assert.equal(p.lots, 1);
  assert.equal(p.qty, 65);
  const [entry, stop] = broker.orders;
  assert.equal(entry.side, 'SELL');
  assert.equal(entry.kind, 'LIMIT');
  assert.equal(entry.tradingsymbol, p.tradingsymbol);
  assert.equal(Number(p.entry_price), entry.price, 'row records the REAL fill price');
  assert.equal(Number(p.sl_price), Math.round(entry.price * 1.4 * 100) / 100, 'levels from the real fill');
  assert.equal(stop.kind, 'SL');
  assert.equal(stop.side, 'BUY');
  assert.ok(stop.trigger! >= Number(p.sl_price) * 1.05 - 0.05, 'broker stop 5% beyond the strategy stop');
  assert.equal(p.live_position_id, entry.tag);
  assert.equal(await broker.netQty('NFO', p.tradingsymbol), -65);
});

test('TP: the real exit cancels the broker stop, buys back, and the row carries real P&L', async () => {
  await runTick(sb as any, clock, { forceScan: true });
  clock = istMs('12:10'); premiumFactor = 0.5;
  await runTick(sb as any, clock);
  const p = positions('LIVE')[0];
  assert.equal(p.status, 'CLOSED', logs().join('\n'));
  assert.equal(p.exit_reason, 'TP');
  const lp = (await store.get(p.live_position_id))!;
  assert.equal(lp.status, 'CLOSED');
  assert.equal(Number(p.net_pnl), lp.net);
  assert.equal(Number(p.exit_price), lp.exitPrice);
  assert.equal(broker.orders[1].cancelled, true, 'stop cancelled first');
  assert.equal(broker.orders[2].side, 'BUY');
  assert.equal(await broker.netQty('NFO', p.tradingsymbol), 0);
  assert.ok(positions('PAPER')[0].status === 'CLOSED', 'paper took its own TP');
});

test('broker stop fills at Zerodha → next tick records SL from the stop fill, no second order', async () => {
  await runTick(sb as any, clock, { forceScan: true });
  const stop = broker.orders[1];
  broker.fillNow(stop.orderId, stop.trigger!);
  clock = istMs('11:46');
  await runTick(sb as any, clock);
  const p = positions('LIVE')[0];
  assert.equal(p.status, 'CLOSED', logs().join('\n'));
  assert.equal(p.exit_reason, 'SL');
  assert.match(p.exit_detail, /broker stop/);
  assert.equal(broker.orders.length, 2);
  assert.equal(await broker.netQty('NFO', p.tradingsymbol), 0);
});

test('LIVE limits: entries/day across indices and the live daily loss stop new LIVE entries (paper unaffected)', async () => {
  setup({ liveSettings: { maxEntriesPerDay: 1 } });
  await runTick(sb as any, clock, { forceScan: true });
  clock = istMs('12:10'); premiumFactor = 0.5;
  await runTick(sb as any, clock);
  premiumFactor = 1; clock = istMs('12:40');
  await runTick(sb as any, clock, { forceScan: true });
  assert.equal(positions('LIVE').length, 1, 'no second LIVE entry');
  assert.equal(positions('PAPER').length, 2, 'paper re-entered after its cooldown');
  // daily loss
  setup({ liveSettings: { maxDailyLoss: 500 } });
  await runTick(sb as any, clock, { forceScan: true });
  clock = istMs('11:50'); premiumFactor = 1.6;
  await runTick(sb as any, clock);
  assert.equal(positions('LIVE')[0].exit_reason, 'SL');
  assert.ok(Number(positions('LIVE')[0].net_pnl) < -500);
  premiumFactor = 1; clock = istMs('12:30');
  await runTick(sb as any, clock, { forceScan: true });
  assert.equal(positions('LIVE').length, 1, 'daily loss limit blocks LIVE');
});

test('not armed, or server switch off → no real order at all', async () => {
  setup({ armed: false });
  await runTick(sb as any, clock, { forceScan: true });
  assert.equal(broker.orders.length, 0);
  assert.equal(positions('PAPER').length, 1);
  setup();
  process.env.LIVE_ORDERS = 'off';
  await runTick(sb as any, clock, { forceScan: true });
  assert.equal(broker.orders.length, 0);
});

test('insufficient funds for the margin → LIVE skipped, nothing sent', async () => {
  broker.cash = 50_000;
  await runTick(sb as any, clock, { forceScan: true });
  assert.equal(broker.orders.length, 0);
  assert.ok(logs().some((m) => /needs margin/.test(m)));
});

test('migration missing: the LIVE row cannot be written → the real position is closed immediately', async () => {
  sb.allowLive = false;
  await runTick(sb as any, clock, { forceScan: true });
  assert.equal(positions('LIVE').length, 0);
  assert.equal(broker.orders[0].side, 'SELL');
  assert.equal(broker.orders[1].side, 'BUY', 'emergency buy-back');
  assert.equal(await broker.netQty('NFO', broker.orders[0].tradingsymbol), 0);
  assert.ok(logs().some((m) => /emergency close/.test(m)));
});

test('LIVE squares off by 15:15 even when the setting says 15:25', async () => {
  await runTick(sb as any, clock, { forceScan: true });
  clock = istMs('15:15');
  await runTick(sb as any, clock);
  assert.equal(positions('LIVE')[0].exit_reason, 'SQUARE_OFF');
  assert.equal(positions('PAPER')[0].status, 'ACTIVE', 'paper keeps its own 15:25 square-off');
});

test('owner FLATTEN LIVE closes every LIVE position at the broker', async () => {
  await runTick(sb as any, clock, { forceScan: true });
  const msg = await flattenLive(sb as any);
  assert.match(msg, /closed/);
  assert.equal(positions('LIVE')[0].status, 'CLOSED');
  assert.equal(positions('LIVE')[0].exit_reason, 'MANUAL');
  assert.equal(positions('PAPER')[0].status, 'ACTIVE');
  assert.equal(await broker.netQty('NFO', positions('LIVE')[0].tradingsymbol), 0);
});

test('a stuck LIVE close blocks new LIVE entries until resolved', async () => {
  await runTick(sb as any, clock, { forceScan: true });
  broker.cancelFails = 99; // the broker stop cannot be cancelled → exit deferred
  clock = istMs('12:10'); premiumFactor = 0.5;
  await runTick(sb as any, clock);
  const lp = (await store.get(positions('LIVE')[0].live_position_id))!;
  assert.equal(lp.status, 'CLOSE_FAILED');
  assert.equal(positions('LIVE')[0].status, 'ACTIVE', 'row stays open until the broker confirms');
  assert.equal(broker.orders.length, 2, 'no exit while the stop is still working');
  broker.cancelFails = 0;
  clock = istMs('12:11');
  await runTick(sb as any, clock);
  assert.equal(positions('LIVE')[0].status, 'CLOSED');
  assert.equal(await broker.netQty('NFO', positions('LIVE')[0].tradingsymbol), 0);
});
