import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEdgeTick, closePositionManually, type EdgeDeps } from '../engine.ts';
import { MemoryStore, FakeMarket, FakeBroker, makeSignal, defaultSettings, IST, SIGNAL_DATE, EXPIRY, sym } from './fakes.ts';

function setup(settingsOver = {}, signal = makeSignal()) {
  const store = new MemoryStore(defaultSettings(settingsOver), signal);
  const market = new FakeMarket();
  const broker = new FakeBroker(market);
  const deps: EdgeDeps = { store, market, broker: async () => broker.asBroker(), sleep: async () => {} };
  return { store, market, broker, deps };
}
const ENTRY = IST(SIGNAL_DATE, 10, 14);

test('SHADOW: opens the worked-example bear call spread on the signal day (Variation C flips D0=+1 to bearish)', async () => {
  const { store, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  const p = store.positions[0] as any;
  assert.equal(p.mode, 'SHADOW');
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.structure, 'Bear Call Spread');
  assert.equal(p.expiry, EXPIRY);
  assert.equal(p.quantity, 150); // ₹3L / ₹1.25L = 2 units × lot 75
  assert.deepEqual(p.legs.map((l: any) => [l.side, l.strike, l.right, l.entryFill]), [['BUY', 24_350, 'CE', 36.95], ['SELL', 24_150, 'CE', 118.45]]);
  assert.equal(p.creditPoints.toFixed(2), '81.50');
  assert.equal(Math.round(p.maxLoss), 17_775);
  assert.equal(p.f0, 24_211.8);
});

