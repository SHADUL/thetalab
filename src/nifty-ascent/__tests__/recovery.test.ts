import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES } from '../sim/fixtures.ts';
import { Replay, prevSession, simInstruments } from '../sim/market.ts';
import { AscentEngine } from '../core/engine.ts';
import { barStart } from '../core/rules.ts';

const final = (e: AscentEngine) => ({
  outcome: e.outcome, state: e.state, signal: e.signal && { bot: e.signal.bot, right: e.signal.right, bar: e.signal.bar },
  standDown: e.standDown?.reason ?? null, positions: e.positionsToday,
  trade: e.trade && { sym: e.trade.tradingsymbol, entry: e.trade.entryPremium, exit: e.trade.exitPremium, reason: e.trade.exitReason, net: e.trade.net },
});

/** Run a fixture, but serialize → JSON → restore the engine at `cutHm` (no downtime). */
function withRestart(fx: (typeof FIXTURES)[number], cutHm: string, downSeconds = 0) {
  const r = new Replay(fx);
  const [h, m] = cutHm.split(':').map(Number);
  const cut = barStart(fx.date, h * 60 + m) + 20_000;
  r.stepTo(cut);
  const snap = JSON.parse(JSON.stringify(r.engine.serialize()));
  const resumeAt = r.t + downSeconds * 1000;
  r.engine = AscentEngine.restore({ date: fx.date, prev: prevSession(fx), instruments: simInstruments(fx), startRunning: true }, snap, resumeAt);
  if (downSeconds) {
    // Ticks during the outage were never seen: skip them (the clock jumps).
    (r as any).t = resumeAt;
  }
  r.runToEnd();
  return r.engine;
}

test('restart with no downtime at any point reproduces the uninterrupted session exactly (every fixture)', () => {
  for (const fx of FIXTURES) {
    const whole = new Replay(fx).runToEnd();
    for (const cut of ['09:30', '09:50', '10:22', '11:00', '11:28', '12:10', '14:00', '15:16']) {
      const e = withRestart(fx, cut);
      assert.deepEqual(final(e), final(whole), `${fx.id} restarted at ${cut}`);
      assert.ok(e.events.some((x) => x.trigger === 'restored'));
    }
  }
});

test('restart never re-enters a day whose entry already filled, or whose entry was rejected', () => {
  const traded = FIXTURES.find((f) => f.id === 'gg-ce-trail')!;
  const e = withRestart(traded, '14:00');
  assert.equal(e.positionsToday, 1);
  assert.equal(e.events.filter((x) => x.kind === 'FILL' && x.trigger === 'entry_fill').length, 0, 'no new entry after restore');
  const rejected = FIXTURES.find((f) => f.id === 'budget-reject')!;
  const r = withRestart(rejected, '11:00');
  assert.equal(r.positionsToday, 0);
  assert.equal(r.outcome?.reason, 'entry_rejected');
});

test('downtime in an active signal window → DATA_ERROR, no entry from stale recovery data', () => {
  const fx = FIXTURES.find((f) => f.id === 'gg-ce-trail')!;   // breakout at 10:02
  const e = withRestart(fx, '09:55', 300);                    // down 09:55:20 → 10:00:20
  assert.equal(e.state, 'DATA_ERROR');
  assert.equal(e.positionsToday, 0);
  assert.match(e.events.find((x) => x.trigger === 'restored')!.reason, /unobserved minute/);
});

test('downtime with an open position: the position is still managed and exits; no second entry', () => {
  const fx = FIXTURES.find((f) => f.id === 'gg-ce-trail')!;   // in position from 10:03, trail exit ≈ 12:3x
  const e = withRestart(fx, '11:00', 240);
  assert.equal(e.positionsToday, 1);
  assert.ok(e.trade, 'still exits');
  assert.equal(e.position, null);
});

test('a snapshot from another day or another config version is refused', () => {
  const fx = FIXTURES[0];
  const r = new Replay(fx); r.stepTo(barStart(fx.date, 600));
  const snap = r.engine.serialize();
  assert.throws(() => AscentEngine.restore({ date: '2026-11-03', prev: prevSession(fx), instruments: simInstruments(fx) }, snap, Date.now()), /cannot restore/);
  assert.throws(() => AscentEngine.restore({ date: fx.date, prev: prevSession(fx), instruments: simInstruments(fx), exec: { ...r.engine.exec, version: 'EXEC-9' } }, snap, Date.now()), /config/);
});
