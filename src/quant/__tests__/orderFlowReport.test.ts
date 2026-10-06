import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOrderFlow, groupStats, type ObservedTrade } from '../analytics/orderFlowReport.ts';

const t = (rr: ObservedTrade['rrDirection'], a: ObservedTrade['matchA'], b: ObservedTrade['matchB'], pnl: number, at: number): ObservedTrade =>
  ({ rrDirection: rr, matchA: a, matchB: b, pnl, closedAtMs: at });

test('groupStats: win rate, expectancy, profit factor and max drawdown on actual P&L, in close order', () => {
  const g = groupStats([{ pnl: 100, closedAtMs: 1 }, { pnl: -300, closedAtMs: 2 }, { pnl: 200, closedAtMs: 3 }, { pnl: -100, closedAtMs: 4 }]);
  assert.equal(g.n, 4);
  assert.equal(g.pnl, -100);
  assert.equal(g.winRatePct, 50);
  assert.equal(g.expectancy, -25);
  assert.equal(g.profitFactor, 300 / 400);
  assert.equal(g.maxDrawdown, 300); // peak 100 -> trough -200
});

test('groupStats: empty group has null rates, zero counts — nothing is invented', () => {
  const g = groupStats([]);
  assert.deepEqual([g.n, g.pnl, g.winRatePct, g.expectancy, g.profitFactor, g.maxDrawdown], [0, 0, null, null, null, 0]);
});

test('summary: counts RR-bearish-vs-bullish-flow and RR-bullish-vs-bearish-flow conflicts per variant independently', () => {
  const r = summarizeOrderFlow([
    t('bearish', 'CONFLICT', 'MATCH', -500, 1),
    t('bearish', 'CONFLICT', 'CONFLICT', -200, 2),
    t('bearish', 'MATCH', 'MATCH', 400, 3),
    t('bullish', 'CONFLICT', 'NOT_COMPARABLE', 100, 4),
    t('neutral', 'NOT_COMPARABLE', 'NOT_COMPARABLE', 50, 5),
  ]);
  assert.equal(r.tradeCount, 5);
  assert.equal(r.variantA.rrBearishWithBullishFlowConflict, 2);
  assert.equal(r.variantA.rrBullishWithBearishFlowConflict, 1);
  assert.equal(r.variantB.rrBearishWithBullishFlowConflict, 1);
  assert.equal(r.variantA.groups.CONFLICT.n, 3);
  assert.equal(r.variantA.groups.CONFLICT.pnl, -600);
  assert.equal(r.variantA.groups.MATCH.pnl, 400);
  assert.equal(r.variantB.groups.MATCH.n, 2);
});
