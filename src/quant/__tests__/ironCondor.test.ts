import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { buildIronCondor, isIronCondorFailure } from '../strategies/ironCondor.ts';
import type { ContractSpec } from '../types.ts';

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
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);

/** A flat-smile settlement-only chain, matching the shape real bhavcopy data
    takes: settle price and OI, no bid/ask, no provider IV or Greeks. */
function bhavcopyLikeChain(vol: number): RawChainPayload {
  const T = yearFraction(NOW, EXPIRY);
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => ({
      right,
      strike,
      expiry: EXPIRY,
      asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest: 50_000,
    })),
  );
  return {
    source: { providerId: 'test-bhavcopy', kind: 'eod', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: r, dividendYield: 0 },
    rows,
  };
}

test('builds a real Iron Condor from settlement-only data with sane, internally consistent numbers', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });

  assert.ok(!isIronCondorFailure(result), (result as { reason: string }).reason);
  if (isIronCondorFailure(result)) return;

  assert.equal(result.legs.length, 4);
  const sides = result.legs.map((l) => `${l.side}:${l.right}`).sort();
  assert.deepEqual(sides, ['BUY:CE', 'BUY:PE', 'SELL:CE', 'SELL:PE']);

  // Short strikes should sit on the correct side of the forward.
  const shortCall = result.legs.find((l) => l.side === 'SELL' && l.right === 'CE')!;
  const shortPut = result.legs.find((l) => l.side === 'SELL' && l.right === 'PE')!;
  assert.ok(shortCall.strike > result.forward);
  assert.ok(shortPut.strike < result.forward);
  // And their delta should be reasonably close to the requested 0.16 target —
  // this is the whole point: strikes chosen by Greek, not by fixed distance.
  assert.ok(Math.abs(Math.abs(shortCall.delta!) - 0.16) < 0.05, `call delta ${shortCall.delta}`);
  assert.ok(Math.abs(Math.abs(shortPut.delta!) - 0.16) < 0.05, `put delta ${shortPut.delta}`);

  // Risk numbers must be internally consistent, not just plausible-looking.
  assert.ok(result.netCredit > 0);
  assert.ok(result.maxProfit > 0 && result.maxLoss > 0);
  assert.ok(Math.abs(result.maxProfit - result.netCredit * 75) < 1e-6);

  // maxLoss is the WORSE side's own width, minus the TOTAL net credit (both
  // sides) — never just that side's own credit. Only one side can ever be
  // breached at expiry; the untested side always expires worthless and its
  // full credit is retained regardless of which side breaches, so the loss
  // on a breach is width_side - netCredit, not width_side - credit_side.
  // See QUANT_AUDIT.md and ironCondor.test.ts's dedicated max-loss suite
  // below for the full derivation and numeric worked examples.
  const longCall = result.legs.find((l) => l.side === 'BUY' && l.right === 'CE')!;
  const longPut = result.legs.find((l) => l.side === 'BUY' && l.right === 'PE')!;
  const callWidth = longCall.strike - shortCall.strike;
  const putWidth = shortPut.strike - longPut.strike;
  const expectedMaxLossPerUnit = Math.max(callWidth, putWidth) - result.netCredit;
  assert.ok(
    Math.abs(result.maxLoss / 75 - expectedMaxLossPerUnit) < 1e-6,
    `maxLoss/lot=${result.maxLoss / 75} vs ${expectedMaxLossPerUnit}`,
  );
  assert.ok(result.breakevens[0] < shortPut.strike);
  assert.ok(result.breakevens[1] > shortCall.strike);

  // Short options dominate a condor's net Greeks: negative delta-neutral-ish,
  // positive theta (collecting time decay), negative vega (short volatility).
  assert.ok(result.netGreeks.theta! > 0, `theta should be positive, got ${result.netGreeks.theta}`);
  assert.ok(result.netGreeks.vega! < 0, `vega should be negative, got ${result.netGreeks.vega}`);
  assert.ok(Math.abs(result.netGreeks.delta!) < 0.5, `net delta should be roughly neutral, got ${result.netGreeks.delta}`);

  assert.ok(result.pop !== null && result.pop > 0 && result.pop < 1);
});

test('refuses to build a condor when the requested wing has no usable quote', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  // A wing far wider than the strike grid covers.
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 50_000, lotSize: 75 });
  assert.ok(isIronCondorFailure(result));
  assert.match((result as { reason: string }).reason, /no usable quote/i);
});

