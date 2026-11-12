import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PulseEngine } from '../core/engine.ts';
import { presetById, type PulseConfig } from '../core/config.ts';
import { computeAnalytics } from '../core/analytics.ts';
import { Replay } from '../sim/replay.ts';
import { SyntheticMarket, hash01, mulberry32 } from '../sim/market.ts';
import type { Tick } from '../core/sampler.ts';
import { fakeChain, T0 } from './helpers.ts';

const A = presetById('strategy-a-baseline')!;
const X = presetById('strategy-a-extended-risk')!;

const chainAt = (at: number, spot = 25_010) => fakeChain({
  spot, at,
  quotes: { '25000PE': [100, 100.5], '24950PE': [80, 80.5], '24900PE': [63, 63.5], '25000CE': [110, 110.5], '25050CE': [88, 88.5], '25100CE': [69, 69.5] },
});

/** Drive the engine with one tick per second along a price path. */
function drive(e: PulseEngine, prices: number[], start = T0, chain = chainAt) {
  prices.forEach((p, i) => {
    const b = start + (i + 1) * 1000;
    const t: Tick = { price: p, exchTs: b - 400, recvTs: b - 300 };
    e.step(b, [t], () => chain(b));
  });
}
const flat = (n: number, p = 25_000) => Array.from({ length: n }, () => p);
const rampUp = [25001, 25003, 25005, 25007, 25009, 25011, 25013, 25015, 25017, 25019];

test('engine is OFF by default and refuses non-paper configs', () => {
  assert.equal(new PulseEngine(A, { dataMode: 'LIVE_PAPER' }).running, false);
  assert.throws(() => new PulseEngine({ ...A, paperOnly: false } as unknown as PulseConfig, { dataMode: 'LIVE_PAPER' }));
});

test('no signal before 61 valid seconds; then a bullish signal opens a paper bull put (Extended Risk)', () => {
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, flat(30));
  assert.equal(e.indicators!.ready, false);
  assert.match(e.statusReason(), /Waiting for 61 seconds of valid data/);
  drive(e, [...flat(31), ...rampUp], T0 + 30_000);
  assert.ok(e.position, 'position opened');
  assert.equal(e.position!.kind, 'BULL_PUT');
  assert.equal(e.position!.configKey, 'strategy-a-extended-risk@v1');
  assert.ok(e.timeline.some((x) => x.kind === 'SIGNAL' && /Bullish/.test(x.title)));
  assert.ok(e.timeline.some((x) => x.kind === 'ENTRY'));
});

test('baseline: the same signal is rejected with NO ELIGIBLE SPREAD WITHIN RISK LIMIT', () => {
  const e = new PulseEngine(A, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp]);
  assert.equal(e.position, null);
  assert.equal(e.lastRejection!.reason, 'NO ELIGIBLE SPREAD WITHIN RISK LIMIT');
  assert.equal(e.stats.entries, 0);
});

test('duplicate prevention: one attempt per signal episode', () => {
  const e = new PulseEngine(A, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp, 25021, 25023, 25025, 25027]);
  assert.equal(e.stats.episodes, 1);
  assert.equal(e.stats.attempts, 1);
});

test('stopped engine blocks new entries but keeps managing the open position to its exit', () => {
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp]);
  assert.ok(e.position);
  e.stop(T0 + 72_000);
  drive(e, flat(130, 25_019), T0 + 71_000);
  assert.equal(e.position, null);
  assert.equal(e.trades.length, 1);
  assert.equal(e.trades[0].exitReason, 'TIME_EXIT');
  drive(e, [...flat(61, 25_019), 25021, 25023, 25025, 25027, 25029, 25031, 25033, 25035, 25037, 25039], T0 + 201_000);
  assert.equal(e.trades.length, 1);
  assert.ok(e.timeline.some((x) => x.kind === 'REJECT' && /Engine stopped/.test(x.detail ?? '')));
});

test('kill switch stops the engine and flattens the open paper position', () => {
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp]);
  e.setKillSwitch(true, T0 + 72_000);
  drive(e, [25_019], T0 + 71_000);
  assert.equal(e.running, false);
  assert.equal(e.trades[0].exitReason, 'KILL_SWITCH');
});

