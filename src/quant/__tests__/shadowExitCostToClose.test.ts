import { test } from 'node:test';
import assert from 'node:assert/strict';

import { simulateShadowExitFills, type ShadowExitLegWithSymbol } from '../execution/shadowScan.ts';
import type { RawKiteQuote } from '../execution/shadowExecution.ts';

/**
 * Forward-validation readiness phase, Task 3 (correctness prerequisite for
 * "one canonical net-P&L equation"): a worked numeric proof that
 * simulateShadowExitFills' costToClose is a POSITIVE number when closing
 * the structure is genuinely expensive (deep in max-loss territory), and
 * near-zero when the structure is worthless to close (near max profit) —
 * NOT the inverted sign the pre-fix code produced (see shadowScan.ts's own
 * comment at the fix site for the full derivation).
 *
 * Iron condor: short 24000PE (credit 60), long 23500PE (debit 20),
 * short 25500CE (credit 55), long 26000CE (debit 18). netCredit = 77/unit,
 * quantity 75 (one NIFTY lot) => maxProfit = 5775.
 */
const LOT = 75;
function legs(prices: [number, number, number, number]): ShadowExitLegWithSymbol[] {
  // `price` is this leg's own decision-time mark at CLOSE time (what
  // midOrLastPrice(quoteMap...) would return in the real code, see
  // api/options-autotrade.ts's own SHADOW exit branch) — simulateFill's
  // decisionPrice comes from this field, NOT from bid/ask, so it must
  // match the quote passed in below for the fill-simulation math to be
  // meaningful (a stale/zero reference price would silently zero out the
  // whole cost-to-close calculation, which is exactly the mistake a first
  // draft of this test made).
  return [
    { side: 'SELL', right: 'PE', strike: 24000, price: prices[0], entryFillPrice: 60, quantity: LOT, tradingsymbol: 'NIFTY24000PE' },
    { side: 'BUY', right: 'PE', strike: 23500, price: prices[1], entryFillPrice: 20, quantity: LOT, tradingsymbol: 'NIFTY23500PE' },
    { side: 'SELL', right: 'CE', strike: 25500, price: prices[2], entryFillPrice: 55, quantity: LOT, tradingsymbol: 'NIFTY25500CE' },
    { side: 'BUY', right: 'CE', strike: 26000, price: prices[3], entryFillPrice: 18, quantity: LOT, tradingsymbol: 'NIFTY26000CE' },
  ];
}
const MAX_PROFIT = (60 - 20 + 55 - 18) * LOT; // 5775

function ideal(price: number): RawKiteQuote {
  // IDEAL-shaped quote (zero spread) so this test isolates the sign
  // convention itself, not REALISTIC's spread-fraction slippage.
  return { last_price: price, oi: 5000, volume: 1000, depth: { buy: [{ price }], sell: [{ price }] } };
}

test('costToClose is a large POSITIVE cost when the structure is deep in max-loss territory (call side breached)', () => {
  // Spot far past both call strikes: short call deep ITM (~700), long call
  // less ITM (~200); both puts worthless.
  const quoteMap = new Map<string, RawKiteQuote>([
    ['NFO:NIFTY24000PE', ideal(0.5)],
    ['NFO:NIFTY23500PE', ideal(0.5)],
    ['NFO:NIFTY25500CE', ideal(700)],
    ['NFO:NIFTY26000CE', ideal(200)],
  ]);
  const result = simulateShadowExitFills({ legs: legs([0.5, 0.5, 700, 200]), quoteMap, exchange: 'NFO' });
  assert.equal(result.status, 'FILLED');
  if (result.status !== 'FILLED') return;

  // Buying back the short call costs 700*75; selling the long call
  // recovers 200*75; the worthless put leg pair nets to ~0.
  const expectedCostToClose = (700 - 200) * LOT + (0.5 - 0.5) * LOT; // = 37500
  assert.ok(result.costToClose > 0, `costToClose must be positive (a real cost) when deep in max-loss territory, got ${result.costToClose}`);
  assert.ok(Math.abs(result.costToClose - expectedCostToClose) < 1, `expected costToClose ~= ${expectedCostToClose}, got ${result.costToClose}`);

  const realizedPnl = MAX_PROFIT - result.costToClose;
  // Max loss for this structure is (wingWidth - netCredit) * lot = (500-77)*75 = 31725.
  const maxLoss = (500 - 77) * LOT;
  assert.ok(realizedPnl < 0, `realizedPnl must be negative near max-loss territory, got ${realizedPnl}`);
  assert.ok(Math.abs(realizedPnl - -maxLoss) < LOT * 5, `realizedPnl (${realizedPnl}) should land close to -maxLoss (${-maxLoss})`);
});

