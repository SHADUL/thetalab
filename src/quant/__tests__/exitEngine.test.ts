import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExit, DEFAULT_EXIT_PARAMS } from '../execution/exitEngine.ts';

// A Bear Call Spread: SELL 23750CE / BUY 23850CE, credit 1900, max loss 4600
// (matches the real live position shape seen in production this session).
function baseInput(overrides = {}) {
  return {
    maxProfit: 1900,
    maxLoss: 4600,
    currentCostToClose: 950, // 50% captured
    dte: 22,
    underlyingPrice: 23500,
    shortStrikes: [{ strike: 23750, right: 'CE' as const }],
    ...overrides,
  };
}

test('holds when nothing has triggered', () => {
  const hold = evaluateExit(baseInput({ currentCostToClose: 1200 })); // (1900-1200)/1900 = 36.8%, below the 50% target
  assert.equal(hold.action, 'HOLD');
  assert.equal(hold.reason, null);
  assert.ok(Math.abs(hold.profitCapturedPct! - 36.84) < 0.1);
});

test('closes on SHORT_STRIKE_BREACHED the instant the underlying reaches a short call strike, checked before anything else', () => {
  const d = evaluateExit(baseInput({ underlyingPrice: 23750, currentCostToClose: 100 })); // deep profit by other metrics, but strike breached
  assert.equal(d.action, 'CLOSE');
  assert.equal(d.reason, 'SHORT_STRIKE_BREACHED');
});

test('a short put breach triggers correctly in the opposite direction', () => {
  const d = evaluateExit({
    ...baseInput(),
    shortStrikes: [{ strike: 23300, right: 'PE' }],
    underlyingPrice: 23250, // at/below the short put strike
  });
  assert.equal(d.action, 'CLOSE');
  assert.equal(d.reason, 'SHORT_STRIKE_BREACHED');
});

test('closes on STOP_LOSS_MAX_LOSS when closing now would realize the defined max loss', () => {
  const d = evaluateExit(baseInput({ currentCostToClose: 1900 + 4600 })); // realized loss == maxLoss exactly
  assert.equal(d.action, 'CLOSE');
  assert.equal(d.reason, 'STOP_LOSS_MAX_LOSS');
});

test('closes on STOP_LOSS_CREDIT_MULTIPLE before reaching full max loss', () => {
  // 2x credit = 3800, well short of maxLoss-triggering threshold (1900+4600=6500)
  const d = evaluateExit(baseInput({ currentCostToClose: 3800 }));
  assert.equal(d.action, 'CLOSE');
  assert.equal(d.reason, 'STOP_LOSS_CREDIT_MULTIPLE');
});

test('closes on PROFIT_TARGET once the configured percent of credit is captured', () => {
  const d = evaluateExit(baseInput({ currentCostToClose: 950 })); // exactly 50%
  assert.equal(d.action, 'CLOSE');
  assert.equal(d.reason, 'PROFIT_TARGET');
  assert.equal(d.profitCapturedPct, 50);
});

test('closes on TIME_EXIT inside the forced window even with no P&L trigger', () => {
  const d = evaluateExit(baseInput({ currentCostToClose: 1200, dte: 2 })); // 36.8% captured, not otherwise triggered
  assert.equal(d.action, 'CLOSE');
  assert.equal(d.reason, 'TIME_EXIT');
});

test('custom thresholds override the defaults', () => {
  const tight = evaluateExit(baseInput({ currentCostToClose: 600, profitTargetPct: 30 })); // 68% captured, target lowered to 30%
  assert.equal(tight.action, 'CLOSE');
  assert.equal(tight.reason, 'PROFIT_TARGET');
});

test('priority order: a strike breach wins even when profit target is also met', () => {
  const d = evaluateExit(baseInput({ underlyingPrice: 23750, currentCostToClose: 100 })); // 94.7% captured AND breached
  assert.equal(d.reason, 'SHORT_STRIKE_BREACHED');
});

test('DEFAULT_EXIT_PARAMS matches the documented defaults', () => {
  assert.deepEqual(DEFAULT_EXIT_PARAMS, { profitTargetPct: 50, stopLossCreditMultiple: 2, timeExitDte: 2, strikeBreachBufferPct: 0 });
});
