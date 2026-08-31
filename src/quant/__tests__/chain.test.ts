import { test } from 'node:test';
import assert from 'node:assert/strict';

import { manualChain, normalise, normaliseIv, num, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { DEFAULT_CONFIG, withConfig } from '../config.ts';
import type { ContractSpec, IssueCode } from '../types.ts';

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY',
  lotSize: 75,
  pointValue: 1,
  strikeStep: 50,
  currency: 'INR',
  exerciseStyle: 'european',
  pricingBasis: 'futures',
};

const NOW = Date.parse('2026-08-31T09:30:00Z');
const EXPIRY = Date.parse('2026-09-08T10:00:00Z');

const codes = (issues: { code: IssueCode }[]) => issues.map((i) => i.code);

/* ---------------- coercion ---------------- */

test('num() maps feed junk to null, never to zero', () => {
  assert.equal(num('-'), null);
  assert.equal(num(''), null);
  assert.equal(num('NA'), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(NaN), null);
  assert.equal(num('1,25,300.50'), 125300.5);
  assert.equal(num(0), 0);
});

test('IV scaling handles both percent and decimal feeds', () => {
  assert.equal(normaliseIv(14.2), 0.142);
  assert.equal(normaliseIv('14.2'), 0.142);
  assert.equal(normaliseIv(0.142), 0.142);
  assert.equal(normaliseIv(0), null);
  assert.equal(normaliseIv('-'), null);
});

/* ---------------- normalisation ---------------- */

test('normalise accepts provider variants and rejects unparseable rows', () => {
  const payload: RawChainPayload = {
    source: { providerId: 'test', kind: 'live', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: 25000, futures: 25050, riskFreeRate: 0.065 },
    rows: [
      { right: 'CALL', strike: '25000', expiry: '2026-09-08T10:00:00Z', bid: 120, ask: 121 },
      { right: 'p', strike: 25000, expiry: EXPIRY, bid: 70, ask: 70.5 },
      { right: 'XX', strike: 25000, expiry: EXPIRY },
      { right: 'CE', strike: '-', expiry: EXPIRY },
      { right: 'CE', strike: 25050, expiry: 'not-a-date' },
    ],
  };

  const { chain, rejected } = normalise(payload);
  assert.equal(rejected.length, 3);
  assert.equal(chain.slices.length, 1);
  assert.equal(chain.slices[0].quotes.length, 2);
  assert.deepEqual(
    chain.slices[0].quotes.map((q) => q.right),
    ['CE', 'PE'],
  );
});

test('normalise groups and sorts by expiry then strike', () => {
  const later = EXPIRY + 7 * 86_400_000;
  const { chain } = normalise({
    source: { providerId: 'test', kind: 'eod', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW },
    rows: [
      { right: 'CE', strike: 25200, expiry: later, settle: 40 },
      { right: 'CE', strike: 25000, expiry: EXPIRY, settle: 120 },
      { right: 'CE', strike: 24800, expiry: EXPIRY, settle: 260 },
    ],
  });
  assert.deepEqual(
    chain.slices.map((s) => s.expiry),
    [EXPIRY, later],
  );
  assert.deepEqual(
    chain.slices[0].quotes.map((q) => q.strike),
    [24800, 25000],
  );
});

/* ---------------- synthetic chain builder ---------------- */