test('entryPriceOverride swaps in a different tradeable price without touching strike/delta selection', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const base = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });
  assert.ok(!isIronCondorFailure(base), (base as { reason: string }).reason);
  if (isIronCondorFailure(base)) return;

  // A distinct "entry price" per leg — scaled rather than shifted by a flat
  // amount, since a flat offset cancels exactly across a symmetric condor's
  // four legs (short/long on each side sum to zero net offset). Standing in
  // for e.g. a session-open print that differs from the settlement price
  // used to select strikes in the first place.
  const overridden = buildIronCondor(slice, {
    targetShortDelta: 0.16, wingWidth: 500, lotSize: 75,
    entryPriceOverride: (strike, right) => {
      const q = slice.quotes.find((x) => x.quote.strike === strike && x.quote.right === right);
      return q?.markPrice != null ? q.markPrice * 1.1 : null;
    },
  });
  assert.ok(!isIronCondorFailure(overridden), (overridden as { reason: string }).reason);
  if (isIronCondorFailure(overridden)) return;

  // Same strikes chosen either way — the override only swaps price, not selection.
  assert.deepEqual(base.legs.map((l) => `${l.side}:${l.strike}:${l.right}`).sort(),
    overridden.legs.map((l) => `${l.side}:${l.strike}:${l.right}`).sort());
  // But the dollar figures must actually reflect the overridden price, not
  // the settlement price used for selection.
  for (const leg of overridden.legs) assert.ok(leg.price > 1);
  assert.notEqual(overridden.netCredit, base.netCredit);
});

test('entryPriceOverride returning null for a selected strike is refused, not mixed with settlement price', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, {
    targetShortDelta: 0.16, wingWidth: 500, lotSize: 75,
    entryPriceOverride: () => null,
  });
  assert.ok(isIronCondorFailure(result));
  assert.match((result as { reason: string }).reason, /no tradeable entry price/i);
});

test('a sparse chain with no OTM strikes on one side is refused, not guessed at', () => {
  const payload = bhavcopyLikeChain(0.13);
  payload.rows = payload.rows.filter((r) => !(r.right === 'PE' && (r.strike as number) < FORWARD));
  const { chain } = normalise(payload);
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 500, lotSize: 75 });
  assert.ok(isIronCondorFailure(result));
});

/* ------------------------------------------------------------------ *
 * Dedicated max-loss regression suite.
 *
 * QUANT_AUDIT.md finding: buildIronCondor used to compute
 *   maxLossPerUnit = max(callWidth - callCredit, putWidth - putCredit)
 * which subtracts only ONE side's own credit instead of the TOTAL net
 * credit — overstating max loss on both sides by the other side's credit,
 * since only one side can ever be breached at expiry and the untested
 * side's full credit is always retained. Corrected formula:
 *   maxLossPerUnit = max(callWidth, putWidth) - netCredit
 * These tests pin the corrected formula down two independent ways: (1) an
 * exact worked numeric example with entryPriceOverride forcing known
 * credits, and (2) a payoff-curve invariant that computes the actual
 * expiration P&L at many spot prices from first principles (no
 * dependency on ironCondor.ts's own formula) and asserts the reported
 * maxLoss equals the worst of those, independently of any formula.
 * ------------------------------------------------------------------ */

/** Learns which strikes buildIronCondor selects for a given delta/wing
    config, then rebuilds with entryPriceOverride forcing EXACT known
    prices at those four strikes — so the numeric example is pinned to
    real strikes this engine would actually select, not invented ones. */
function buildWithExactPrices(
  targetShortDelta: number,
  wingWidth: number,
  prices: { shortCall: number; longCall: number; shortPut: number; longPut: number },
  lotSize = 1,
) {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const discovery = buildIronCondor(slice, { targetShortDelta, wingWidth, lotSize });
  assert.ok(!isIronCondorFailure(discovery), (discovery as { reason: string }).reason);
  if (isIronCondorFailure(discovery)) throw new Error('unreachable');

  const strikeFor = (side: 'BUY' | 'SELL', right: 'CE' | 'PE') =>
    discovery.legs.find((l) => l.side === side && l.right === right)!.strike;
  const scStrike = strikeFor('SELL', 'CE'), lcStrike = strikeFor('BUY', 'CE');
  const spStrike = strikeFor('SELL', 'PE'), lpStrike = strikeFor('BUY', 'PE');

  const result = buildIronCondor(slice, {
    targetShortDelta, wingWidth, lotSize,
    entryPriceOverride: (strike, right) => {
      if (strike === scStrike && right === 'CE') return prices.shortCall;
      if (strike === lcStrike && right === 'CE') return prices.longCall;
      if (strike === spStrike && right === 'PE') return prices.shortPut;
      if (strike === lpStrike && right === 'PE') return prices.longPut;
      return null;
    },
  });
  assert.ok(!isIronCondorFailure(result), (result as { reason: string }).reason);
  if (isIronCondorFailure(result)) throw new Error('unreachable');
  return { result, scStrike, lcStrike, spStrike, lpStrike, callWidth: lcStrike - scStrike, putWidth: spStrike - lpStrike };
}

