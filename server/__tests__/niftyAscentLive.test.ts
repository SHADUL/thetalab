/**
 * NIFTY ASCENT Phase 3: the live path (real Kite binary packets → the shared
 * stream's own decoder → QuoteAdapter → engine) must reach the same
 * decisions as deterministic replay, and must handle missing, duplicate,
 * delayed and out-of-order ticks by the documented policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePacket, packetExchangeTs, packetTradeMeta } from '../marketStream.ts';
import { splitPackets } from '../../src/nifty-alpha-ladder/live/kiteTickerProtocol.ts';
import { FIXTURES } from '../../src/nifty-ascent/sim/fixtures.ts';
import { Replay, prevSession, simInstruments } from '../../src/nifty-ascent/sim/market.ts';
import { AscentEngine, type IndexTick, type OptionTick } from '../../src/nifty-ascent/core/engine.ts';
import { QuoteAdapter, NIFTY_INDEX_TOKEN } from '../../src/nifty-ascent/live/adapter.ts';
import { barStart, hhmm } from '../../src/nifty-ascent/core/rules.ts';

/* ---------------- Kite binary encoding (what the exchange feed sends) ---------------- */

function indexPacket(price: number, exchTs: number | null): Buffer {
  const b = Buffer.alloc(exchTs == null ? 28 : 32);
  b.writeUInt32BE(NIFTY_INDEX_TOKEN, 0);
  b.writeInt32BE(Math.round(price * 100), 4);
  if (exchTs != null) b.writeInt32BE(Math.floor(exchTs / 1000), 28);
  return b;
}
function optionPacket(t: OptionTick, lastPrice: number, lastTradeTs = 0): Buffer {
  const b = Buffer.alloc(184);
  b.writeUInt32BE(t.token, 0);
  b.writeInt32BE(Math.round(lastPrice * 100), 4);
  b.writeInt32BE(t.volume ?? 0, 16);
  b.writeInt32BE(65, 8);
  b.writeInt32BE(Math.floor(lastTradeTs / 1000), 44);
  b.writeInt32BE(Math.floor(t.exchTs / 1000), 60);
  const lvl = (i: number, qty: number, price: number | null) => { const o = 64 + i * 12; b.writeInt32BE(qty, o); b.writeInt32BE(Math.round((price ?? 0) * 100), o + 4); b.writeInt16BE(qty ? 3 : 0, o + 8); };
  lvl(0, t.bid ? 650 : 0, t.bid); lvl(5, t.ask ? 650 : 0, t.ask);
  return b;
}
const frame = (...ps: Buffer[]) => {
  const parts: Buffer[] = [Buffer.alloc(2)];
  parts[0].writeInt16BE(ps.length, 0);
  for (const p of ps) { const l = Buffer.alloc(2); l.writeInt16BE(p.length, 0); parts.push(l, p); }
  return Buffer.concat(parts);
};

/** Exactly what server/marketStream.ts does per packet before calling an onQuote observer. */
function deliver(f: Buffer, receivedAt: number, sink: (q: ReturnType<typeof decodePacket> & {}, exchTs: number | null, meta: ReturnType<typeof packetTradeMeta>) => void) {
  for (const p of splitPackets(f)) {
    const q = decodePacket(p, receivedAt);
    if (!q || !(q.ltp > 0)) continue;
    sink(q, packetExchangeTs(p), packetTradeMeta(p));
  }
}

type Rec = ['C', number] | ['I', IndexTick] | ['O', OptionTick];

/** Runs a fixture through Replay and records every engine input in order. */
function record(fx: (typeof FIXTURES)[number], running: boolean) {
  const r = new Replay(fx, { startRunning: running });
  const e = r.engine, log: Rec[] = [];
  const oc = e.onClock.bind(e), oi = e.onIndexTick.bind(e), oo = e.onOptionTick.bind(e);
  e.onClock = (t) => { log.push(['C', t]); oc(t); };
  e.onIndexTick = (t) => { log.push(['I', t]); oi(t); };
  e.onOptionTick = (t) => { log.push(['O', t]); oo(t); };
  r.runToEnd();
  return { replay: e, log };
}

