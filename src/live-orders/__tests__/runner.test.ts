import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveOrderRunner, ceilTick, floorTick, marketable, expectedNet, roundTripCharges, newTag, type LivePosition } from '../runner.ts';
import { FakeBroker, MemoryLiveStore } from '../memory.ts';
import { validateLiveSettings, defaultControl, MemoryLiveControl } from '../control.ts';
import { KiteBroker } from '../../../server/liveOrders/kiteBroker.ts';

function rig(opts = {}) {
  let t = Date.parse('2026-11-25T05:00:00Z');
  const broker = new FakeBroker(), store = new MemoryLiveStore();
  const runner = new LiveOrderRunner('NAKED_SELL', { broker, store, now: () => t, sleep: async (ms) => { t += ms; } }, opts);
  return { broker, store, runner, advance: (ms: number) => { t += ms; } };
}
const SYM = 'NIFTY25D0226000PE';
const base = { date: '2026-11-25', exchange: 'NFO' as const, tradingsymbol: SYM, lotSize: 65 };

test('ticks and marketable prices', () => {
  assert.equal(ceilTick(100.01), 100.05);
  assert.equal(floorTick(100.04), 100);
  assert.equal(marketable('BUY', 100, 2), 102);
  assert.equal(marketable('SELL', 100, 2), 98);
  assert.match(newTag('NAKED_SELL', '2026-11-25'), /^NS261125[A-Z2-9]{6}$/);
  assert.ok(newTag('NIFTY_ASCENT', '2026-11-25').length <= 18, 'Kite tags are at most 20 chars (stop/exit add 1–3)');
});

test('open: records the position BEFORE sending, then fills', async () => {
  const { broker, store, runner } = rig();
  const seen: string[] = [];
  const save = store.save.bind(store);
  store.save = async (p) => { seen.push(`${p.status}:${broker.orders.length}`); return save(p); };
  const p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  assert.equal(p.status, 'OPEN');
  assert.equal(p.qty, 65);
  assert.equal(p.entryPrice, 98); // marketable sell limit = bid − 2%, fake fills at the limit
  assert.equal(seen[0], 'OPENING:0', 'saved with no order sent yet');
  assert.equal(broker.orders[0].side, 'SELL');
  assert.equal(broker.orders[0].tag, p.id);
  assert.ok(store.audits.some((a) => a.action === 'place LIMIT SELL' && a.ok));
});

test('open: refuses non-lot quantities, the lot hard cap, and a budget cap below the ask — nothing sent', async () => {
  const { broker, runner } = rig({ maxLots: 2 });
  assert.equal((await runner.open({ ...base, side: 'BUY', qty: 60, quote: { bid: 1, ask: 2 } })).status, 'ENTRY_FAILED');
  assert.equal((await runner.open({ ...base, side: 'BUY', qty: 195, quote: { bid: 1, ask: 2 } })).status, 'ENTRY_FAILED');
  const p = await runner.open({ ...base, side: 'BUY', qty: 65, quote: { bid: 200, ask: 201 }, maxPrice: 190 });
  assert.equal(p.status, 'ENTRY_FAILED');
  assert.match(p.log.at(-1)!.msg, /budget/);
  assert.equal(broker.orders.length, 0);
});

test('open: BUY limit is capped by the budget when the cap is between ask and ask+2%', async () => {
  const { broker, runner } = rig();
  const p = await runner.open({ ...base, side: 'BUY', qty: 65, quote: { bid: 199, ask: 200 }, maxPrice: 202.37 });
  assert.equal(broker.orders[0].price, 202.35);
  assert.equal(p.status, 'OPEN');
});

test('open: unfilled entry is cancelled after the timeout; a partial fill keeps the filled quantity', async () => {
  const a = rig();
  a.broker.next.push({ fill: 'none' });
  const p = await a.runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  assert.equal(p.status, 'ENTRY_FAILED');
  assert.equal(a.broker.orders[0].cancelled, true);
  const b = rig();
  b.broker.next.push({ fill: 'partial', partialQty: 65 });
  const q = await b.runner.open({ ...base, side: 'SELL', qty: 130, quote: { bid: 100, ask: 101 } });
  assert.equal(q.status, 'OPEN');
  assert.equal(q.qty, 65);
  assert.equal(b.broker.orders[0].cancelled, true, 'the unfilled remainder is cancelled');
});

