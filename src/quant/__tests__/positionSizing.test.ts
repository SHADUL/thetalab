import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePositionSize,
  DEFAULT_RISK_LIMITS,
  type SizableCandidate,
  type OpenPositionSummary,
  type AccountState,
  type PortfolioState,
} from '../strategies/positionSizing.ts';
import { EMPTY_GREEKS } from '../types.ts';

const ACCOUNT: AccountState = { equity: 1_000_000, availableFunds: 400_000 };
const EMPTY_PORTFOLIO: PortfolioState = { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 };

function niftyCondor(overrides: Partial<SizableCandidate> = {}): SizableCandidate {
  return {
    pricing: {
      maxLoss: 20_000, maxProfit: 6_000, netCredit: 6_000 / 65,
      netGreeks: { delta: 2, gamma: 0.5, theta: 400, vega: 30, rho: 0 },
    },
    marginRequiredPerLot: 62_000,
    underlyingGroup: 'NIFTY',
    ...overrides,
  };
}

function openPosition(overrides: Partial<OpenPositionSummary> = {}): OpenPositionSummary {
  return {
    underlyingGroup: 'NIFTY', maxLoss: 18_000, marginRequired: 55_000,
    netGreeks: { delta: 3, gamma: 0.4, theta: 350, vega: 25, rho: 0 },
    ...overrides,
  };
}

test('sizes a clean scenario to a positive lot count, bound by the tightest of the ten constraints', () => {
  const result = computePositionSize(niftyCondor(), ACCOUNT, EMPTY_PORTFOLIO);
  assert.equal(result.constraints.length, 10);
  assert.ok(result.lots > 0, JSON.stringify(result));
  assert.equal(result.reason, null);
  assert.equal(result.sizedMaxLoss, 20_000 * result.lots);
  assert.equal(result.sizedMaxProfit, 6_000 * result.lots);
  assert.equal(result.sizedMarginRequired, 62_000 * result.lots);
  // With a 2% per-trade budget on ₹1,000,000 equity (₹20,000) and a
  // ₹20,000 per-lot max loss, exactly 1 lot should be the binding figure.
  assert.equal(result.lots, 1);
  assert.equal(result.binding, 'maxRiskPerTrade');
});

test('maxPositions is a hard binary gate — zero lots once the cap is reached, regardless of budget room', () => {
  // Deliberately tiny per-position maxLoss/margin so every OTHER budget-based
  // constraint has ample room left — isolating maxPositions as the sole zero.
  const portfolio: PortfolioState = {
    openPositions: Array.from({ length: DEFAULT_RISK_LIMITS.maxPositions }, () => openPosition({ maxLoss: 500, marginRequired: 1_000 })),
    realizedPnlToday: 0, realizedPnlThisWeek: 0,
  };
  const result = computePositionSize(niftyCondor(), ACCOUNT, portfolio);
  assert.equal(result.lots, 0);
  assert.equal(result.binding, 'maxPositions');
  assert.match(result.reason!, /maxPositions/);
});

test('a daily loss already near the budget shrinks the allowed size for a new trade', () => {
  const portfolio: PortfolioState = { openPositions: [], realizedPnlToday: -39_000, realizedPnlThisWeek: -39_000 };
  // Daily budget = 4% of 1,000,000 = 40,000; 39,000 already lost -> only 1,000 left.
  const result = computePositionSize(niftyCondor({ pricing: { ...niftyCondor().pricing, maxLoss: 20_000 } }), ACCOUNT, portfolio);
  assert.equal(result.lots, 0);
  assert.equal(result.binding, 'maxDailyLoss');
});

test('margin utilization accounts for margin already committed to open positions', () => {
  const portfolio: PortfolioState = {
    openPositions: [openPosition({ marginRequired: 235_000 })],
    realizedPnlToday: 0, realizedPnlThisWeek: 0,
  };
  // maxMarginUtilizationPct=60% of 400,000 available = 240,000 budget;
  // 235,000 already used leaves only 5,000 -> 0 lots at 62,000/lot.
  const result = computePositionSize(niftyCondor(), ACCOUNT, portfolio);
  assert.equal(result.lots, 0);
  assert.equal(result.binding, 'maxMarginUtilization');
});