/** Builds an internally consistent chain from a vol smile, for enrichment tests. */
function syntheticChain(opts: {
  forward: number;
  strikes: number[];
  smile: (k: number) => number;
  futures?: number | null;
  spot?: number | null;
  spreadPct?: number;
}): RawChainPayload {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const rows = opts.strikes.flatMap((strike) => {
    const vol = opts.smile(strike);
    return (['CE', 'PE'] as const).map((right) => {
      const px = black76({ forward: opts.forward, strike, timeToExpiry: T, vol, rate: r, right }).price;
      const half = (px * (opts.spreadPct ?? 0.004)) / 2;
      return {
        right,
        strike,
        expiry: EXPIRY,
        asOf: NOW,
        bid: Math.max(0.05, px - half),
        ask: px + half,
        last: px,
        openInterest: 25_000,
        volume: 5_000,
      };
    });
  });

  return {
    source: { providerId: 'synthetic', kind: 'live', retrievedAt: NOW },
    contract: NIFTY,
    context: {
      valuationTime: NOW,
      spot: opts.spot === undefined ? opts.forward * 0.999 : opts.spot,
      futures: opts.futures === undefined ? opts.forward : opts.futures,
      riskFreeRate: r,
      dividendYield: 0,
    },
    rows,
  };
}

const STRIKES = Array.from({ length: 21 }, (_, i) => 24500 + i * 50);
const FLAT = () => 0.13;
const PUT_SKEW = (k: number) => 0.13 + Math.max(0, (25000 - k) / 25000) * 0.6;

/* ---------------- enrichment ---------------- */

test('enrichment recovers the input smile from prices alone', () => {
  const { chain } = normalise(syntheticChain({ forward: 25000, strikes: STRIKES, smile: PUT_SKEW }));
  const enriched = enrichChain(chain);

  assert.equal(enriched.slices.length, 1);
  const slice = enriched.slices[0];
  assert.equal(slice.forwardSource, 'futures');
  assert.equal(slice.atmStrike, 25000);

  for (const q of slice.quotes) {
    assert.equal(q.ivSource, 'model', `strike ${q.quote.strike} ${q.quote.right}`);
    assert.ok(
      Math.abs(q.iv! - PUT_SKEW(q.quote.strike)) < 5e-3,
      `IV mismatch at ${q.quote.strike}: got ${q.iv}, want ${PUT_SKEW(q.quote.strike)}`,
    );
    assert.equal(q.greeksSource, 'model');
    assert.ok(q.greeks.gamma! > 0 && q.greeks.vega! > 0 && q.greeks.theta! < 0);
    assert.equal(q.markPriceSource, 'mid');
  }
});

test('calls and puts at the same strike carry opposite delta signs summing to the discount factor', () => {
  const { chain } = normalise(syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT }));
  const slice = enrichChain(chain).slices[0];
  const T = slice.timeToExpiry;
  const df = Math.exp(-0.065 * T);

  for (const k of STRIKES) {
    const c = slice.quotes.find((q) => q.quote.strike === k && q.quote.right === 'CE')!;
    const p = slice.quotes.find((q) => q.quote.strike === k && q.quote.right === 'PE')!;
    assert.ok(Math.abs(c.greeks.delta! - p.greeks.delta! - df) < 1e-6, `strike ${k}`);
    assert.ok(Math.abs(c.greeks.gamma! - p.greeks.gamma!) < 1e-9);
    assert.ok(Math.abs(c.greeks.vega! - p.greeks.vega!) < 1e-6);
  }
});

test('forward falls back to put-call parity when no futures price exists', () => {
  const { chain } = normalise(
    syntheticChain({ forward: 25137.4, strikes: STRIKES, smile: FLAT, futures: null, spot: 25000 }),
  );
  const slice = enrichChain(chain).slices[0];
  assert.equal(slice.forwardSource, 'parity');
  assert.ok(Math.abs(slice.forward - 25137.4) < 0.5, `got ${slice.forward}`);
});

test('spot-carry fallback is used and flagged when parity is impossible', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT, futures: null, spot: 25000 });
  // Strip every put, so no parity pair survives.
  payload.rows = payload.rows.filter((r) => r.right === 'CE');
  const enriched = enrichChain(normalise(payload).chain);
  assert.equal(enriched.slices[0].forwardSource, 'spot-carry');
  assert.ok(codes(enriched.issues).includes('NO_FORWARD_AVAILABLE'));
});

