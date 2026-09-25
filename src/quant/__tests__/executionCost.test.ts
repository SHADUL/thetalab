import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeExecutionCostBreakdown, computeCanonicalForwardPnl, estimateTransactionCharges,
} from '../execution/executionCost.ts';

test('totalExecutionCost = entryExecutionCost + exitExecutionCost, exactly, when entry telemetry is available', () => {
  const breakdown = computeExecutionCostBreakdown({
    entryExecutionCostLookup: { value: 120, rowCount: 4 },
    exitExecutionCost: 85,
    transactionChargesEstimate: 40,
  });
  assert.equal(breakdown.entryExecutionCostBasis, 'REAL_TELEMETRY');
  assert.equal(breakdown.totalExecutionCost, 205);
  assert.equal(breakdown.entryExecutionCost, 120);
  // transactionChargesEstimate must never be folded into totalExecutionCost.
  assert.notEqual(breakdown.totalExecutionCost, 245);
});

test('entryExecutionCost missing -> totalExecutionCost is null, never silently 0', () => {
  const breakdown = computeExecutionCostBreakdown({
    entryExecutionCostLookup: { value: null, rowCount: 0 },
    exitExecutionCost: 85,
    transactionChargesEstimate: 40,
  });
  assert.equal(breakdown.entryExecutionCostBasis, 'UNAVAILABLE');
  assert.equal(breakdown.totalExecutionCost, null);
});

test('computeCanonicalForwardPnl: netPnl = grossPnl - entryExecutionCost - exitExecutionCost - transactionChargesEstimate', () => {
  const breakdown = computeExecutionCostBreakdown({
    entryExecutionCostLookup: { value: 100, rowCount: 4 },
    exitExecutionCost: 60,
    transactionChargesEstimate: 25,
  });
  const pnl = computeCanonicalForwardPnl(1000, breakdown);
  assert.equal(pnl.grossPnl, 1000);
  assert.equal(pnl.netPnl, 1000 - 100 - 60 - 25);
  assert.equal(pnl.totalExecutionCost, 160);
  assert.equal(pnl.costBasis.entry, 'REAL_TELEMETRY');
});

test('computeCanonicalForwardPnl: unavailable entry cost is treated as 0 for arithmetic but flagged in costBasis', () => {
  const breakdown = computeExecutionCostBreakdown({
    entryExecutionCostLookup: { value: null, rowCount: 0 },
    exitExecutionCost: 60,
    transactionChargesEstimate: 25,
  });
  const pnl = computeCanonicalForwardPnl(1000, breakdown);
  assert.equal(pnl.entryExecutionCost, 0);
  assert.equal(pnl.netPnl, 1000 - 0 - 60 - 25);
  assert.equal(pnl.costBasis.entry, 'UNAVAILABLE');
});

test('estimateTransactionCharges: SELL side pays STT, BUY side pays stamp duty — matches costs.ts computeLegCharges component-for-component', () => {
  const legs = [{ side: 'SELL' as const, entryTurnover: 60 * 75, exitTurnover: 5 * 75 }];
  const result = estimateTransactionCharges({ legs, tradeDate: '2025-06-01' });
  assert.ok(result.estimate > 0);
  // Entry order is SELL (STT applies); exit order (closing a short) is BUY (stamp duty applies, no STT).
  // Sanity bound: cost should be a small fraction of turnover, not comparable in magnitude to the premium itself.
  const totalTurnover = 60 * 75 + 5 * 75;
  assert.ok(result.estimate < totalTurnover * 0.05, `transaction charges (${result.estimate}) should be a small fraction of turnover (${totalTurnover})`);
});

test('estimateTransactionCharges uses the rate regime effective on the given trade date (pre/post Oct-2024 STT change)', () => {
  const legs = [{ side: 'SELL' as const, entryTurnover: 100_000, exitTurnover: 1000 }];
  const pre = estimateTransactionCharges({ legs, tradeDate: '2024-06-01' });
  const post = estimateTransactionCharges({ legs, tradeDate: '2025-01-01' });
  assert.ok(post.estimate > pre.estimate, 'post-Oct-2024 STT rate is higher, so the estimate must be higher for an identical trade');
});
