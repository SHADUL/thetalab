import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneSecondSampler } from '../core/sampler.ts';
import { computeIndicators, requiredSamples, trailingValidRun } from '../core/indicators.ts';
import { evaluateSignal } from '../core/signal.ts';
import { PRESETS, presetById, deriveVersion, validateConfig, configKey, diffConfig } from '../core/config.ts';
import { T0, samplesFrom, series } from './helpers.ts';

const A = presetById('strategy-a-baseline')!;

// ── Sampler ───────────────────────────────────────────────────────────
test('sampler: FRESH when a tick arrived this second, HELD within freshness, STALE beyond, NO_DATA before any tick', () => {
  const s = new OneSecondSampler(2_500);
  assert.equal(s.sample(T0).status, 'NO_DATA');
  s.onTick({ price: 25000, exchTs: T0 + 400, recvTs: T0 + 500 });
  const a = s.sample(T0 + 1000);
  assert.equal(a.status, 'FRESH'); assert.equal(a.valid, true); assert.equal(a.ticks, 1); assert.equal(a.ageMs, 500);
  const b = s.sample(T0 + 2000);
  assert.equal(b.status, 'HELD'); assert.equal(b.valid, true); assert.equal(b.price, 25000);
  s.sample(T0 + 3000);
  const d = s.sample(T0 + 4000); // 3.5 s old
  assert.equal(d.status, 'STALE'); assert.equal(d.valid, false); assert.equal(d.price, 25000);
});

test('sampler: several ticks in one second → latest price, counted; out-of-order exchange ticks are dropped', () => {
  const s = new OneSecondSampler(2_500);
  s.onTick({ price: 25000, exchTs: T0 + 100, recvTs: T0 + 150 });
  s.onTick({ price: 25002, exchTs: T0 + 600, recvTs: T0 + 650 });
  assert.equal(s.onTick({ price: 24990, exchTs: T0 + 300, recvTs: T0 + 700 }), false);
  const x = s.sample(T0 + 1000);
  assert.equal(x.price, 25002); assert.equal(x.ticks, 2); assert.equal(s.dropped, 1);
  assert.equal(s.onTick({ price: -1, exchTs: null, recvTs: T0 + 800 }), false);
});

// ── Indicators ────────────────────────────────────────────────────────
test('indicators: waits for 61 consecutive valid samples', () => {
  assert.equal(requiredSamples(A), 61);
  const r = computeIndicators(samplesFrom(Array.from({ length: 60 }, () => 25000)), A);
  assert.equal(r.ready, false);
  assert.match((r as any).reason, /Waiting for 61 seconds of valid data \(60\/61\)/);
  assert.equal(computeIndicators(samplesFrom(Array.from({ length: 61 }, () => 25000)), A).ready, true);
});

test('indicators: a stale second resets the valid run (no bridging gaps)', () => {
  const ss = samplesFrom(Array.from({ length: 70 }, () => 25000));
  ss[65] = { ...ss[65], status: 'STALE', valid: false };
  assert.equal(trailingValidRun(ss), 4);
  const r = computeIndicators(ss, A);
  assert.equal(r.ready, false);
});

test('indicators: R5, R15, MA60 and last-5 changes follow the exact formulas', () => {
  const prices = series([25001, 25002, 25003, 25004, 25005, 25006, 25007, 25008, 25009, 25010, 25011, 25012, 25013, 25014, 25015]);
  const r = computeIndicators(samplesFrom(prices), A);
  assert.ok(r.ready);
  if (!r.ready) return;
  const p = (b: number) => prices[prices.length - 1 - b];
  assert.ok(Math.abs(r.r5 - (p(0) / p(5) - 1) * 100) < 1e-6);
  assert.ok(Math.abs(r.r15 - (p(0) / p(15) - 1) * 100) < 1e-6);
  const ma = prices.slice(-60).reduce((a, b) => a + b, 0) / 60;
  assert.ok(Math.abs(r.ma60 - ma) < 1e-4);
  assert.equal(r.ups, 5); assert.equal(r.downs, 0); assert.equal(r.flats, 0);
});