test('crossed quotes are fatal and excluded from the usable set', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  const target = payload.rows.find((r) => r.strike === 25000 && r.right === 'CE')!;
  target.bid = 200;
  target.ask = 100;

  const slice = enrichChain(normalise(payload).chain).slices[0];
  const bad = slice.quotes.find((q) => q.quote.strike === 25000 && q.quote.right === 'CE')!;
  assert.ok(codes(bad.issues).includes('CROSSED_QUOTE'));
  assert.ok(bad.issues.some((i) => i.severity === 'fatal'));
});

test('a quote with no usable price at all is fatal, not silently zero', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  const target = payload.rows.find((r) => r.strike === 25400 && r.right === 'PE')!;
  target.bid = null;
  target.ask = null;
  target.last = null;
  target.settle = null;

  const slice = enrichChain(normalise(payload).chain).slices[0];
  const bad = slice.quotes.find((q) => q.quote.strike === 25400 && q.quote.right === 'PE')!;
  assert.ok(codes(bad.issues).includes('MISSING_PRICE'));
  assert.equal(bad.iv, null);
  assert.equal(bad.ivSource, 'unavailable');
  assert.equal(bad.greeksSource, 'unavailable');
});

test('a settlement price below intrinsic is reported, not fitted', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  const target = payload.rows.find((r) => r.strike === 24500 && r.right === 'CE')!;
  target.bid = 10;
  target.ask = 12; // deep ITM call marked far below intrinsic (~500)
  target.last = 11;

  const slice = enrichChain(normalise(payload).chain).slices[0];
  const bad = slice.quotes.find((q) => q.quote.strike === 24500 && q.quote.right === 'CE')!;
  assert.ok(codes(bad.issues).includes('ARBITRAGE_BOUND_VIOLATION'));
  assert.equal(bad.iv, null);
});

test('wide spreads warn, extreme spreads are fatal', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  const wide = payload.rows.find((r) => r.strike === 25300 && r.right === 'CE')!;
  const mid = Number(wide.last);
  wide.bid = mid * 0.95;
  wide.ask = mid * 1.05; // 10% of mid -> warn

  const extreme = payload.rows.find((r) => r.strike === 25450 && r.right === 'CE')!;
  const m2 = Number(extreme.last);
  extreme.bid = m2 * 0.2;
  extreme.ask = m2 * 1.8; // 160% of mid -> fatal
  extreme.last = null;
  extreme.settle = null;

  const slice = enrichChain(normalise(payload).chain).slices[0];
  const w = slice.quotes.find((q) => q.quote.strike === 25300 && q.quote.right === 'CE')!;
  const e = slice.quotes.find((q) => q.quote.strike === 25450 && q.quote.right === 'CE')!;

  assert.ok(w.issues.some((i) => i.code === 'WIDE_SPREAD' && i.severity === 'warn'));
  assert.ok(e.issues.some((i) => i.code === 'WIDE_SPREAD' && i.severity === 'fatal'));
});

test('provider Greeks are kept alongside model Greeks and divergence is flagged', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  const row = payload.rows.find((r) => r.strike === 25000 && r.right === 'CE')!;
  // A feed that computed delta against spot rather than the forward.
  row.delta = 0.42;
  row.gamma = 0.0004;
  row.theta = -9;
  row.vega = 11;
  row.iv = 13.0;

  const cfg = withConfig({ pricing: { ...DEFAULT_CONFIG.pricing, preferredGreekSource: 'observed' } });
  const slice = enrichChain(normalise(payload).chain, cfg).slices[0];
  const q = slice.quotes.find((x) => x.quote.strike === 25000 && x.quote.right === 'CE')!;

  assert.equal(q.ivSource, 'observed');
  assert.equal(q.greeksSource, 'observed');
  assert.equal(q.greeks.delta, 0.42);
  assert.ok(q.modelGreeks.delta !== null, 'model Greeks still computed');
  assert.notEqual(q.modelGreeks.delta, 0.42);
  assert.ok(codes(q.issues).includes('OBSERVED_MODEL_GREEK_DIVERGENCE'));
});