test('open: a rejected order is ENTRY_FAILED; a timeout on send is resolved by looking up the tag', async () => {
  const a = rig();
  a.broker.next.push({ fill: 'reject' });
  assert.equal((await a.runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } })).status, 'ENTRY_FAILED');
  const b = rig();
  b.broker.next.push({ fill: 'full', throwOnPlace: true, acceptedDespiteThrow: true });
  const p = await b.runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  assert.equal(p.status, 'OPEN', 'the order reached the exchange although the call timed out');
  assert.equal(b.broker.orders.length, 1, 'never sent twice');
  const c = rig();
  c.broker.next.push({ fill: 'full', throwOnPlace: true });
  assert.equal((await c.runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } })).status, 'ENTRY_FAILED');
});

test('open: if the record cannot be written first, no order is sent', async () => {
  const { broker, store, runner } = rig();
  store.fail = true;
  const p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  assert.equal(p.status, 'ENTRY_FAILED');
  assert.equal(broker.orders.length, 0);
});

test('protect: broker stop-loss order on the tick, opposite side, limit beyond trigger', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  p = await runner.protect(p, 98 * 1.4 * 1.05);
  const sl = broker.orders[1];
  assert.equal(sl.kind, 'SL');
  assert.equal(sl.side, 'BUY');
  assert.equal(sl.trigger, 144.1); // 144.06 rounded UP to the tick for a BUY stop
  assert.equal(sl.price, 158.55);
  assert.equal(p.stop!.status, 'TRIGGER_PENDING');
  // BUY entry → SELL stop below
  const b = rig();
  let q = await b.runner.open({ ...base, side: 'BUY', qty: 65, quote: { bid: 199, ask: 200 } });
  q = await b.runner.protect(q, 204 * 0.7 * 0.95);
  assert.equal(b.broker.orders[1].side, 'SELL');
  assert.equal(b.broker.orders[1].trigger, 135.65);
  assert.equal(b.broker.orders[1].price, 122.05);
});

test('close: cancels the broker stop FIRST, then exits; P&L from real fills', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  p = await runner.protect(p, 140);
  broker.quotes.set(`NFO:${SYM}`, { bid: 59, ask: 60 });
  p = await runner.close(p, 'TP', () => ({ bid: 59, ask: 60 }));
  assert.equal(p.status, 'CLOSED');
  assert.equal(broker.orders[1].cancelled, true, 'stop cancelled');
  const exit = broker.orders[2];
  assert.equal(exit.side, 'BUY');
  assert.equal(exit.price, 61.8);
  assert.equal(p.exitPrice, 61.8);
  assert.equal(p.gross, Math.round((98 - 61.8) * 65 * 100) / 100);
  assert.equal(p.charges, roundTripCharges('SELL', 98, 61.8, 65, 'NFO'));
  assert.equal(p.net, Math.round((p.gross! - p.charges!) * 100) / 100);
  assert.equal(p.closedBy, 'STRATEGY');
  assert.equal(await broker.netQty('NFO', SYM), 0, 'flat at the broker');
});

test('close: a stop that already filled at the broker is never closed again (no double exit)', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  p = await runner.protect(p, 140);
  broker.fillNow(p.stop!.orderId!, 141); // stop fires a moment before our own exit
  p = await runner.close(p, 'SL', () => ({ bid: 140, ask: 142 }));
  assert.equal(p.status, 'CLOSED');
  assert.equal(broker.orders.length, 2, 'no exit order sent');
  assert.equal(p.closedBy, 'BROKER_STOP');
  assert.equal(p.exitPrice, 141);
  assert.equal(await broker.netQty('NFO', SYM), 0);
});

test('close: a partly filled stop leaves only the remainder to exit', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'SELL', qty: 130, quote: { bid: 100, ask: 101 } });
  p = await runner.protect(p, 140);
  broker.fillNow(p.stop!.orderId!, 141, 65);
  p = await runner.close(p, 'SL', () => ({ bid: 140, ask: 142 }));
  assert.equal(p.status, 'CLOSED');
  assert.equal(broker.orders[2].qty, 65);
  assert.equal(await broker.netQty('NFO', SYM), 0);
});