test('max loss: exact worked example — callWidth=200 putWidth=200 callCredit=30 putCredit=40 -> maxProfit=70 maxLoss=130', () => {
  // wingWidth=200 lands exactly on the 100-pt strike grid used by this
  // fixture, so both wings really are 200 pts wide, not approximately.
  const { result, callWidth, putWidth } = buildWithExactPrices(0.16, 200, {
    shortCall: 50, longCall: 20, // callCredit = 30
    shortPut: 60, longPut: 20,   // putCredit = 40
  });
  assert.equal(callWidth, 200);
  assert.equal(putWidth, 200);
  assert.ok(Math.abs(result.netCredit - 70) < 1e-9, `netCredit=${result.netCredit}`);
  assert.ok(Math.abs(result.maxProfit - 70) < 1e-9, `maxProfit=${result.maxProfit}`);
  assert.ok(Math.abs(result.maxLoss - 130) < 1e-9, `maxLoss=${result.maxLoss}`);
});

test('max loss: very small net credit still uses TOTAL credit, not one side\'s', () => {
  const { result } = buildWithExactPrices(0.16, 200, {
    shortCall: 21, longCall: 20, // callCredit = 1
    shortPut: 21, longPut: 20,   // putCredit = 1
  });
  // netCredit = 2, width = 200 -> maxLoss = 198, NOT max(200-1,200-1)=199.
  assert.ok(Math.abs(result.netCredit - 2) < 1e-9);
  assert.ok(Math.abs(result.maxLoss - 198) < 1e-9, `maxLoss=${result.maxLoss}`);
});

test('max loss: large but valid credit (large relative to width) scales correctly', () => {
  const { result } = buildWithExactPrices(0.16, 200, {
    shortCall: 90, longCall: 10, // callCredit = 80
    shortPut: 85, longPut: 10,   // putCredit = 75
  });
  // netCredit = 155, width = 200 -> maxLoss = 45.
  assert.ok(Math.abs(result.netCredit - 155) < 1e-9);
  assert.ok(Math.abs(result.maxLoss - 45) < 1e-9, `maxLoss=${result.maxLoss}`);
});

test('max loss: asymmetric call/put credit split (same widths, different per-side credit) is still netCredit-based', () => {
  // Different credits on each side, deliberately far apart, to make sure
  // the formula truly nets BOTH sides rather than picking one.
  const { result } = buildWithExactPrices(0.16, 300, {
    shortCall: 15, longCall: 5,  // callCredit = 10
    shortPut: 55, longPut: 5,    // putCredit = 50
  });
  // netCredit = 60, width = 300 -> maxLoss = 240. The old buggy formula
  // would have reported max(300-10, 300-50) = 290.
  assert.ok(Math.abs(result.netCredit - 60) < 1e-9);
  assert.ok(Math.abs(result.maxLoss - 240) < 1e-9, `maxLoss=${result.maxLoss}, expected 240 (old buggy formula would give 290)`);
});

test('rejects zero wing width rather than pricing a collapsed structure', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 0, lotSize: 75 });
  assert.ok(isIronCondorFailure(result));
});

test('rejects negative wing width rather than pricing an inverted structure', () => {
  const { chain } = normalise(bhavcopyLikeChain(0.13));
  const slice = enrichChain(chain).slices[0];
  const result = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: -100, lotSize: 75 });
  assert.ok(isIronCondorFailure(result));
});

