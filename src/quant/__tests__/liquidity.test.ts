import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLegLiquidity, classifyStrategyLiquidity } from '../analytics/liquidity.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { EnrichedQuote } from '../types.ts';

const EMPTY_GREEKS = { delta: null, gamma: null, theta: null, vega: null, rho: null };

/** A minimal, otherwise-healthy EnrichedQuote fixture — each test overrides only what it's testing. */
function quote(overrides: {
  openInterest?: number | null;
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  spread?: number | null;
}): EnrichedQuote {
  const bid = overrides.bid ?? 100;
  const ask = overrides.ask ?? 102;
  return {
    quote: {
      symbol: 'NIFTY', right: 'CE', strike: 25000, expiry: 0, asOf: 0,
      bid, ask, last: (bid + ask) / 2, settle: null,
      openInterest: overrides.openInterest ?? 50_000,
      oiChange: null,
      volume: overrides.volume ?? 20_000,
      observedIv: null, observedGreeks: { ...EMPTY_GREEKS },
    },
    mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
    spread: overrides.spread !== undefined ? overrides.spread : (bid > 0 && ask > 0 ? ask - bid : null),
    spreadPct: overrides.spreadPct !== undefined ? overrides.spreadPct
      : (bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) : null),
    markPrice: 101, markPriceSource: 'mid',
    timeToExpiry: 0.05,
    iv: 0.12, ivSource: 'model',
    greeks: { ...EMPTY_GREEKS }, greeksSource: 'model',
    modelGreeks: { ...EMPTY_GREEKS },
    logMoneyness: 0, distanceFromForward: 0,
    issues: [],
  };
}

test('a healthy, comfortably-above-threshold quote classifies LIQUID', () => {
  const q = quote({ openInterest: 100_000, volume: 50_000, bid: 100, ask: 100.4 }); // 0.4% spread
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'LIQUID');
  assert.deepEqual(result.reasons, []);
});

test('zero OI and zero volume together is UNTRADABLE regardless of spread', () => {
  // The exact real candidate the diagnostics surfaced: 0 OI, 0 volume, 17.9% spread.
  const q = quote({ openInterest: 0, volume: 0, spreadPct: 0.179 });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'UNTRADABLE');
  assert.ok(result.reasons.some((r) => r.includes('zero open interest and zero volume')));
});

test('a spread at or beyond the fatal threshold is UNTRADABLE even with healthy OI/volume', () => {
  const q = quote({ openInterest: 100_000, volume: 50_000, spreadPct: DEFAULT_CONFIG.dataQuality.fatalSpreadPct });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'UNTRADABLE');
});

test('OI below the minimum (but not zero, and no zero volume) is POOR, not UNTRADABLE', () => {
  const q = quote({ openInterest: DEFAULT_CONFIG.dataQuality.minOpenInterest - 1, volume: 10_000 });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'POOR');
});

test('volume below the minimum is POOR, not UNTRADABLE', () => {
  const q = quote({ openInterest: 100_000, volume: DEFAULT_CONFIG.dataQuality.minVolume - 1 });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'POOR');
});

test('spread above the acceptable-but-below-fatal threshold is POOR', () => {
  const midway = (DEFAULT_CONFIG.dataQuality.maxSpreadPct + DEFAULT_CONFIG.dataQuality.fatalSpreadPct) / 2;
  const q = quote({ openInterest: 100_000, volume: 50_000, spreadPct: midway });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'POOR');
});

test('missing bid/ask (EOD/bhavcopy data) with healthy OI/volume is ACCEPTABLE, never UNTRADABLE or LIQUID', () => {
  const q = quote({ openInterest: 100_000, volume: 50_000, bid: null, ask: null, spreadPct: null, spread: null });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'ACCEPTABLE');
  assert.ok(result.reasons.some((r) => r.includes('no live bid/ask')));
});

test('healthy OI/volume with a quoted-but-not-comfortably-tight spread is ACCEPTABLE, not LIQUID', () => {
  const q = quote({ openInterest: 100_000, volume: 50_000, spreadPct: DEFAULT_CONFIG.dataQuality.maxSpreadPct * 0.9 });
  const result = classifyLegLiquidity(q);
  assert.equal(result.tier, 'ACCEPTABLE');
});

test('classifyStrategyLiquidity takes the worst tier across all legs', () => {
  const good = classifyLegLiquidity(quote({ openInterest: 100_000, volume: 50_000, bid: 100, ask: 100.4 }));
  const untradable = classifyLegLiquidity(quote({ openInterest: 0, volume: 0 }));
  const strategy = classifyStrategyLiquidity([good, untradable]);
  assert.equal(strategy.tier, 'UNTRADABLE');
  assert.ok(strategy.blockingReasons.length > 0);
});

test('classifyStrategyLiquidity reports no blocking reasons when the tier is not UNTRADABLE', () => {
  const good = classifyLegLiquidity(quote({ openInterest: 100_000, volume: 50_000, bid: 100, ask: 100.4 }));
  const poor = classifyLegLiquidity(quote({ openInterest: 10, volume: 5 }));
  const strategy = classifyStrategyLiquidity([good, poor]);
  assert.equal(strategy.tier, 'POOR');
  assert.deepEqual(strategy.blockingReasons, []);
});