test('SHADOW: one position per week — a second tick never duplicates it', async () => {
  const { store, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  await runEdgeTick(deps, ENTRY + 60_000);
  assert.equal(store.positions.length, 1);
});

test('no entry without a signal, on a later day, or after the entry grace window', async () => {
  for (const [signal, now] of [[null, ENTRY], [makeSignal(), IST('2026-10-15', 10, 14)], [makeSignal(), IST(SIGNAL_DATE, 11, 0)]] as const) {
    const { store, deps } = setup({}, signal as any);
    await runEdgeTick(deps, now);
    assert.equal(store.positions.length, 0);
  }
});

test('SHADOW: an unmarketable touch waits (no position, retried next minute) instead of filling at LTP', async () => {
  const { store, market, deps } = setup();
  market.setQuote(sym(24_350, 'CE'), 36.8, 36.75, 45);
  await runEdgeTick(deps, ENTRY);
  assert.equal(store.positions.length, 0);
  market.setQuote(sym(24_350, 'CE'), 36.8, 36.75, 36.95);
  await runEdgeTick(deps, ENTRY + 60_000);
  assert.equal(store.positions.length, 1);
});

test('an allocation below one unit skips the week once (recorded), without spamming every minute', async () => {
  const { store, deps } = setup({ shadowCapital: 100_000 });
  await runEdgeTick(deps, ENTRY);
  await runEdgeTick(deps, ENTRY + 60_000);
  assert.equal(store.positions.length, 1);
  assert.equal(store.positions[0].status, 'FAILED');
  assert.equal(store.events.filter((e) => e.kind === 'ENTRY_SKIPPED').length, 1);
});

test('AUTO is off by default: no broker call at all', async () => {
  const { broker, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  assert.equal(broker.calls.length, 0);
});

test('AUTO: protective BUY is placed and FILLED before the ATM SELL is placed; limits use the spec pricing', async () => {
  const { store, broker, deps } = setup({ shadowEnabled: false, autoEnabled: true, autoCapital: 300_000 });
  broker.fillPrice.set(sym(24_350, 'CE'), 36.95);
  broker.fillPrice.set(sym(24_150, 'CE'), 118.45);
  await runEdgeTick(deps, ENTRY);
  const seq = broker.calls.map((c) => `${c.op}:${c.symbol}`);
  assert.deepEqual(seq, [`place:${sym(24_350, 'CE')}`, `await:${sym(24_350, 'CE')}`, `place:${sym(24_150, 'CE')}`, `await:${sym(24_150, 'CE')}`]);
  assert.equal(broker.calls[0].limit!.toFixed(2), '39.80');
  assert.equal(broker.calls[2].limit!.toFixed(2), '109.10');
  const p = store.positions[0] as any;
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.creditPoints.toFixed(2), '81.50');
});

test('AUTO: a rejected ATM SELL fails the entry, unwinds the filled wing, and abandons the week', async () => {
  const { store, broker, deps } = setup({ shadowEnabled: false, autoEnabled: true, autoCapital: 300_000 });
  broker.reject.add(sym(24_150, 'CE'));
  await runEdgeTick(deps, ENTRY);
  assert.equal(store.positions[0].status, 'FAILED');
  assert.ok(broker.calls.some((c) => c.op === 'close' && c.symbol === sym(24_350, 'CE')), 'the filled protective leg is unwound');
  await runEdgeTick(deps, ENTRY + 60_000);
  assert.equal(broker.calls.filter((c) => c.op === 'place').length, 2, 'no second attempt in the same week');
});

test('AUTO: unknown broker positions fail closed (no orders); an existing broker position in a leg skips the week', async () => {
  const a = setup({ shadowEnabled: false, autoEnabled: true, autoCapital: 300_000 });
  a.broker.holds = null;
  await runEdgeTick(a.deps, ENTRY);
  assert.equal(a.broker.calls.length, 0);
  assert.equal(a.store.positions.length, 0);
  const b = setup({ shadowEnabled: false, autoEnabled: true, autoCapital: 300_000 });
  b.broker.holds = true;
  await runEdgeTick(b.deps, ENTRY);
  assert.equal(b.broker.calls.length, 0);
  assert.equal(b.store.positions[0].status, 'FAILED');
});

test('AUTO: insufficient real funds skip the week before any order', async () => {
  const { store, broker, deps } = setup({ shadowEnabled: false, autoEnabled: true, autoCapital: 300_000 });
  broker.funds = 10_000;
  await runEdgeTick(deps, ENTRY);
  assert.equal(broker.calls.length, 0);
  assert.equal(store.positions[0].status, 'FAILED');
});

test('exit on monitor target: short closed first, then the wing; realized P&L matches the worked example', async () => {
  const { store, market, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  market.futureLtp = 23_910.5;
  market.setQuote(sym(24_150, 'CE'), 3.4, 3.4, 3.5);
  market.setQuote(sym(24_350, 'CE'), 0.4, 0.4, 0.45);
  await runEdgeTick(deps, IST('2026-10-16', 13, 41));
  const p = store.positions[0] as any;
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exitReason, 'TARGET_HIT');
  assert.equal(Math.round(p.realizedPnl), 11_760);
});

test('a short that cannot be bought back keeps the wing open (never sold first)', async () => {
  const { store, market, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  market.futureLtp = 23_900;
  market.setQuote(sym(24_150, 'CE'), 3.4, 3.4, 20); // ask far above the limit
  market.setQuote(sym(24_350, 'CE'), 0.4, 0.4, 0.45);
  await runEdgeTick(deps, IST('2026-10-16', 13, 41));
  const p = store.positions[0] as any;
  assert.equal(p.status, 'EXITING');
  assert.equal(p.legs.find((l: any) => l.side === 'SELL').exitFill, null);
  assert.equal(p.legs.find((l: any) => l.side === 'BUY').exitFill, null, 'the wing is not sold while the short is open');
});

test('AUTO exit: short-first close; repeated close failures stop at CLOSE_FAILED with the wing left open', async () => {
  const { store, broker, market, deps } = setup({ shadowEnabled: false, autoEnabled: true, autoCapital: 300_000 });
  await runEdgeTick(deps, ENTRY);
  broker.reject.add(sym(24_150, 'CE'));
  market.futureLtp = 23_900;
  for (let i = 0; i < 6; i++) await runEdgeTick(deps, IST('2026-10-16', 13, 41 + i));
  const p = store.positions[0] as any;
  assert.equal(p.status, 'CLOSE_FAILED');
  assert.equal(broker.calls.filter((c) => c.op === 'close' && c.symbol === sym(24_350, 'CE')).length, 0, 'wing never closed while the short is open');
});

test('scheduled exit at 15:10 on expiry day closes the position', async () => {
  const { store, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  await runEdgeTick(deps, IST(EXPIRY, 15, 10));
  const p = store.positions[0] as any;
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exitReason, 'SCHEDULED_EXIT');
});

test('exit is claimed once: a concurrent second executor cannot run it again', async () => {
  const { store, market, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  market.futureLtp = 23_900;
  await Promise.all([runEdgeTick(deps, IST('2026-10-16', 13, 41)), runEdgeTick(deps, IST('2026-10-16', 13, 41))]);
  assert.equal(store.events.filter((e) => e.kind === 'EXIT_TRIGGERED').length, 1);
  assert.equal(store.events.filter((e) => e.kind === 'POSITION_CLOSED').length, 1);
});

test('manual close from the dashboard closes an open SHADOW position', async () => {
  const { store, deps } = setup();
  await runEdgeTick(deps, ENTRY);
  const r = await closePositionManually(deps, store.positions[0].id, IST('2026-10-15', 11, 0));
  assert.equal(r.ok, true);
  assert.equal(store.positions[0].status, 'CLOSED');
  assert.equal(store.positions[0].exitReason, 'MANUAL');
});

test('the kill switch blocks new entries', async () => {
  const { store, deps } = setup({ killSwitch: true });
  await runEdgeTick(deps, ENTRY);
  assert.equal(store.positions.length, 0);
});
