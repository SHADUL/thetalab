import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, scoreSetup, positionStatus, closeMetrics, closedStats, compileLearnings, effectiveRules,
  scanUniverse, analyzeTicker, computeTechnicals, DEFAULT_LEARNINGS, type Technicals, type ClosedTrade,
} from '../engine.ts';
import type { Bar } from '../../swing/indicators/types.ts';

/** Steady uptrend with a gentle wave so RSI/ADX stay in a realistic range. */
function trendBars(n = 300, start = 100, drift = 0.15, vol = 2_000_000): Bar[] {
  const bars: Bar[] = [];
  const d0 = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const c = start + drift * i + 3 * Math.sin(i / 6);
    bars.push({ t: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), o: c - 0.5, h: c + 1.5, l: c - 1.5, c, v: vol });
  }
  return bars;
}

test('buildPlan follows the skill formula (entry CMP+0.5ATR, stop CMP-1.5ATR, T1 1.5R, T2 3R)', () => {
  const p = buildPlan(2599, 57, 500_000, 1);
  assert.equal(p.entry, 2627.5);
  assert.equal(p.stop, 2513.5);
  assert.equal(p.riskPerShare, 114);
  assert.equal(p.t1, 2798.5);
  assert.equal(p.t2, 2969.5);
  assert.equal(p.qty, 43); // 5000 / 114
  assert.equal(p.rrT1, 1.5);
  assert.equal(p.rrT2, 3);
});

test('buildPlan caps risk at 1% even if asked for more', () => {
  const p = buildPlan(100, 2, 100_000, 5);
  assert.equal(p.qty, Math.floor(1000 / 4));
});

test('scoreSetup awards the documented buckets', () => {
  const t = { rsi14: 45, adx14: 40, dmaPct: 3, macdState: 'accelerating' } as Technicals;
  assert.equal(scoreSetup(t, false), 30 + 25 + 20 + 15);
  assert.equal(scoreSetup(t, true), 100);
  assert.equal(scoreSetup({ rsi14: 68, adx14: 15, dmaPct: 30, macdState: 'fading' } as Technicals, false), 0);
});

test('positionStatus signals in priority order', () => {
  const p = { id: 1, symbol: 'X', entry: 100, stop: 90, t1: 115, t2: 130, qty: 10, opened_at: '2026-11-01', atr: 4 };
  assert.equal(positionStatus(p, 89, true, '2026-11-03', 15).signal, 'EXIT');
  assert.equal(positionStatus(p, 131, true, '2026-11-03', 15).signal, 'EXIT');
  assert.equal(positionStatus(p, 105, true, '2026-11-20', 15).signal, 'EXIT'); // time stop
  const trail = positionStatus(p, 116, true, '2026-11-03', 15);
  assert.equal(trail.signal, 'TRAIL');
  assert.equal(trail.trailStop, 110);
  assert.equal(positionStatus(p, 94, true, '2026-11-03', 15).signal, 'WATCH');
  assert.equal(positionStatus(p, 109, true, '2026-11-03', 15).signal, 'HOLD+');
  const hold = positionStatus(p, 102, true, '2026-11-03', 15);
  assert.equal(hold.signal, 'HOLD');
  assert.equal(hold.unrealizedInr, 20);
  assert.equal(hold.rMultiple, 0.2);
});

test('closeMetrics computes R, P&L and outcome', () => {
  const m = closeMetrics({ entry: 100, stop: 90, qty: 10, opened_at: '2026-11-01' }, 115, '2026-11-08');
  assert.deepEqual(m, { rMultiple: 1.5, daysHeld: 7, pnlInr: 150, outcome: 'win' });
  assert.equal(closeMetrics({ entry: 100, stop: 90, qty: 1, opened_at: '2026-11-01' }, 99, '2026-11-02').outcome, 'breakeven');
  assert.equal(closeMetrics({ entry: 100, stop: 90, qty: 1, opened_at: '2026-11-01' }, 90, '2026-11-02').outcome, 'loss');
});

const trade = (symbol: string, outcome: string, r: number, rsi = 55, days = 5, sector = 'IT'): ClosedTrade => ({
  symbol, outcome, r_multiple: r, pnl_inr: r * 1000, days_held: days, closed_at: '2026-11-01T00:00:00Z', sector, setup: { rsi14: rsi, adx14: 30 },
});

test('closedStats summarises wins, losses and expectancy', () => {
  const s = closedStats([trade('A', 'win', 2), trade('B', 'loss', -1), trade('C', 'breakeven', 0)]);
  assert.equal(s.count, 3);
  assert.equal(s.winRate, 33.33);
  assert.equal(s.avgR, 0.33);
  assert.equal(s.best?.symbol, 'A');
  assert.equal(s.worst?.symbol, 'B');
});

test('compileLearnings refuses below 10 trades', () => {
  const r = compileLearnings([trade('A', 'win', 1)], null, '2026-11-11');
  assert.equal(r.ok, false);
});

test('compileLearnings tightens RSI cap, adds skip list and logs the diff', () => {
  const closed = [
    ...Array.from({ length: 5 }, () => trade('HOT', 'loss', -1, 68)),
    ...Array.from({ length: 6 }, (_, i) => trade(`OK${i}`, 'win', 1.5, 45)),
  ];
  const r = compileLearnings(closed, null, '2026-11-11');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.learnings.rsiMaxEntry, 65);
  assert.deepEqual(r.learnings.skipList, ['HOT']);
  assert.ok(r.diff.some((d) => d.includes('rsiMaxEntry: 70 → 65')));
  assert.match(r.markdown, /Sample:\*\* N=11/);
});

test('effectiveRules ignores learnings below sample 10', () => {
  const r = effectiveRules({ ...DEFAULT_LEARNINGS, sampleSize: 5, active: true, rsiMaxEntry: 50 });
  assert.equal(r.rsiMaxEntry, 70);
});

test('scanUniverse ranks an uptrend and rejects a downtrend', () => {
  const up = trendBars();
  const down = trendBars(300, 200, -0.2);
  const res = scanUniverse([
    { symbol: 'UP', bars: up },
    { symbol: 'DOWN', bars: down },
    { symbol: 'SHORT', bars: up.slice(0, 50) },
  ], 500_000, 1, DEFAULT_LEARNINGS);
  assert.equal(res.scanned, 3);
  const rej = Object.fromEntries(res.rejected.map((r) => [r.symbol, r.reason]));
  assert.equal(rej.DOWN, 'below 200DMA');
  assert.equal(rej.SHORT, 'insufficient history');
  for (const p of res.picks) {
    assert.ok(p.plan.positionPct <= 35);
    assert.ok(p.plan.rrT2 >= 2.5);
  }
});

test('analyzeTicker blocks new entries when slots are full', () => {
  const bars = trendBars();
  const t = computeTechnicals(bars);
  assert.ok(t);
  const a = analyzeTicker('UP', bars, null, 500_000, 1, DEFAULT_LEARNINGS, { openCount: 3, monthPnlPct: 0, alreadyOpen: false });
  assert.ok(a);
  assert.notEqual(a!.verdict, 'BUY');
  const s = analyzeTicker('DOWN', trendBars(300, 200, -0.2), null, 500_000, 1, DEFAULT_LEARNINGS, { openCount: 0, monthPnlPct: 0, alreadyOpen: false });
  assert.equal(s!.verdict, 'SKIP');
});