test('underlying delta exposure is scoped per underlying — an unrelated symbol\'s delta does not cap this trade', () => {
  const heavyOtherSymbol: PortfolioState = {
    openPositions: [openPosition({ underlyingGroup: 'SOMETHING_ELSE', netGreeks: { ...EMPTY_GREEKS, delta: 290 } })],
    realizedPnlToday: 0, realizedPnlThisWeek: 0,
  };
  const result = computePositionSize(niftyCondor(), ACCOUNT, heavyOtherSymbol);
  assert.notEqual(result.binding, 'maxUnderlyingExposure');
});

test('underlying delta exposure caps additional lots once the same underlying is already near its limit', () => {
  const nearCap: PortfolioState = {
    openPositions: [openPosition({ underlyingGroup: 'NIFTY', maxLoss: 500, marginRequired: 1_000, netGreeks: { ...EMPTY_GREEKS, delta: 298 } })],
    realizedPnlToday: 0, realizedPnlThisWeek: 0,
  };
  // A generous per-trade risk budget so maxRiskPerTrade doesn't also tie at
  // 1 lot and mask which constraint is actually being isolated here.
  const roomyLimits = { ...DEFAULT_RISK_LIMITS, maxRiskPerTradePct: 10, maxPortfolioRiskPct: 50 };
  // maxUnderlyingDelta=300; existing=298; candidate delta=2/lot -> only 1 more lot fits (298+2=300).
  const result = computePositionSize(niftyCondor(), ACCOUNT, nearCap, roomyLimits);
  assert.equal(result.binding, 'maxUnderlyingExposure');
  assert.equal(result.lots, 1);
});

test('an already-breached Greek cap refuses new lots outright rather than reasoning about direction', () => {
  const alreadyBreached: PortfolioState = {
    openPositions: [openPosition({ netGreeks: { ...EMPTY_GREEKS, gamma: 60 } })], // cap is 50
    realizedPnlToday: 0, realizedPnlThisWeek: 0,
  };
  const result = computePositionSize(niftyCondor(), ACCOUNT, alreadyBreached);
  assert.equal(result.lots, 0);
  assert.equal(result.binding, 'maxGammaExposure');
});

test('correlated exposure pools underlying groups sharing the same correlatedGroup, but not ungrouped ones', () => {
  const bankniftyPosition = openPosition({ underlyingGroup: 'BANKNIFTY', correlatedGroup: 'NIFTY_FAMILY', maxLoss: 58_000 });
  const portfolio: PortfolioState = { openPositions: [bankniftyPosition], realizedPnlToday: 0, realizedPnlThisWeek: 0 };

  // Without tagging the new candidate into the same correlated group, BANKNIFTY's risk shouldn't count against it.
  const ungrouped = computePositionSize(niftyCondor(), ACCOUNT, portfolio);
  assert.notEqual(ungrouped.binding, 'maxCorrelatedExposure');

  // Tagged into the same correlated group, the existing BANKNIFTY risk (58,000) eats most of the
  // 6% x 1,000,000 = 60,000 correlated budget, leaving room for 0 more 20,000-max-loss lots.
  const grouped = computePositionSize(niftyCondor({ correlatedGroup: 'NIFTY_FAMILY' }), ACCOUNT, portfolio);
  assert.equal(grouped.binding, 'maxCorrelatedExposure');
  assert.equal(grouped.lots, 0);
});

test('every one of the ten spec-named constraints is reported, not just the binding one', () => {
  const result = computePositionSize(niftyCondor(), ACCOUNT, EMPTY_PORTFOLIO);
  const names = result.constraints.map((c) => c.name).sort();
  assert.deepEqual(names, [
    'maxCorrelatedExposure', 'maxDailyLoss', 'maxGammaExposure', 'maxMarginUtilization',
    'maxPortfolioRisk', 'maxPositions', 'maxRiskPerTrade', 'maxUnderlyingExposure',
    'maxVegaExposure', 'maxWeeklyLoss',
  ].sort());
});
