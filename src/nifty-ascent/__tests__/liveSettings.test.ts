import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LiveAscentService, type InstrumentPort, type StreamPort } from '../live/service.ts';
import { MemoryAscentStore } from '../live/store.ts';
import { NIFTY_INDEX_TOKEN } from '../live/adapter.ts';
import { at, instruments as mkInst } from './helpers.ts';
import { hhmm, LIVE_PAPER_EXECUTION, LIVE_PAPER_RULES } from '../core/rules.ts';
import { LiveSettingsStore } from '../../../server/niftyAscentLiveSettings.ts';

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


const tmp = () => mkdtempSync(path.join(tmpdir(), 'na-set-'));

test('live settings: defaults are exactly the current live paper settings', () => {
  const s = new LiveSettingsStore(tmp());
  const c = s.current();
  assert.deepEqual(c.exec, LIVE_PAPER_EXECUTION);
  assert.equal(c.rules.version, LIVE_PAPER_RULES.version);
});

test('live settings: validated, versioned, persisted and audited; bad input refused', () => {
  const dir = tmp();
  const s = new LiveSettingsStore(dir);
  assert.match((s.save({ exec: { lots: 0 } }) as any).message, /lots/);
  assert.match((s.save({ exec: { lots: 1.5 } }) as any).message, /whole number/);
  assert.match((s.save({ exec: { maxPremiumOutlay: 300_000 } }) as any).message, /paper capital/);
  assert.match((s.save({ exec: { version: 'X' } }) as any).message, /cannot be changed/);
  assert.match((s.save({ variant: { minOrWidth: -1 } }) as any).message, /minOrWidth/);
  assert.match((s.save({ variant: { foo: 1 } }) as any).message, /not a rule filter/);
  assert.ok(!existsSync(path.join(dir, 'live-settings.json')), 'refused input writes nothing');
  const v = s.save({ variant: { minOrWidth: 0, rollExpiryWithinDays: 0 } });
  assert.ok(v.ok);
  assert.equal(s.current().rules.version, 'NIFTY_ASCENT_V1.0');
  assert.equal(s.current().exec.version, 'EXEC-2', 'exec unchanged → same exec version');
  assert.ok(s.save({ exec: { lots: 2, maxPremiumOutlay: 40_000, maxTheoreticalLoss: 40_000 } }).ok);
  const r = new LiveSettingsStore(dir).current();
  assert.deepEqual([r.exec.lots, r.exec.maxPremiumOutlay, r.exec.dailyLossCutoff, r.exec.version, r.rules.version], [2, 40_000, 15_000, 'EXEC-L2', 'NIFTY_ASCENT_V1.0']);
  assert.equal(readFileSync(path.join(dir, 'live-settings-log.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('live settings: a change during the day never alters the running session, and a restart restores it with the pinned settings', async () => {
  const dir = tmp();
  const cfg = new LiveSettingsStore(dir);
  assert.ok(cfg.save({ variant: { minOrWidth: 0 } }).ok); // this fixture day has a 40-pt opening range
  const store = new MemoryAscentStore();
  store.control.autoStart = true;
  const a = new LiveAscentService({ ...deps(store, 'A'), config: cfg });
  await run(a, '08:55:00', '11:00:00');
  assert.equal(a.engine!.state, 'POSITION_OPEN');
  const v1 = a.engine!.configVersion;
  assert.ok(cfg.save({ exec: { lots: 3 }, variant: { minOrWidth: 80, rollExpiryWithinDays: 1 } }).ok);
  assert.equal(a.engine!.configVersion, v1, 'running engine unchanged');
  // Process A dies; B restores from the database with the PINNED settings (not the new ones).
  const b = new LiveAscentService({ ...deps(store, 'B'), config: new LiveSettingsStore(dir) });
  await run(b, '11:01:40', '15:31:30');
  const e = b.engine!;
  assert.ok(e.events.some((x) => x.trigger === 'restored'), 'restored, not a fresh engine');
  assert.equal(e.configVersion, v1);
  assert.equal(e.positionsToday, 1); assert.ok(e.trade);
  assert.equal(e.trade!.qty, 65, 'still one lot today');
  // The next session uses the saved settings.
  const next = b.sessionConfig('2026-11-26');
  assert.deepEqual([next.exec.lots, next.rules.minOrWidth, next.rules.rollExpiryWithinDays], [3, 80, 1]);
});
