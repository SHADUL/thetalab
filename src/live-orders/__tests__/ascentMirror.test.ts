import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES } from '../../nifty-ascent/sim/fixtures.ts';
import { Replay } from '../../nifty-ascent/sim/market.ts';
import { DEFAULT_EXECUTION } from '../../nifty-ascent/core/rules.ts';
import { buyFees, sellFees } from '../../nifty-ascent/core/costs.ts';
import { LiveOrderRunner } from '../runner.ts';
import { FakeBroker, MemoryLiveStore } from '../memory.ts';
import { AscentLiveMirror, budgetCap } from '../ascentMirror.ts';
import { defaultControl } from '../control.ts';

/** Run a fixture second by second with the mirror observing (as the live service does). */
async function run(id: string, o: { armed?: boolean; enabled?: boolean; leaseOk?: boolean; armAt?: number; store?: MemoryLiveStore; broker?: FakeBroker } = {}) {
  const f = FIXTURES.find((x) => x.id === id)!;
  const r = new Replay(f);
  const broker = o.broker ?? new FakeBroker(), store = o.store ?? new MemoryLiveStore();
  let now = r.startMs;
  const runner = new LiveOrderRunner('NIFTY_ASCENT', { broker, store, now: () => now, sleep: async () => {} });
  const ctl = { ...defaultControl('NIFTY_ASCENT'), armed: o.armed ?? true };
  const mirror = new AscentLiveMirror({ runner, store, liveEnabled: () => o.enabled ?? true, control: () => (o.armAt == null || now >= o.armAt ? ctl : { ...ctl, armed: false }) });
  while (!r.done) {
    r.stepTo(r.t);
    now = r.t - 1000;
    await mirror.step(r.engine, o.leaseOk ?? true, now);
  }
  return { e: r.engine, broker, store, mirror };
}

test('budgetCap keeps premium + fees inside both limits', () => {
  const p = budgetCap(65, 15_000, 15_000);
  assert.ok(p * 65 + buyFees(p, 65) <= 15_000);
  assert.ok(p * 65 + buyFees(p, 65) + sellFees(0, 65) <= 15_000);
  assert.ok((p + 0.05) * 65 + buyFees(p + 0.05, 65) + sellFees(0, 65) > 15_000);
});

for (const id of ['gg-pe-fixed', 'gg-ce-trail', 'williams-pe-time']) {
  test(`mirror ${id}: one real BUY after the paper fill, broker stop, real exit when paper exits`, async () => {
    const { e, broker, store } = await run(id);
    assert.ok(e.trade, 'paper traded');
    const rows = [...store.rows.values()];
    assert.equal(rows.length, 1, 'one live position for the day');
    const p = rows[0];
    assert.equal(p.status, 'CLOSED');
    assert.equal(p.tradingsymbol, e.trade!.tradingsymbol);
    assert.equal(p.qty, e.trade!.qty);
    const [entry, stop, ...exits] = broker.orders;
    assert.equal(entry.side, 'BUY');
    assert.equal(entry.kind, 'LIMIT');
    assert.ok(entry.price * entry.qty + buyFees(entry.price, entry.qty) <= DEFAULT_EXECUTION.maxPremiumOutlay, 'real limit inside the same budget');
    assert.equal(stop.kind, 'SL');
    assert.equal(stop.side, 'SELL');
    assert.ok(stop.trigger! < p.entryPrice! * e.rules.fixedStopFactor, 'crash guard sits beyond the strategy stop');
    assert.equal(stop.cancelled, true, 'stop cancelled before the exit');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].side, 'SELL');
    assert.equal(await broker.netQty('NFO', p.tradingsymbol), 0, 'flat at the broker');
    assert.equal(p.ref.paperDate, e.date);
    // the real exit is sent within seconds of the paper exit starting
    assert.ok(p.exitAt! - e.exitOrder!.createdAt <= 2_000);
  });
}

test('mirror: not armed, server switch off, or no lease → nothing is ever sent', async () => {
  for (const o of [{ armed: false }, { enabled: false }, { leaseOk: false }]) {
    const { e, broker, store } = await run('gg-pe-fixed', o);
    assert.ok(e.trade);
    assert.equal(broker.orders.length, 0, JSON.stringify(o));
    assert.equal(store.rows.size, 0);
  }
});

test('mirror: armed only AFTER the paper fill → live does not chase it later', async () => {
  const first = await run('gg-pe-fixed');
  const fillAt = [...first.store.rows.values()][0].createdAt;
  const { broker, mirror } = await run('gg-pe-fixed', { armAt: fillAt + 120_000 });
  assert.equal(broker.orders.length, 0);
  assert.match(mirror.lastSkip ?? '', /not armed|not chased/);
});