test('stale quotes are flagged on live feeds', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  payload.rows.find((r) => r.strike === 25500 && r.right === 'CE')!.asOf = NOW - 20 * 60_000;
  const slice = enrichChain(normalise(payload).chain).slices[0];
  const q = slice.quotes.find((x) => x.quote.strike === 25500 && x.quote.right === 'CE')!;
  assert.ok(codes(q.issues).includes('STALE_QUOTE'));
});

test('off-grid strikes and zero liquidity are flagged', () => {
  const payload = syntheticChain({ forward: 25000, strikes: [24975, ...STRIKES], smile: FLAT });
  for (const r of payload.rows) {
    if (r.strike === 24975) {
      r.openInterest = 0;
      r.volume = 0;
    }
  }
  const slice = enrichChain(normalise(payload).chain).slices[0];
  const q = slice.quotes.find((x) => x.quote.strike === 24975)!;
  assert.ok(codes(q.issues).includes('OFF_GRID_STRIKE'));
  assert.ok(codes(q.issues).includes('ZERO_OPEN_INTEREST'));
  assert.ok(codes(q.issues).includes('ZERO_VOLUME'));
});

test('an invalid lot size is fatal at chain level', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  payload.contract = { ...NIFTY, lotSize: 0 };
  const enriched = enrichChain(normalise(payload).chain);
  assert.ok(enriched.issues.some((i) => i.code === 'INVALID_LOT_SIZE' && i.severity === 'fatal'));
});

test('an expiry in the past is fatal', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  for (const r of payload.rows) r.expiry = NOW - 86_400_000;
  const enriched = enrichChain(normalise(payload).chain);
  assert.ok(enriched.issues.some((i) => i.code === 'EXPIRY_IN_PAST' && i.severity === 'fatal'));
});

/* ---------------- manual mode ---------------- */

test('a two-leg manual chain prices but is marked unfit for strike selection', () => {
  const T = yearFraction(NOW, EXPIRY);
  const cPx = black76({ forward: 25000, strike: 25000, timeToExpiry: T, vol: 0.13, rate: 0.065, right: 'CE' }).price;
  const pPx = black76({ forward: 25000, strike: 25000, timeToExpiry: T, vol: 0.13, rate: 0.065, right: 'PE' }).price;

  const { chain } = manualChain({
    contract: NIFTY,
    expiry: EXPIRY,
    valuationTime: NOW,
    futures: 25000,
    riskFreeRate: 0.065,
    legs: [
      { right: 'CE', strike: 25000, bid: cPx - 1, ask: cPx + 1 },
      { right: 'PE', strike: 25000, bid: pPx - 1, ask: pPx + 1 },
    ],
  });

  assert.match(chain.source.note ?? '', /NOT for strike-level selection/);

  const enriched = enrichChain(chain);
  const slice = enriched.slices[0];
  assert.ok(Math.abs(slice.quotes[0].iv! - 0.13) < 0.01);
  assert.ok(
    enriched.issues.some((i) => i.code === 'SPARSE_CHAIN'),
    'engine must know it cannot select strikes from one strike',
  );
});

test('0 DTE chain enriches without infinities', () => {
  const payload = syntheticChain({ forward: 25000, strikes: STRIKES, smile: FLAT });
  for (const r of payload.rows) r.expiry = NOW;
  const enriched = enrichChain(normalise(payload).chain);
  const slice = enriched.slices[0];
  assert.equal(slice.timeToExpiry, 0);
  for (const q of slice.quotes) {
    for (const v of Object.values(q.greeks)) {
      assert.ok(v === null || Number.isFinite(v), `non-finite Greek at ${q.quote.strike}`);
    }
  }
});
