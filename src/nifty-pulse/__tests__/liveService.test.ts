import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LivePulseService, NIFTY_INDEX_TOKEN, istDate, type StreamPort, type InstrumentPort, type StorePort } from '../live/service.ts';
import { buildLiveChain, chainFromWire, chainToWire, type InstrumentRow, type StreamQuote } from '../live/liveChain.ts';
import { PRESETS } from '../core/config.ts';

const OPEN = Date.parse('2026-11-13T10:00:00+05:30');
const EXT = PRESETS.find((p) => p.id === 'strategy-a-extended-risk')!;

function rowsFor(expiry: string): InstrumentRow[] {
  const out: InstrumentRow[] = [];
  let tok = 1000;
  for (let k = 24000; k <= 26000; k += 50) for (const right of ['CE', 'PE'] as const) out.push({ token: tok++, tradingsymbol: `NIFTY${k}${right}`, strike: k, right, expiry, lotSize: 65 });
  return out;
}

class FakeStream implements StreamPort {
  now = OPEN;
  spot = 25000;
  wanted = new Set<number>();
  listeners: Array<(q: StreamQuote, exchTs: number | null) => void> = [];
  rows = rowsFor('2026-11-17');
  quoteAgeMs = 100;
  healthy = true;
  want(tokens: number[]) { for (const t of tokens) this.wanted.add(t); }
  onQuote(fn: (q: StreamQuote, exchTs: number | null) => void) { this.listeners.push(fn); return () => {}; }
  isHealthy() { return this.healthy; }
  status() { return { connected: this.healthy, subscribed: this.wanted.size, wanted: this.wanted.size, lastMessageAgoMs: 0, reconnects: 1, lastError: null }; }
  get(token: number): StreamQuote | null {
    if (!this.healthy) return null;
    if (token === NIFTY_INDEX_TOKEN) return { token, ltp: this.spot, bid: null, ask: null, depth: null, receivedAt: this.now - 200 };
    const r = this.rows.find((x) => x.token === token);
    if (!r) return null;
    const m = Math.max(5, r.right === 'PE' ? 100 + (r.strike - this.spot) * 0.4 : 100 - (r.strike - this.spot) * 0.4);
    const bid = Math.round((m - 0.5) * 20) / 20, ask = Math.round((m + 0.5) * 20) / 20;
    return { token, ltp: m, bid, ask, depth: { buy: [{ price: bid, quantity: 650 }], sell: [{ price: ask, quantity: 650 }] }, receivedAt: this.now - this.quoteAgeMs };
  }
  emitIndex(price: number, recvTs: number) { this.spot = price; for (const l of this.listeners) l({ token: NIFTY_INDEX_TOKEN, ltp: price, bid: null, ask: null, depth: null, receivedAt: recvTs }, Math.floor(recvTs / 1000) * 1000); }
}

const instruments = (stream: FakeStream): InstrumentPort => ({
  async nearestExpiry() { return '2026-11-17'; },
  async strikes(_e, lo, hi) { return stream.rows.filter((r) => r.strike >= lo && r.strike <= hi); },
});

function memStore(): StorePort & { trades: any[]; events: any[]; controls: any[] } {
  const s = {
    trades: [] as any[], events: [] as any[], controls: [] as any[],
    async loadControl() { return null; },
    async saveControl(c: any) { s.controls.push(c); },
    async saveTrade(t: any) { s.trades.push(t); },
    async saveEvents(e: any[]) { s.events.push(...e); },
    status() { return { enabled: true }; },
  };
  return s;
}

function setup(opts: { tradingDay?: boolean } = {}) {
  const stream = new FakeStream();
  const store = memStore();
  const svc = new LivePulseService({ stream, instruments: instruments(stream), isTradingDay: () => opts.tradingDay ?? true, now: () => stream.now, store });
  svc.start = () => {}; // drive time explicitly
  (stream as any).listeners.push((q: StreamQuote, x: number | null) => svc.onQuote(q, x));
  return { stream, svc, store };
}

const flush = () => new Promise((r) => setImmediate(r));

/** Advance one second: one index tick mid-second, then the boundary step. */
async function second(stream: FakeStream, svc: LivePulseService, price: number | null) {
  const boundary = stream.now + 1000;
  if (price != null) stream.emitIndex(price, boundary - 500);
  stream.now = boundary;
  await svc.tick(boundary);
  await flush();
}

test('live engine is OFF by default and never enters while OFF', async () => {
  const { stream, svc } = setup();
  svc.setConfig({ configId: EXT.id });
  assert.equal(svc.engine.running, false);
  assert.equal(svc.engine.dataMode, 'LIVE_PAPER');
  for (let i = 0; i < 90; i++) await second(stream, svc, 25000 + i * 1.5);
  assert.equal(svc.engine.samples.length, 90);
  assert.equal(svc.engine.trades.length + (svc.engine.position ? 1 : 0), 0);
  assert.ok(svc.engine.stats.episodes >= 1, 'signals are still evaluated and logged');
  assert.ok(svc.engine.timeline.some((e) => e.kind === 'REJECT' && /stopped|Engine/i.test(e.detail ?? '')));
});