test('mirror: no paper trade (budget reject / no signal) → no live order', async () => {
  for (const id of ['budget-reject', 'zero-gap', 'no-break-filled']) {
    const { broker } = await run(id);
    assert.equal(broker.orders.length, 0, id);
  }
});

test('mirror: rejected live entry does not retry and leaves paper untouched', async () => {
  const broker = new FakeBroker();
  broker.next.push({ fill: 'reject' });
  const { e, store } = await run('gg-pe-fixed', { broker });
  assert.ok(e.trade, 'paper still traded');
  assert.equal(broker.orders.length, 1);
  assert.equal([...store.rows.values()][0].status, 'ENTRY_FAILED');
});

test('mirror: broker stop fills (server was "down") → recorded as BROKER_STOP, no second exit', async () => {
  const f = FIXTURES.find((x) => x.id === 'gg-pe-fixed')!;
  const r = new Replay(f);
  const broker = new FakeBroker(), store = new MemoryLiveStore();
  let now = r.startMs;
  const runner = new LiveOrderRunner('NIFTY_ASCENT', { broker, store, now: () => now, sleep: async () => {} });
  const mirror = new AscentLiveMirror({ runner, store, liveEnabled: () => true, control: () => ({ ...defaultControl('NIFTY_ASCENT'), armed: true }) });
  let fired = false;
  while (!r.done) {
    r.stepTo(r.t); now = r.t - 1000;
    const pos = mirror.pos;
    if (!fired && pos?.status === 'OPEN' && pos.stop?.orderId) { broker.fillNow(pos.stop.orderId, pos.stop.trigger!); fired = true; now += 11_000; }
    await mirror.step(r.engine, true, now);
  }
  const p = [...store.rows.values()][0];
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.closedBy, 'BROKER_STOP');
  assert.equal(broker.orders.length, 2, 'entry + stop only');
});

test('mirror: restart mid-position resumes the same live record (no second entry)', async () => {
  const f = FIXTURES.find((x) => x.id === 'gg-ce-trail')!;
  const r = new Replay(f);
  const broker = new FakeBroker(), store = new MemoryLiveStore();
  let now = r.startMs;
  const runner = new LiveOrderRunner('NIFTY_ASCENT', { broker, store, now: () => now, sleep: async () => {} });
  const ctl = () => ({ ...defaultControl('NIFTY_ASCENT'), armed: true });
  let mirror = new AscentLiveMirror({ runner, store, liveEnabled: () => true, control: ctl });
  let restarted = false;
  while (!r.done) {
    r.stepTo(r.t); now = r.t - 1000;
    if (!restarted && mirror.pos?.status === 'OPEN') { mirror = new AscentLiveMirror({ runner, store, liveEnabled: () => true, control: ctl }); restarted = true; }
    await mirror.step(r.engine, true, now);
  }
  assert.ok(restarted);
  assert.equal(store.rows.size, 1);
  assert.equal(broker.orders.filter((o) => o.side === 'BUY').length, 1);
  assert.equal([...store.rows.values()][0].status, 'CLOSED');
});

test('mirror: owner FLATTEN LIVE closes the real position while paper keeps running', async () => {
  const f = FIXTURES.find((x) => x.id === 'gg-ce-trail')!;
  const r = new Replay(f);
  const broker = new FakeBroker(), store = new MemoryLiveStore();
  let now = r.startMs;
  const runner = new LiveOrderRunner('NIFTY_ASCENT', { broker, store, now: () => now, sleep: async () => {} });
  const mirror = new AscentLiveMirror({ runner, store, liveEnabled: () => true, control: () => ({ ...defaultControl('NIFTY_ASCENT'), armed: true }), quote: async () => ({ bid: 100, ask: 101 }) });
  let flattened = false;
  while (!r.done) {
    r.stepTo(r.t); now = r.t - 1000;
    await mirror.step(r.engine, true, now);
    if (!flattened && mirror.pos?.status === 'OPEN') { await mirror.flatten(r.engine); flattened = true; assert.ok(r.engine.position, 'paper still open'); }
  }
  const p = [...store.rows.values()][0];
  assert.equal(p.status, 'CLOSED');
  assert.match(p.exitReason!, /FLATTEN/);
  assert.ok(r.engine.trade, 'paper completed on its own');
  assert.equal(broker.orders.filter((o) => o.side === 'BUY').length, 1, 'no re-entry after flatten');
});