/** Replays the recorded inputs through real binary packets, the stream decoder and the adapter. */
function viaLivePath(fx: (typeof FIXTURES)[number], log: Rec[], running: boolean) {
  const e = new AscentEngine({ date: fx.date, prev: prevSession(fx), instruments: simInstruments(fx), startRunning: running });
  const a = new QuoteAdapter();
  const lastLtp = new Map<number, number>();
  const lastTrade = new Map<number, number>();
  const sink = (q: any, exchTs: number | null, meta: any) => {
    const ev = a.adapt(q, exchTs, (tok) => e.wantedTokens().includes(tok), meta);
    if (ev.kind === 'INDEX') e.onIndexTick(ev.tick);
    else if (ev.kind === 'OPTION') e.onOptionTick(ev.tick);
  };
  for (const [k, v] of log) {
    if (k === 'C') e.onClock(v);
    else if (k === 'I') deliver(frame(indexPacket(v.price, v.exchTs)), v.recvTs, sink);
    else {
      // A real packet always carries the last traded price; a quote-only update repeats the previous one.
      const ltp = v.traded && v.ltp ? v.ltp : lastLtp.get(v.token) ?? v.bid ?? 1;
      if (v.traded && v.ltp) { lastLtp.set(v.token, v.ltp); lastTrade.set(v.token, v.exchTs); }
      deliver(frame(optionPacket(v, ltp, lastTrade.get(v.token) ?? v.exchTs - 60_000)), v.recvTs, sink);
    }
  }
  return { live: e, adapter: a };
}

const decisions = (e: AscentEngine) => ({
  outcome: e.outcome, gap: e.gap, reference: e.reference?.price, gapFill: e.gapFill,
  or: e.or && { high: e.or.high, low: e.or.low, up: e.or.upsideBand, down: e.or.downsideBand },
  williams: e.williams, williamsEligible: e.williamsEligible, standDown: e.standDown && { reason: e.standDown.reason, bar: e.standDown.bar, close: e.standDown.close },
  handover: e.handover && { reason: e.handover.reason, bar: e.handover.bar }, signal: e.signal && { bot: e.signal.bot, right: e.signal.right, bar: e.signal.bar, close: e.signal.close },
  transitions: e.events.filter((x) => x.kind === 'TRANSITION').map((x) => [x.from, x.to, x.bar, x.trigger]),
  bars: e.index.bars.map((b) => [b.label, b.close, b.status]),
});

/* ---------------- equivalence: live path == deterministic replay ---------------- */

test('observe-only (engine PAUSED): every fixture reaches identical index-driven decisions via real Kite packets', () => {
  for (const fx of FIXTURES) {
    const { replay, log } = record(fx, false);
    const { live, adapter } = viaLivePath(fx, log, false);
    assert.deepEqual(decisions(live), decisions(replay), fx.id);
    assert.equal(live.positionsToday, 0);
    assert.equal(adapter.stats.noExchangeTs, 0);
  }
});

test('paper path (engine running): identical signals, contracts, fills, exits and P&L via real Kite packets', () => {
  for (const fx of FIXTURES) {
    const { replay, log } = record(fx, true);
    const { live, adapter } = viaLivePath(fx, log, true);
    assert.deepEqual(decisions(live), decisions(replay), fx.id);
    if (adapter.detection.packets) assert.equal(adapter.detection.lttOnly + adapter.detection.volumeOnly, 0, `${fx.id}: last-trade time and volume agree on simulated data`);
    const t = (e: AscentEngine) => e.trade && { sym: e.trade.tradingsymbol, entry: e.trade.entryPremium, exit: e.trade.exitPremium, reason: e.trade.exitReason, net: e.trade.net, high: e.trade.highest };
    assert.deepEqual(t(live), t(replay), fx.id);
    assert.deepEqual(live.premiumBars().map((b) => [b.label, b.close, b.status]), replay.premiumBars().map((b) => [b.label, b.close, b.status]), `${fx.id} premium bars`);
  }
});

/* ---------------- data quality through the binary path ---------------- */

const fx = FIXTURES.find((f) => f.id === 'gg-ce-trail')!;
function liveDay(mutate: (rec: Rec, i: number, out: Rec[]) => void) {
  const { log } = record(fx, false);
  const out: Rec[] = [];
  log.forEach((r, i) => mutate(r, i, out));
  return viaLivePath(fx, out, false).live;
}
const atHm = (hm: string, s = 0) => barStart(fx.date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) + s * 1000;

test('duplicate ticks: every index packet delivered twice → identical bars and decisions, duplicates counted', () => {
  const base = liveDay((r, _i, o) => o.push(r));
  const dup = liveDay((r, _i, o) => { o.push(r); if (r[0] === 'I') o.push(r); });
  assert.deepEqual(decisions(dup), decisions(base));
  assert.ok(dup.index.stats.duplicates > 20_000);
});

test('out-of-order ticks: an older tick arriving after a newer one is dropped and never moves a close', () => {
  const live = liveDay((r, _i, o) => {
    o.push(r);
    if (r[0] === 'I' && r[1].exchTs === atHm('10:01', 59)) o.push(['I', { exchTs: atHm('10:01', 57), recvTs: r[1].recvTs + 10, price: 99999 }]); // 2 s older, not stale
  });
  assert.ok(live.index.stats.outOfOrder >= 1);
  assert.notEqual(live.index.get(10 * 60 + 1)!.close, 99999);
  assert.equal(live.signal?.bot, 'GAP_AND_GO');
});

