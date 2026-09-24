import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVwapScalperPositionSize, computeFixedCapitalPositionSize } from '../positionSizing.ts';

test('sizes to the max whole-share quantity within the risk budget', () => {
  // Budget = 100,000 * 1% = 1,000. Risk/share = |100 - 98| = 2. 1000/2 = 500 shares exactly.
  const result = computeVwapScalperPositionSize({
    accountEquity: 100_000, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 98,
  });
  assert.ok(result);
  assert.equal(result!.quantity, 500);
  assert.equal(result!.riskPerShare, 2);
  assert.equal(result!.totalRiskAtStop, 1000);
  assert.equal(result!.budgetAtRisk, 1000);
});

test('floors to a whole share count when the budget does not divide evenly', () => {
  // Budget = 1000, risk/share = 3 -> 333.33 -> floors to 333.
  const result = computeVwapScalperPositionSize({
    accountEquity: 100_000, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 97,
  });
  assert.ok(result);
  assert.equal(result!.quantity, 333);
  assert.ok(result!.totalRiskAtStop <= result!.budgetAtRisk);
});

test('refuses (returns null) rather than sizing without a stop-implied risk-per-share of zero', () => {
  const result = computeVwapScalperPositionSize({
    accountEquity: 100_000, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 100,
  });
  assert.equal(result, null);
});

test('refuses when the risk budget cannot afford even one share', () => {
  const result = computeVwapScalperPositionSize({
    accountEquity: 1000, maxRiskPerTradePct: 0.01, entryPrice: 100, stopPrice: 50,
  });
  assert.equal(result, null);
});

test('refuses non-positive account equity or risk percentage', () => {
  assert.equal(computeVwapScalperPositionSize({ accountEquity: 0, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 98 }), null);
  assert.equal(computeVwapScalperPositionSize({ accountEquity: 100_000, maxRiskPerTradePct: 0, entryPrice: 100, stopPrice: 98 }), null);
});

test('lotSize constrains the quantity to whole multiples of the lot', () => {
  // Budget=1000, risk/share=2 -> raw 500 shares, but lotSize=7 -> floors to 497 (71 lots).
  const result = computeVwapScalperPositionSize({
    accountEquity: 100_000, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 98, lotSize: 7,
  });
  assert.ok(result);
  assert.equal(result!.quantity, 497);
  assert.equal(result!.quantity % 7, 0);
});

test('direction of the entry/stop distance does not matter — SHORT (stop above entry) sizes the same as LONG', () => {
  const long = computeVwapScalperPositionSize({ accountEquity: 100_000, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 98 });
  const short = computeVwapScalperPositionSize({ accountEquity: 100_000, maxRiskPerTradePct: 1, entryPrice: 100, stopPrice: 102 });
  assert.equal(long!.quantity, short!.quantity);
});

test('computeFixedCapitalPositionSize buys the max whole-share quantity the capital allocation affords', () => {
  // 20,000 / 341.30 = 58.6 -> floors to 58 shares.
  const result = computeFixedCapitalPositionSize({ capitalPerTrade: 20_000, entryPrice: 341.30 });
  assert.ok(result);
  assert.equal(result!.quantity, 58);
  assert.ok(Math.abs(result!.capitalDeployed - 58 * 341.30) < 1e-9);
});

test('computeFixedCapitalPositionSize does NOT require a stop to size — quantity depends only on capital and price', () => {
  const withStop = computeFixedCapitalPositionSize({ capitalPerTrade: 20_000, entryPrice: 100, stopPrice: 98 });
  const withoutStop = computeFixedCapitalPositionSize({ capitalPerTrade: 20_000, entryPrice: 100 });
  assert.ok(withStop && withoutStop);
  assert.equal(withStop!.quantity, withoutStop!.quantity);
  assert.equal(withoutStop!.riskPerShare, null);
  assert.equal(withoutStop!.totalRiskAtStop, null);
});

test('computeFixedCapitalPositionSize still reports risk figures when a stop IS supplied, purely for visibility', () => {
  const result = computeFixedCapitalPositionSize({ capitalPerTrade: 20_000, entryPrice: 100, stopPrice: 98 });
  assert.ok(result);
  assert.equal(result!.riskPerShare, 2);
  assert.equal(result!.totalRiskAtStop, result!.quantity * 2);
});

test('computeFixedCapitalPositionSize refuses non-positive capital or entry price', () => {
  assert.equal(computeFixedCapitalPositionSize({ capitalPerTrade: 0, entryPrice: 100 }), null);
  assert.equal(computeFixedCapitalPositionSize({ capitalPerTrade: 20_000, entryPrice: 0 }), null);
});

test('computeFixedCapitalPositionSize refuses when the capital cannot afford even one lot', () => {
  const result = computeFixedCapitalPositionSize({ capitalPerTrade: 500, entryPrice: 1000 });
  assert.equal(result, null);
});

test('computeFixedCapitalPositionSize respects a lot-size constraint the same way risk-based sizing does', () => {
  // 20,000 / 100 = 200 raw shares, but lotSize=7 -> floors to 196 (28 lots).
  const result = computeFixedCapitalPositionSize({ capitalPerTrade: 20_000, entryPrice: 100, lotSize: 7 });
  assert.ok(result);
  assert.equal(result!.quantity, 196);
  assert.equal(result!.quantity % 7, 0);
});
