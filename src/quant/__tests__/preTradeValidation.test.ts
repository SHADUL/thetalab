import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPreTradeValidation, type ValidationInput } from '../execution/preTradeValidation.ts';

function goodInput(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    quoteAgeMs: 1_000, maxQuoteAgeMs: 5 * 60_000,
    isMarketOpen: true,
    allInstrumentsResolved: true, unresolvedLegs: [],
    marginSufficient: true, marginDetail: 'Margin within budget.',
    positionSizeLots: 2,
    duplicatePositionExists: false,
    priceDriftPct: 0.3, maxSlippagePct: 1.5,
    strategyStillValid: true, strategyDetail: 'Skew reading unchanged.',
    greeksWithinLimits: true, greeksDetail: 'Recalculated Greeks within caps.',
    recalculatedMaxLoss: 20_100, originalMaxLoss: 20_000, maxLossDriftPct: 5,
    ...overrides,
  };
}

test('a fully clean input passes all ten checks', () => {
  const result = runPreTradeValidation(goodInput());
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 10);
  assert.ok(result.checks.every((c) => c.passed));
});

test('a stale quote fails marketDataFreshness alone', () => {
  const result = runPreTradeValidation(goodInput({ quoteAgeMs: 10 * 60_000 }));
  assert.equal(result.passed, false);
  const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(failed, ['marketDataFreshness']);
});

test('a closed market fails tradingSession', () => {
  const result = runPreTradeValidation(goodInput({ isMarketOpen: false }));
  assert.equal(result.passed, false);
  assert.ok(result.checks.find((c) => c.name === 'tradingSession' && !c.passed));
});

test('unresolved instruments fail instrumentValidity with the specific tradingsymbols named', () => {
  const result = runPreTradeValidation(goodInput({ allInstrumentsResolved: false, unresolvedLegs: ['NIFTY26SEP25000CE'] }));
  const check = result.checks.find((c) => c.name === 'instrumentValidity')!;
  assert.equal(check.passed, false);
  assert.match(check.detail, /NIFTY26SEP25000CE/);
});

test('insufficient margin fails availableMargin with the caller-supplied detail', () => {
  const result = runPreTradeValidation(goodInput({ marginSufficient: false, marginDetail: 'Required 62,000 exceeds available 40,000.' }));
  const check = result.checks.find((c) => c.name === 'availableMargin')!;
  assert.equal(check.passed, false);
  assert.match(check.detail, /62,000/);
});

test('zero position size fails riskLimits', () => {
  const result = runPreTradeValidation(goodInput({ positionSizeLots: 0 }));
  assert.ok(result.checks.find((c) => c.name === 'riskLimits' && !c.passed));
});

test('a duplicate position fails noDuplicatePosition', () => {
  const result = runPreTradeValidation(goodInput({ duplicatePositionExists: true }));
  assert.ok(result.checks.find((c) => c.name === 'noDuplicatePosition' && !c.passed));
});

test('price drift beyond the slippage cap fails priceSlippage, in either direction', () => {
  assert.ok(runPreTradeValidation(goodInput({ priceDriftPct: 3 })).checks.find((c) => c.name === 'priceSlippage' && !c.passed));
  assert.ok(runPreTradeValidation(goodInput({ priceDriftPct: -3 })).checks.find((c) => c.name === 'priceSlippage' && !c.passed));
});

test('an invalidated strategy fails strategyStillValid', () => {
  const result = runPreTradeValidation(goodInput({ strategyStillValid: false, strategyDetail: 'Skew has flipped bearish since scoring.' }));
  const check = result.checks.find((c) => c.name === 'strategyStillValid')!;
  assert.equal(check.passed, false);
  assert.match(check.detail, /flipped bearish/);
});

test('Greeks drifting outside caps fails greeksRecalculation', () => {
  const result = runPreTradeValidation(goodInput({ greeksWithinLimits: false, greeksDetail: 'Net vega now exceeds the portfolio cap.' }));
  assert.ok(result.checks.find((c) => c.name === 'greeksRecalculation' && !c.passed));
});

test('max loss drifting beyond the allowed percent fails maxLossRecalculation with the actual numbers', () => {
  const result = runPreTradeValidation(goodInput({ recalculatedMaxLoss: 25_000, originalMaxLoss: 20_000, maxLossDriftPct: 10 }));
  const check = result.checks.find((c) => c.name === 'maxLossRecalculation')!;
  assert.equal(check.passed, false); // 25% drift > 10% allowed
  assert.match(check.detail, /25000/);
  assert.match(check.detail, /20000/);
});

test('a zero original max loss does not crash and fails the drift check rather than dividing by zero silently', () => {
  const result = runPreTradeValidation(goodInput({ originalMaxLoss: 0, recalculatedMaxLoss: 100 }));
  assert.equal(result.checks.find((c) => c.name === 'maxLossRecalculation')!.passed, false);
});

test('multiple independent failures are all reported, not just the first', () => {
  const result = runPreTradeValidation(goodInput({ isMarketOpen: false, duplicatePositionExists: true }));
  const failed = result.checks.filter((c) => !c.passed).map((c) => c.name).sort();
  assert.deepEqual(failed, ['noDuplicatePosition', 'tradingSession'].sort());
});