test('rejects non-positive net credit rather than reporting a negative-cost trade', () => {
  const { result } = (() => {
    const { chain } = normalise(bhavcopyLikeChain(0.13));
    const slice = enrichChain(chain).slices[0];
    const discovery = buildIronCondor(slice, { targetShortDelta: 0.16, wingWidth: 200, lotSize: 1 });
    assert.ok(!isIronCondorFailure(discovery));
    if (isIronCondorFailure(discovery)) throw new Error('unreachable');
    const scStrike = discovery.legs.find((l) => l.side === 'SELL' && l.right === 'CE')!.strike;
    const lcStrike = discovery.legs.find((l) => l.side === 'BUY' && l.right === 'CE')!.strike;
    const spStrike = discovery.legs.find((l) => l.side === 'SELL' && l.right === 'PE')!.strike;
    const lpStrike = discovery.legs.find((l) => l.side === 'BUY' && l.right === 'PE')!.strike;
    return {
      result: buildIronCondor(slice, {
        targetShortDelta: 0.16, wingWidth: 200, lotSize: 1,
        // Long legs priced ABOVE their short legs -> negative net credit.
        entryPriceOverride: (strike, right) => {
          if (strike === scStrike && right === 'CE') return 10;
          if (strike === lcStrike && right === 'CE') return 20;
          if (strike === spStrike && right === 'PE') return 10;
          if (strike === lpStrike && right === 'PE') return 20;
          return null;
        },
      }),
    };
  })();
  assert.ok(isIronCondorFailure(result));
  assert.match((result as { reason: string }).reason, /net credit/i);
});

/**
 * The property test: independently compute the ACTUAL expiration P&L
 * curve from first principles (no dependency on ironCondor.ts's own
 * maxLoss formula) across a wide spot grid spanning far below the long
 * put to far above the long call, and assert the reported maxLoss equals
 * the worst point on that curve. This is what actually proves the fix
 * correct, independent of any one hand-derived formula.
 */
function intrinsic(right: 'CE' | 'PE', strike: number, spot: number): number {
  return right === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

test('max loss invariant: reported maxLoss equals the worst point on the actual expiration payoff curve', () => {
  const cases: Array<{ wingWidth: number; shortCall: number; longCall: number; shortPut: number; longPut: number }> = [
    { wingWidth: 200, shortCall: 50, longCall: 20, shortPut: 60, longPut: 20 }, // the worked example
    { wingWidth: 200, shortCall: 21, longCall: 20, shortPut: 21, longPut: 20 }, // tiny credit
    { wingWidth: 200, shortCall: 90, longCall: 10, shortPut: 85, longPut: 10 }, // large credit
    { wingWidth: 300, shortCall: 15, longCall: 5, shortPut: 55, longPut: 5 },   // asymmetric credit split
    { wingWidth: 400, shortCall: 35, longCall: 15, shortPut: 30, longPut: 5 },  // another independent config
  ];

  for (const c of cases) {
    const { result, scStrike, lcStrike, spStrike, lpStrike } = buildWithExactPrices(0.16, c.wingWidth, {
      shortCall: c.shortCall, longCall: c.longCall, shortPut: c.shortPut, longPut: c.longPut,
    }, 1);

    const legs = [
      { side: 'SELL' as const, right: 'PE' as const, strike: spStrike },
      { side: 'BUY' as const, right: 'PE' as const, strike: lpStrike },
      { side: 'SELL' as const, right: 'CE' as const, strike: scStrike },
      { side: 'BUY' as const, right: 'CE' as const, strike: lcStrike },
    ];

    // Far below the long put to far above the long call, fine-grained,
    // plus the exact strikes themselves (the curve's kink points, where a
    // coarse grid could miss the true extremum).
    const lo = lpStrike - 500, hi = lcStrike + 500;
    const grid = new Set<number>([spStrike, lpStrike, scStrike, lcStrike]);
    for (let s = lo; s <= hi; s += 5) grid.add(s);

    let worstPnl = Infinity;
    for (const spot of grid) {
      // P&L(spot) = netCredit collected at entry, plus/minus each leg's
      // own expiration payoff (SELL: you owe the intrinsic; BUY: you
      // receive it) — computed with ZERO reference to maxLoss/maxProfit.
      let pnl = result.netCredit;
      for (const leg of legs) {
        const dir = leg.side === 'BUY' ? 1 : -1;
        pnl += dir * intrinsic(leg.right, leg.strike, spot);
      }
      worstPnl = Math.min(worstPnl, pnl);
    }

    assert.ok(
      Math.abs(result.maxLoss - -worstPnl) < 1e-6,
      `wingWidth=${c.wingWidth}: reported maxLoss=${result.maxLoss}, worst payoff-curve loss=${-worstPnl}`,
    );
  }
});