test('close: if the broker stop cannot be confirmed cancelled, NO exit is sent (CLOSE_FAILED, retried later)', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  p = await runner.protect(p, 140);
  broker.cancelFails = 3;
  p = await runner.close(p, 'TP', () => ({ bid: 59, ask: 60 }));
  assert.equal(p.status, 'CLOSE_FAILED');
  assert.equal(broker.orders.length, 2);
  p = await runner.close(p, 'TP', () => ({ bid: 59, ask: 60 }));
  assert.equal(p.status, 'CLOSED');
  assert.equal(await broker.netQty('NFO', SYM), 0);
});

test('close: an unfilled exit is cancelled and retried with a wider limit; all attempts failing → CLOSE_FAILED', async () => {
  const a = rig();
  let p = await a.runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  a.broker.next.push({ fill: 'none' });
  p = await a.runner.close(p, 'SQUARE_OFF', () => ({ bid: 59, ask: 60 }));
  assert.equal(p.status, 'CLOSED');
  assert.equal(a.broker.orders[1].price, 61.8);
  assert.equal(a.broker.orders[1].cancelled, true);
  assert.equal(a.broker.orders[2].price, 63.6);
  const b = rig({ exitAttempts: 2 });
  let q = await b.runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  b.broker.next.push({ fill: 'none' }, { fill: 'none' });
  q = await b.runner.close(q, 'SQUARE_OFF', () => ({ bid: 59, ask: 60 }));
  assert.equal(q.status, 'CLOSE_FAILED');
  assert.equal(await b.broker.netQty('NFO', SYM), -65, 'still short — reported, never assumed closed');
  q = await b.runner.close(q, 'SQUARE_OFF', () => ({ bid: 59, ask: 60 }));
  assert.equal(q.status, 'CLOSED');
});

test('close: no stream quote → REST quote fallback', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  broker.quotes.set(`NFO:${SYM}`, { bid: 70, ask: 71 });
  p = await runner.close(p, 'MANUAL', () => null);
  assert.equal(p.status, 'CLOSED');
  assert.equal(broker.orders[1].price, 73.15);
});

test('syncStop: detects the broker stop filling while we were not watching', async () => {
  const { broker, runner } = rig();
  let p = await runner.open({ ...base, side: 'BUY', qty: 65, quote: { bid: 199, ask: 200 } });
  p = await runner.protect(p, 130);
  p = await runner.syncStop(p);
  assert.equal(p.status, 'OPEN');
  broker.fillNow(p.stop!.orderId!, 129.5);
  p = await runner.syncStop(p);
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exitReason, 'BROKER_STOP');
  assert.equal(p.gross, Math.round((129.5 - 204) * 65 * 100) / 100);
});

test('recover: an OPENING record left by a crash is resolved from the broker by tag', async () => {
  const { broker, store, runner } = rig();
  // Simulate: record saved, order sent, process died before the id was stored.
  const tag = 'NS261125ABCDEF';
  await broker.place({ exchange: 'NFO', tradingsymbol: SYM, side: 'SELL', qty: 65, kind: 'LIMIT', price: 98, tag, purpose: 'ENTRY' });
  const p: LivePosition = {
    id: tag, strategy: 'NAKED_SELL', date: '2026-11-25', exchange: 'NFO', tradingsymbol: SYM, lotSize: 65, entrySide: 'SELL', requestedQty: 65, qty: 0, status: 'OPENING',
    entry: { orderId: null, tag, side: 'SELL', qty: 65, kind: 'LIMIT', price: 98, trigger: null, status: 'NOT_SENT', filledQty: 0, avgPrice: null, at: 0 },
    entryPrice: null, entryAt: null, stop: null, exits: [], exitPrice: null, exitAt: null, exitReason: null, closedBy: null, gross: null, charges: null, net: null, ref: {}, log: [], createdAt: 0, updatedAt: 0,
  };
  await store.save(p);
  const r = await runner.recover(p);
  assert.equal(r.status, 'OPEN');
  assert.equal(r.entryPrice, 98);
  assert.equal(broker.orders.length, 1, 'never re-sent');
});

test('expectedNet: open records give the expected broker net per contract', async () => {
  const { runner } = rig();
  const a = await runner.open({ ...base, side: 'SELL', qty: 65, quote: { bid: 100, ask: 101 } });
  const b = await runner.open({ ...base, tradingsymbol: 'X', side: 'BUY', qty: 130, quote: { bid: 1, ask: 2 } });
  const m = expectedNet([a, b]);
  assert.equal(m.get(`NFO:${SYM}`)!.qty, -65);
  assert.equal(m.get('NFO:X')!.qty, 130);
});