test('feed gap: stale seconds suspend signals and are logged; recovery rebuilds the buffer', () => {
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, flat(70));
  assert.equal(e.indicators!.ready, true);
  for (let i = 1; i <= 5; i++) e.step(T0 + 70_000 + i * 1000, [], () => chainAt(T0 + 70_000 + i * 1000));
  assert.equal(e.samples[e.samples.length - 1].status, 'STALE');
  assert.equal((e.indicators as { ready: boolean }).ready, false);
  assert.ok(e.timeline.some((x) => x.kind === 'DATA' && /stale/.test(x.title)));
  drive(e, [25_001], T0 + 75_000);
  assert.ok(e.timeline.some((x) => x.kind === 'DATA' && /recovered/.test(x.title)));
  assert.equal(e.indicators!.ready, false);
});

test('missing option chain → "Option spread unavailable", no position', () => {
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp], T0, () => null as any);
  assert.equal(e.position, null);
  assert.match(e.lastRejection!.reason, /Option spread unavailable/);
});

test('entries stop at the entry cutoff and open positions are force-closed before the close', () => {
  const late = Date.parse('2026-11-13T15:25:30+05:30') - 72_000;
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp], late);
  assert.equal(e.position, null);
  assert.match(e.lastRejection!.reason, /Outside entry window/);
});

test('config cannot change while a position is open', () => {
  const e = new PulseEngine(X, { dataMode: 'SIMULATION', running: true });
  drive(e, [...flat(61), ...rampUp]);
  assert.equal(e.setConfig(A, T0 + 72_000), false);
  assert.equal(e.config.id, X.id);
});

// ── Replay determinism ───────────────────────────────────────────────
test('synthetic market is deterministic per seed and differs across seeds', () => {
  const a = new SyntheticMarket({ seed: 7, date: '2026-11-13' }), b = new SyntheticMarket({ seed: 7, date: '2026-11-13' });
  for (let i = 0; i < 500; i++) assert.deepEqual(a.next(), b.next());
  assert.deepEqual(a.chain().quote(Math.round(a.spot / 50) * 50, 'PE'), b.chain().quote(Math.round(b.spot / 50) * 50, 'PE'));
  assert.notEqual(new SyntheticMarket({ seed: 8, date: '2026-11-13' }).spot, new SyntheticMarket({ seed: 7, date: '2026-11-13' }).spot);
  assert.equal(mulberry32(1)(), mulberry32(1)());
  assert.equal(hash01(1, 2, 3), hash01(1, 2, 3));
  assert.equal(a.chain().source, 'SIMULATION');
});

test('replay: identical seed + config ⇒ identical decisions, trades and timeline', () => {
  const run = () => { const r = new Replay({ seed: 3, date: '2026-11-13', config: X }); r.runToEnd(); return r.engine; };
  const e1 = run(), e2 = run();
  assert.deepEqual(e1.trades, e2.trades);
  assert.deepEqual(e1.timeline, e2.timeline);
  assert.deepEqual(e1.stats, e2.stats);
  assert.equal(e1.samples.length, 22_500);
  assert.ok(e1.trades.every((t) => t.dataMode === 'SIMULATION' && t.id.startsWith('NP-SIM-')));
  assert.ok(e1.trades.length <= X.maxTradesPerDay);
});

test('replay: daily loss and trade-count limits hold over a full session for both presets', () => {
  for (const cfg of [A, X]) for (const seed of [1, 2, 4]) {
    const r = new Replay({ seed, date: '2026-11-13', config: cfg });
    r.runToEnd();
    const e = r.engine;
    assert.ok(e.trades.length <= cfg.maxTradesPerDay);
    assert.ok(e.realizedToday > -cfg.maxDailyLoss - cfg.maxLossPerTrade);
    for (const t of e.trades) assert.ok(t.maxLoss <= cfg.maxLossPerTrade, `${t.id} max loss ${t.maxLoss}`);
    assert.equal(e.position, null, 'flat at the close');
  }
});

test('analytics: computed from recorded trades only, with a small-sample warning', () => {
  const r = new Replay({ seed: 2, date: '2026-11-13', config: X });
  r.runToEnd();
  const a = computeAnalytics(r.engine.trades, r.engine.stats);
  assert.equal(a.trades, r.engine.trades.length);
  assert.equal(a.netPnl, Math.round(r.engine.trades.reduce((s, t) => s + t.realizedNet!, 0) * 100) / 100);
  assert.match(a.sampleWarning!, /At least 30/);
  assert.equal(computeAnalytics([], null).sampleWarning, 'No completed paper trades yet — nothing to analyse.');
});