test('costToClose is near zero when every leg is worthless (structure decayed to near-max-profit)', () => {
  const quoteMap = new Map<string, RawKiteQuote>([
    ['NFO:NIFTY24000PE', ideal(0.5)],
    ['NFO:NIFTY23500PE', ideal(0.5)],
    ['NFO:NIFTY25500CE', ideal(0.5)],
    ['NFO:NIFTY26000CE', ideal(0.5)],
  ]);
  const result = simulateShadowExitFills({ legs: legs([0.5, 0.5, 0.5, 0.5]), quoteMap, exchange: 'NFO' });
  assert.equal(result.status, 'FILLED');
  if (result.status !== 'FILLED') return;
  assert.ok(Math.abs(result.costToClose) < 1, `costToClose should be ~0 when every leg is worthless, got ${result.costToClose}`);
  const realizedPnl = MAX_PROFIT - result.costToClose;
  assert.ok(realizedPnl > MAX_PROFIT * 0.98, `realizedPnl (${realizedPnl}) should land near maxProfit (${MAX_PROFIT})`);
});

test('a payoff-curve sweep never shows realizedPnl exceeding maxProfit by more than a rounding margin, at any spot price', () => {
  // Independent numerical check across a spot sweep, same discipline as
  // ironCondor.test.ts's own payoff-curve invariant test: realizedPnl
  // (maxProfit - costToClose) must never exceed maxProfit (you cannot make
  // MORE than the net credit collected, since every leg's intrinsic value
  // is >= 0) and must never fall below -maxLoss by more than a small
  // extrinsic-value margin.
  const wingWidth = 500;
  const netCredit = 77;
  const maxLoss = (wingWidth - netCredit) * LOT;
  for (let spot = 23000; spot <= 27000; spot += 250) {
    const putShortIntrinsic = Math.max(0, 24000 - spot);
    const putLongIntrinsic = Math.max(0, 23500 - spot);
    const callShortIntrinsic = Math.max(0, spot - 25500);
    const callLongIntrinsic = Math.max(0, spot - 26000);
    const quoteMap = new Map<string, RawKiteQuote>([
      ['NFO:NIFTY24000PE', ideal(Math.max(0.05, putShortIntrinsic))],
      ['NFO:NIFTY23500PE', ideal(Math.max(0.05, putLongIntrinsic))],
      ['NFO:NIFTY25500CE', ideal(Math.max(0.05, callShortIntrinsic))],
      ['NFO:NIFTY26000CE', ideal(Math.max(0.05, callLongIntrinsic))],
    ]);
    const result = simulateShadowExitFills({
      legs: legs([
        Math.max(0.05, putShortIntrinsic), Math.max(0.05, putLongIntrinsic),
        Math.max(0.05, callShortIntrinsic), Math.max(0.05, callLongIntrinsic),
      ]),
      quoteMap, exchange: 'NFO',
    });
    assert.equal(result.status, 'FILLED');
    if (result.status !== 'FILLED') continue;
    const realizedPnl = MAX_PROFIT - result.costToClose;
    assert.ok(realizedPnl <= MAX_PROFIT + 1, `spot=${spot}: realizedPnl (${realizedPnl}) must never exceed maxProfit (${MAX_PROFIT})`);
    assert.ok(realizedPnl >= -maxLoss - 1, `spot=${spot}: realizedPnl (${realizedPnl}) must never fall below -maxLoss (${-maxLoss})`);
  }
});