test('live settings: validated against hard bounds; disarmed by default', async () => {
  const d = defaultControl('NAKED_SELL');
  assert.equal(d.armed, false);
  assert.deepEqual(d.settings, { lots: 1, maxEntriesPerDay: 2, maxDailyLoss: 5000, stopBufferPct: 5 });
  assert.equal(validateLiveSettings('NAKED_SELL', { lots: 6 }, d.settings).ok, false);
  assert.equal(validateLiveSettings('NAKED_SELL', { lots: 1.5 }, d.settings).ok, false);
  assert.equal(validateLiveSettings('NAKED_SELL', { foo: 1 }, d.settings).ok, false);
  const v = validateLiveSettings('NAKED_SELL', { maxDailyLoss: 3000 }, d.settings);
  assert.ok(v.ok && v.value.maxDailyLoss === 3000 && v.value.lots === 1);
  assert.deepEqual(defaultControl('NIFTY_ASCENT').settings, { stopBufferPct: 5 });
  const c = new MemoryLiveControl();
  assert.equal((await c.load('NIFTY_ASCENT')).armed, false);
});

test('KiteBroker refuses any ENTRY unless the server runs with LIVE_ORDERS=on', async () => {
  const prev = process.env.LIVE_ORDERS;
  delete process.env.LIVE_ORDERS;
  let fetched = false;
  const kb = new KiteBroker('k', async () => { fetched = true; return 't'; });
  await assert.rejects(kb.place({ exchange: 'NFO', tradingsymbol: SYM, side: 'SELL', qty: 65, kind: 'LIMIT', price: 98, tag: 'NS1', purpose: 'ENTRY' }), /LIVE_ORDERS is not on/);
  process.env.LIVE_ORDERS = 'yes';
  await assert.rejects(kb.place({ exchange: 'NFO', tradingsymbol: SYM, side: 'SELL', qty: 65, kind: 'LIMIT', price: 98, tag: 'NS1', purpose: 'ENTRY' }), /LIVE_ORDERS is not on/);
  assert.equal(fetched, false, 'no credentials read, no network call');
  // Closing an EXISTING real position is never blocked by the switch (gate passes; here it stops at "no session").
  const kb2 = new KiteBroker('k', async () => null);
  await assert.rejects(kb2.place({ exchange: 'NFO', tradingsymbol: SYM, side: 'BUY', qty: 65, kind: 'LIMIT', price: 60, tag: 'NS1X1', purpose: 'EXIT' }), /no Kite session/);
  if (prev === undefined) delete process.env.LIVE_ORDERS; else process.env.LIVE_ORDERS = prev;
});

test('rejectionHalt: 2 rejections in a row since the arm halt; a fill or an unfilled cancel resets; re-arm clears', async () => {
  const { rejectionHalt } = await import('../control.ts');
  const mk = (t: number, status: string, entryStatus: string, message?: string) => ({ createdAt: t, status, entry: { status: entryStatus, message } }) as unknown as LivePosition;
  const msg = 'Kite 400 InputException: Your account has an ageing debit balance of 8349.47. You can use collateral margin only after you clear this debit balance. [Read more.](https://support.zerodha.com/category/console/portfolio/pledging';
  assert.equal(rejectionHalt([mk(1, 'ENTRY_FAILED', 'REJECTED', msg)], null), null, 'one rejection is not enough');
  const two = [mk(1, 'ENTRY_FAILED', 'REJECTED', msg), mk(2, 'ENTRY_FAILED', 'REJECTED', msg)];
  const why = rejectionHalt(two, null)!;
  assert.match(why, /rejected the last 2 entries \(Your account has an ageing debit balance of 8349\.47\. .*debit balance\.\) — live entries stopped/);
  assert.doesNotMatch(why, /Read more|https/);
  assert.equal(rejectionHalt([...two, mk(3, 'CLOSED', 'COMPLETE')], null), null, 'a later fill resets');
  assert.equal(rejectionHalt([mk(1, 'ENTRY_FAILED', 'REJECTED'), mk(2, 'ENTRY_FAILED', 'CANCELLED'), mk(3, 'ENTRY_FAILED', 'REJECTED')], null), null, 'unfilled-and-cancelled breaks the run');
  assert.equal(rejectionHalt(two, new Date(2).toISOString()), null, 'only entries since the last arm count');
});