test('delayed ticks: > 5 s old on receipt → dropped as stale; arriving after the bar is confirmed → late, not applied', () => {
  const live = liveDay((r, _i, o) => {
    if (r[0] === 'I' && r[1].exchTs === atHm('10:20', 10)) { o.push(['I', { ...r[1], recvTs: r[1].exchTs + 6_000 }]); return; }
    o.push(r);
    // Fresh enough (3.1 s) to pass the stale check, but its bar (10:20) was confirmed at 10:21:01.5.
    if (r[0] === 'C' && r[1] === atHm('10:21', 2)) o.push(['I', { exchTs: atHm('10:20', 59), recvTs: atHm('10:21', 2) + 100, price: 1 }]);
  });
  assert.ok(live.events.some((x) => x.trigger === 'stale_tick'));
  assert.ok(live.events.some((x) => x.trigger === 'late_tick'));
  assert.notEqual(live.index.get(10 * 60 + 20)!.close, 1);
});

test('missing ticks: a silent opening-range minute → DATA_ERROR; a silent Gap-and-Go minute → DATA_ERROR before any signal', () => {
  const orGap = liveDay((r, _i, o) => { if (r[0] === 'I' && hhmm(Math.floor((r[1].exchTs - barStart(fx.date, 0)) / 60000)) === '09:40') return; o.push(r); });
  assert.equal(orGap.state, 'DATA_ERROR');
  assert.match(orGap.outcome!.detail!, /09:40/);
  const ggGap = liveDay((r, _i, o) => { if (r[0] === 'I' && hhmm(Math.floor((r[1].exchTs - barStart(fx.date, 0)) / 60000)) === '09:55') return; o.push(r); });
  assert.equal(ggGap.state, 'DATA_ERROR');
  assert.equal(ggGap.signal, null);
});

test('packets without an exchange timestamp (index quote mode, 28 bytes) are dropped, never timed by receipt', () => {
  const a = new QuoteAdapter();
  let got: string | null = null;
  deliver(frame(indexPacket(25000, null)), 1_000, (q, ts) => { got = a.adapt(q, ts, () => false).kind; });
  assert.equal(got, 'DROP');
  assert.equal(a.stats.noExchangeTs, 1);
});

test('missing ticks after an entry: the open paper position keeps being managed; no second entry', () => {
  const { log } = record(fx, true);
  const cut = log.filter((r) => !(r[0] === 'I' && r[1].exchTs >= atHm('10:20') && r[1].exchTs < atHm('10:21')));
  const { live } = viaLivePath(fx, cut, true);
  assert.equal(live.positionsToday, 1);
  assert.ok(live.trade, 'position still exits normally');
  assert.ok(live.events.some((x) => x.trigger === 'missing_bar'));
});

/* ---------------- guards ---------------- */

test('server/niftyAscent.ts: observe-only, read-only Kite GETs, no orders, no credential logging', () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../niftyAscent.ts'), 'utf8');
  for (const re of [/\/orders\b/, /place_?order/i, /transaction_type/i, /method:\s*'POST'/i, /kiteconnect/i, /console\.\w+\([^)]*(accessToken|access_token|apiKey)\b/]) assert.ok(!re.test(src), `matches ${re}`);
  assert.match(src, /flag !== 'observe' && flag !== 'paper'/);
  assert.match(src, /PAPER mode needs Supabase/);
  assert.match(src, /only historical minute\/day reads are allowed/);
  assert.match(src, /marketStream\.start/);
  assert.ok(!/new WebSocket|wss:\/\//.test(src), 'no second Kite connection');
});

test('live paper uses LIVE_PAPER_EXECUTION (EXEC-2): ₹20,000 outlay and max loss, everything else default', async () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../niftyAscent.ts'), 'utf8');
  assert.match(src, /exec: LIVE_PAPER_EXECUTION/);
  const { LIVE_PAPER_EXECUTION: L, DEFAULT_EXECUTION: D } = await import('../../src/nifty-ascent/core/rules.ts');
  assert.deepEqual([L.version, L.maxPremiumOutlay, L.maxTheoreticalLoss, L.dailyLossCutoff, L.lots, L.paperCapital], ['EXEC-2', 20_000, 20_000, 15_000, 1, 200_000]);
  assert.deepEqual({ ...L, version: D.version, maxPremiumOutlay: D.maxPremiumOutlay, maxTheoreticalLoss: D.maxTheoreticalLoss }, D);
  assert.equal(D.maxPremiumOutlay, 15_000, 'simulation/backtest defaults unchanged');
});