// ── Signal ────────────────────────────────────────────────────────────
// 25,000 × 0.015% = 3.75 pts in 5 s; × 0.030% = 7.5 pts in 15 s.
const rising = series([...Array.from({ length: 10 }, (_, i) => 25000 + (i + 1) * 0.2), 25003, 25005, 25007, 25009, 25011]);
const falling = series([...Array.from({ length: 10 }, (_, i) => 25000 - (i + 1) * 0.2), 24997, 24995, 24993, 24991, 24989]);

test('signal: bullish when R5 > +0.015%, R15 > +0.030%, price > MA60 and ≥4 of 5 changes up', () => {
  const s = evaluateSignal(computeIndicators(samplesFrom(rising), A), A);
  assert.equal(s.direction, 'BULLISH');
  assert.equal(s.bullAgree, 4);
  assert.deepEqual(s.agreement, { count: 4, of: 4, side: 'BULLISH' });
});

test('signal: bearish is the mirror image', () => {
  const s = evaluateSignal(computeIndicators(samplesFrom(falling), A), A);
  assert.equal(s.direction, 'BEARISH');
  assert.equal(s.bearAgree, 4);
});

test('signal: neutral when any one rule is missing, with the missing rule named', () => {
  // R5 just under threshold: last 5 s rise only 3.5 pts.
  const weak = series([...Array.from({ length: 10 }, (_, i) => 25000 + (i + 1) * 0.5), 25005.7, 25006.4, 25007.1, 25007.8, 25008.5]);
  const s = evaluateSignal(computeIndicators(samplesFrom(weak), A), A);
  assert.equal(s.direction, 'NEUTRAL');
  assert.match(s.reason, /Momentum conditions not aligned/);
  assert.match(s.reason, /5s return/);
});

test('signal: flat changes never count as confirmation (3 up + 2 flat ≠ 4-of-5)', () => {
  const tail = [...Array.from({ length: 10 }, (_, i) => 25000 + (i + 1) * 0.4), 25010, 25010, 25010, 25014, 25018];
  const r = computeIndicators(samplesFrom(series(tail)), A);
  assert.ok(r.ready && r.ups === 3 && r.flats === 2);
  assert.equal(evaluateSignal(r, A).direction, 'NEUTRAL');
});

test('signal: waiting indicators produce NEUTRAL with the waiting reason', () => {
  const s = evaluateSignal(computeIndicators(samplesFrom([25000, 25001]), A), A);
  assert.equal(s.direction, 'NEUTRAL');
  assert.match(s.reason, /Waiting for 61 seconds/);
});

// ── Config ────────────────────────────────────────────────────────────
test('presets: baseline ₹1,000 and Extended Risk ₹2,500, both immutable and paper-only, identical otherwise', () => {
  const [base, ext] = PRESETS;
  assert.equal(base.maxLossPerTrade, 1000);
  assert.equal(ext.name, 'Strategy A — Extended Risk');
  assert.equal(ext.maxLossPerTrade, 2500);
  assert.equal(ext.maxDailyLoss, 3000);
  assert.deepEqual(diffConfig(base, ext), ['maxLossPerTrade']);
  for (const p of PRESETS) {
    assert.equal(p.paperOnly, true); assert.equal(p.immutable, true); assert.ok(Object.isFrozen(p));
    assert.deepEqual(validateConfig(p), []);
  }
  assert.throws(() => { (base as any).maxLossPerTrade = 5000; });
});

test('config: edits create a new version and never mutate the preset; invalid edits are refused', () => {
  const v = deriveVersion(A, { cooldownSec: 90 }, 2);
  assert.equal(v.cooldownSec, 90); assert.equal(A.cooldownSec, 60);
  assert.equal(v.immutable, false); assert.equal(v.parentId, 'strategy-a-baseline'); assert.equal(v.paperOnly, true);
  assert.equal(configKey(v), 'strategy-a-baseline-custom@v2');
  assert.throws(() => deriveVersion(A, { confirmMin: 6 }, 3), /confirmMin/);
  assert.throws(() => deriveVersion(A, { paperOnly: false } as any, 3), /not editable/);
  assert.throws(() => deriveVersion(A, { maxLossPerTrade: 5000 }, 3), /daily loss/);
});
