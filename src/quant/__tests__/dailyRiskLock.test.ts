import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDailyRiskLock } from '../execution/dailyRiskLock.ts';

const LIMITS = { equity: 500_000, maxDailyLossPct: 4, maxConsecutiveLosses: 3 };

test('does not lock when within both limits', () => {
  const r = checkDailyRiskLock({ realizedPnlToday: -5_000, consecutiveLosses: 1 }, LIMITS);
  assert.equal(r.locked, false);
  assert.equal(r.reason, null);
});

test('a flat or positive day never locks on daily loss', () => {
  assert.equal(checkDailyRiskLock({ realizedPnlToday: 0, consecutiveLosses: 0 }, LIMITS).locked, false);
  assert.equal(checkDailyRiskLock({ realizedPnlToday: 12_000, consecutiveLosses: 0 }, LIMITS).locked, false);
});

test('locks with MAX_DAILY_LOSS exactly at the threshold, citing the real rupee figures', () => {
  // 4% of 500,000 = 20,000
  const r = checkDailyRiskLock({ realizedPnlToday: -20_000, consecutiveLosses: 0 }, LIMITS);
  assert.equal(r.locked, true);
  assert.equal(r.reason, 'MAX_DAILY_LOSS');
  assert.match(r.detail, /20000|20,000/);
});

test('does not lock just short of the daily loss threshold', () => {
  const r = checkDailyRiskLock({ realizedPnlToday: -19_999, consecutiveLosses: 0 }, LIMITS);
  assert.equal(r.locked, false);
});

test('locks with MAX_CONSECUTIVE_LOSSES at the configured cap even with a small daily loss', () => {
  const r = checkDailyRiskLock({ realizedPnlToday: -500, consecutiveLosses: 3 }, LIMITS);
  assert.equal(r.locked, true);
  assert.equal(r.reason, 'MAX_CONSECUTIVE_LOSSES');
});

test('does not lock on consecutive losses just short of the cap', () => {
  const r = checkDailyRiskLock({ realizedPnlToday: 0, consecutiveLosses: 2 }, LIMITS);
  assert.equal(r.locked, false);
});

test('daily loss is checked before consecutive losses when both would independently trigger', () => {
  const r = checkDailyRiskLock({ realizedPnlToday: -20_000, consecutiveLosses: 3 }, LIMITS);
  assert.equal(r.reason, 'MAX_DAILY_LOSS');
});

test('unconfigured (zero) equity never locks on a fresh, zero-P&L day — a ₹0 budget is "not set up yet", not "already exceeded"', () => {
  const r = checkDailyRiskLock(
    { realizedPnlToday: 0, consecutiveLosses: 0 },
    { equity: 0, maxDailyLossPct: 3, maxConsecutiveLosses: 3 },
  );
  assert.equal(r.locked, false);
  assert.equal(r.reason, null);
});

test('zero equity does not lock even with some existing realized loss — there is no real budget to compare against', () => {
  const r = checkDailyRiskLock(
    { realizedPnlToday: -500, consecutiveLosses: 0 },
    { equity: 0, maxDailyLossPct: 3, maxConsecutiveLosses: 3 },
  );
  assert.equal(r.locked, false);
});

test('negative equity is treated the same as zero — never evaluated as a daily-loss budget', () => {
  const r = checkDailyRiskLock(
    { realizedPnlToday: 0, consecutiveLosses: 0 },
    { equity: -100, maxDailyLossPct: 3, maxConsecutiveLosses: 3 },
  );
  assert.equal(r.locked, false);
});

test('consecutive-loss locking still works even when equity is unconfigured — the two checks are independent', () => {
  const r = checkDailyRiskLock(
    { realizedPnlToday: 0, consecutiveLosses: 3 },
    { equity: 0, maxDailyLossPct: 3, maxConsecutiveLosses: 3 },
  );
  assert.equal(r.locked, true);
  assert.equal(r.reason, 'MAX_CONSECUTIVE_LOSSES');
});
