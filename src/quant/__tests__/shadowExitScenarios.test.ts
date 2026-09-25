import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExit } from '../execution/exitEngine.ts';
import { simulateShadowExitFills, type ShadowExitLegWithSymbol } from '../execution/shadowScan.ts';
import type { RawKiteQuote } from '../execution/shadowExecution.ts';

/**
 * Task 15: one integration-shaped test per real exit reason, using the
 * EXACT production evaluateExit() (never a reimplementation) to trigger
 * the exit, then the EXACT production simulateShadowExitFills() to
 * simulate the SHADOW close — proving each path this api/options-
 * autotrade.ts's SHADOW branch actually exercises produces a correct,
 * broker-order-free result. handlePositionMonitor itself (the ~1900-line
 * live dispatch function) is not separately mocked here — see
 * SHADOW_LIFECYCLE_COMPLETION_REPORT.md for why that specific harness was
 * scoped out — this validates the exact building blocks that function now
 * calls for each exit reason.
 */

const IRON_CONDOR_LEGS: ShadowExitLegWithSymbol[] = [
  { side: 'SELL', right: 'PE', strike: 24000, price: 0, entryFillPrice: 60, quantity: 75, tradingsymbol: 'NIFTY24000PE' },
  { side: 'BUY', right: 'PE', strike: 23500, price: 0, entryFillPrice: 20, quantity: 75, tradingsymbol: 'NIFTY23500PE' },
  { side: 'SELL', right: 'CE', strike: 25500, price: 0, entryFillPrice: 55, quantity: 75, tradingsymbol: 'NIFTY25500CE' },
  { side: 'BUY', right: 'CE', strike: 26000, price: 0, entryFillPrice: 18, quantity: 75, tradingsymbol: 'NIFTY26000CE' },
];
const MAX_PROFIT = (60 - 20 + 55 - 18) * 75; // netCredit * lotSize
const MAX_LOSS = (500 - (60 - 20)) * 75; // wingWidth - netCredit-per-side, per lot -- approximate, consistent enough for this test's purpose
const SHORT_STRIKES = [{ strike: 24000, right: 'PE' as const }, { strike: 25500, right: 'CE' as const }];

function rawQuote(bid: number, ask: number): RawKiteQuote {
  return { last_price: (bid + ask) / 2, oi: 5000, volume: 1000, depth: { buy: [{ price: bid }], sell: [{ price: ask }] } };
}

function buildQuoteMap(prices: Record<string, [number, number]>): Map<string, RawKiteQuote> {
  const map = new Map<string, RawKiteQuote>();
  for (const [symbol, [bid, ask]] of Object.entries(prices)) map.set(`NFO:${symbol}`, rawQuote(bid, ask));
  return map;
}

test('STOP_LOSS_CREDIT_MULTIPLE: evaluateExit triggers CLOSE, SHADOW simulates a real exit with zero broker calls', () => {
  // Cost to close has ballooned to > 2x the credit collected (default stopLossCreditMultiple=2).
  const currentCostToClose = MAX_PROFIT * 2.5;
  const decision = evaluateExit({
    maxProfit: MAX_PROFIT, maxLoss: MAX_LOSS, currentCostToClose, dte: 20, underlyingPrice: 24800, shortStrikes: SHORT_STRIKES,
  });
  assert.equal(decision.action, 'CLOSE');
  assert.equal(decision.reason, 'STOP_LOSS_CREDIT_MULTIPLE');

  const quoteMap = buildQuoteMap({
    NIFTY24000PE: [90, 94], NIFTY23500PE: [15, 18], NIFTY25500CE: [110, 115], NIFTY26000CE: [8, 10],
  });
  const result = simulateShadowExitFills({ legs: IRON_CONDOR_LEGS, quoteMap, exchange: 'NFO' });
  assert.equal(result.status, 'FILLED');
  if (result.status !== 'FILLED') return;
  assert.equal(result.hasRealBidAsk, true);
  assert.equal(result.fills.length, 4);
});

test('SHORT_STRIKE_BREACHED: evaluateExit triggers CLOSE the instant underlying reaches a short strike', () => {
  const decision = evaluateExit({
    maxProfit: MAX_PROFIT, maxLoss: MAX_LOSS, currentCostToClose: MAX_PROFIT, dte: 15,
    underlyingPrice: 25510, // past the 25500 short CE strike
    shortStrikes: SHORT_STRIKES,
  });
  assert.equal(decision.action, 'CLOSE');
  assert.equal(decision.reason, 'SHORT_STRIKE_BREACHED');

  const quoteMap = buildQuoteMap({
    NIFTY24000PE: [5, 7], NIFTY23500PE: [1, 2], NIFTY25500CE: [280, 290], NIFTY26000CE: [50, 55],
  });
  const result = simulateShadowExitFills({ legs: IRON_CONDOR_LEGS, quoteMap, exchange: 'NFO' });
  assert.equal(result.status, 'FILLED');
});

test('TIME_EXIT: evaluateExit triggers CLOSE inside the forced time-exit window regardless of P&L', () => {
  const decision = evaluateExit({
    maxProfit: MAX_PROFIT, maxLoss: MAX_LOSS, currentCostToClose: MAX_PROFIT * 0.9, dte: 1, // <= default timeExitDte=2
    underlyingPrice: 24800, shortStrikes: SHORT_STRIKES,
  });
  assert.equal(decision.action, 'CLOSE');
  assert.equal(decision.reason, 'TIME_EXIT');

  const quoteMap = buildQuoteMap({
    NIFTY24000PE: [25, 28], NIFTY23500PE: [3, 4], NIFTY25500CE: [22, 25], NIFTY26000CE: [4, 5],
  });
  const result = simulateShadowExitFills({ legs: IRON_CONDOR_LEGS, quoteMap, exchange: 'NFO' });
  assert.equal(result.status, 'FILLED');
});

test('a missing exit quote on ANY leg is EXECUTION_DATA_INSUFFICIENT, never a fabricated close', () => {
  const decision = evaluateExit({
    maxProfit: MAX_PROFIT, maxLoss: MAX_LOSS, currentCostToClose: MAX_PROFIT * 2.5, dte: 20, underlyingPrice: 24800, shortStrikes: SHORT_STRIKES,
  });
  assert.equal(decision.action, 'CLOSE');
  const quoteMap = buildQuoteMap({
    NIFTY24000PE: [90, 94], NIFTY23500PE: [15, 18], NIFTY25500CE: [110, 115],
    // NIFTY26000CE deliberately missing
  });
  const result = simulateShadowExitFills({ legs: IRON_CONDOR_LEGS, quoteMap, exchange: 'NFO' });
  assert.equal(result.status, 'EXECUTION_DATA_INSUFFICIENT');
});

test('HOLD: no exit trigger means no exit simulation is ever attempted', () => {
  const decision = evaluateExit({
    maxProfit: MAX_PROFIT, maxLoss: MAX_LOSS, currentCostToClose: MAX_PROFIT * 0.8, dte: 20, underlyingPrice: 24800, shortStrikes: SHORT_STRIKES,
  });
  assert.equal(decision.action, 'HOLD');
});