test('live engine: paper entry from real-shaped quotes, flatten, trade persisted', async () => {
  const { stream, svc, store } = setup();
  assert.deepEqual(svc.setConfig({ configId: EXT.id }), { ok: true });
  assert.deepEqual(svc.control('start'), { ok: true });
  for (let i = 0; i < 90 && !svc.engine.position; i++) await second(stream, svc, 25000 + i * 1.5);
  const pos = svc.engine.position;
  assert.ok(pos, `expected a paper entry; last rejection: ${svc.engine.lastRejection?.reason}`);
  assert.equal(pos!.dataMode, 'LIVE_PAPER');
  assert.equal(pos!.lotSize, 65);
  assert.ok(pos!.fills.every((f: any) => JSON.stringify(f).includes('PAPER')));
  assert.equal(svc.setConfig({ configId: PRESETS[0].id }).ok, false, 'config locked while a position is open');
  assert.equal(svc.control('flatten').ok, true);
  await second(stream, svc, stream.spot);
  assert.equal(svc.engine.position, null);
  assert.equal(svc.engine.trades.length, 1);
  assert.equal(svc.engine.trades[0].exitReason, 'MANUAL_FLATTEN');
  await svc.flushStore();
  assert.equal(store.trades.length, 1);
  assert.equal(store.trades[0].sessionDay, '2026-11-13');
  assert.ok(store.controls.length >= 2);
});

test('live engine: stale option quotes are never filled', async () => {
  const { stream, svc } = setup();
  svc.setConfig({ configId: EXT.id });
  svc.control('start');
  stream.quoteAgeMs = 10_000;
  for (let i = 0; i < 90; i++) await second(stream, svc, 25000 + i * 1.5);
  assert.equal(svc.engine.position, null);
  assert.ok(svc.engine.lastRejection, 'rejected');
});

test('live engine: stale index data suspends signals (no ticks → STALE samples)', async () => {
  const { stream, svc } = setup();
  for (let i = 0; i < 70; i++) await second(stream, svc, 25000 + i);
  for (let i = 0; i < 5; i++) await second(stream, svc, null);
  const last = svc.engine.samples[svc.engine.samples.length - 1];
  assert.equal(last.status, 'STALE');
  assert.equal(svc.engine.signal?.direction, 'NEUTRAL');
  assert.ok(svc.engine.timeline.some((e) => e.kind === 'DATA'));
});

test('live engine: does not step outside market hours or on holidays', async () => {
  const { stream, svc } = setup({ tradingDay: false });
  for (let i = 0; i < 5; i++) await second(stream, svc, 25000);
  assert.equal(svc.engine.samples.length, 0);
  const b = setup();
  b.stream.now = Date.parse('2026-11-13T16:00:00+05:30');
  for (let i = 0; i < 5; i++) await second(b.stream, b.svc, 25000);
  assert.equal(b.svc.engine.samples.length, 0);
});

test('live engine: a new IST day starts a fresh engine that is OFF', async () => {
  const { stream, svc } = setup();
  svc.control('start');
  await second(stream, svc, 25000);
  const sid = svc.sessionId;
  stream.now = Date.parse('2026-11-16T09:20:00+05:30');
  await second(stream, svc, 25010);
  assert.notEqual(svc.sessionId, sid);
  assert.equal(svc.sessionDay, '2026-11-16');
  assert.equal(svc.engine.running, false);
  assert.equal(svc.engine.samples.length, 1);
});

test('kill switch blocks start until released', async () => {
  const { svc } = setup();
  svc.control('kill');
  assert.equal(svc.control('start').ok, false);
  svc.control('release');
  assert.equal(svc.control('start').ok, true);
});

test('setConfig accepts only valid paper-only configs derived from a preset', () => {
  const { svc } = setup();
  assert.equal(svc.setConfig({ config: { ...EXT, paperOnly: false } }).ok, false);
  assert.equal(svc.setConfig({ config: { ...EXT, id: 'made-up', parentId: null, immutable: false } }).ok, false);
  assert.equal(svc.setConfig({ config: { ...EXT, maxLossPerTrade: -5 } }).ok, false);
  const custom = { ...EXT, id: `${EXT.id}-custom`, parentId: EXT.id, immutable: false, version: 2, name: 'Mine', maxHoldSec: 90 };
  assert.deepEqual(svc.setConfig({ config: custom }), { ok: true });
  assert.equal(svc.engine.config.maxHoldSec, 90);
  assert.equal(svc.engine.config.paperOnly, true);
  assert.equal(svc.setConfig({ configId: 'nope' }).ok, false);
});

test('snapshot sends deltas after the cursor and resets on a new session', async () => {
  const { stream, svc } = setup();
  for (let i = 0; i < 10; i++) await second(stream, svc, 25000 + i);
  const full = svc.snapshot();
  assert.equal(full.reset, true);
  assert.equal(full.engine.samples.length, 10);
  assert.equal(full.chain?.source, 'LIVE');
  const lastT = full.engine.samples[9][0];
  await second(stream, svc, 25011);
  const d = svc.snapshot({ sid: full.sid, s: lastT, e: full.engine.timeline.at(-1)?.seq ?? 0, tc: 0, c: full.engine.lastCandidatesAt ?? undefined });
  assert.equal(d.reset, false);
  assert.equal(d.engine.samples.length, 1);
  assert.equal(d.engine.trades, null);
  assert.ok(JSON.stringify(d).length < JSON.stringify(full).length);
  assert.ok(!/access_token|api_key/i.test(JSON.stringify(full)));
});

test('live chain: honest quote ages; wire round-trip preserves quotes', () => {
  const stream = new FakeStream();
  const rows = stream.rows.filter((r) => r.strike >= 24900 && r.strike <= 25100);
  stream.quoteAgeMs = 4_000;
  const c = buildLiveChain({ expiry: '2026-11-17', lotSize: 65, strikeStep: 50, rows }, 25000, stream.now, (t) => stream.get(t));
  const q = c.quote(25000, 'PE')!;
  assert.equal(c.source, 'LIVE');
  assert.equal(stream.now - q.ts!, 4_000);
  assert.equal(q.bidQty, 650);
  const back = chainFromWire(chainToWire(c, rows));
  assert.deepEqual(back.quote(25000, 'PE'), q);
  assert.equal(istDate(OPEN), '2026-11-13');
});
