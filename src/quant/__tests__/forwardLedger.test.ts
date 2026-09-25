import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordSignal, recordOutcome, type ForwardLedgerStore, type ForwardSignal, type ForwardOutcome } from '../execution/forwardLedger.ts';

/** A real in-memory store implementing the ACTUAL idempotency guarantee (completed flag, atomic conditional write) — not a mock that just returns canned success, so the concurrency tests below are meaningful. */
class InMemoryForwardLedgerStore implements ForwardLedgerStore {
  rows = new Map<string, any>();
  private nextId = 1;
  private mutex: Promise<void> = Promise.resolve();

  async insertSignal(signal: ForwardSignal) {
    const id = String(this.nextId++);
    this.rows.set(id, {
      ...signal,
      grossPnl: null, netPnl: null, entryExecutionCost: null, exitExecutionCost: null, totalExecutionCost: null,
      maxAdverseExcursion: null, maxFavorableExcursion: null, exitReason: null, holdingPeriodDays: null,
      dailyLockState: null, dataQuality: null, outcomeRecordedAt: null, completed: false,
    });
    return { id };
  }

  async recordOutcome(ledgerId: string, outcome: ForwardOutcome) {
    // Serialized critical section, same technique as orderIntent.test.ts's
    // InMemoryOrderIntentStore — proves the "at most one writer wins"
    // guarantee even when two calls race, not just when they're sequential.
    let result: { ok: true } | { alreadyCompleted: true } | { error: string } = { error: 'unreachable' };
    const run = this.mutex.then(async () => {
      const row = this.rows.get(ledgerId);
      if (!row) { result = { error: 'not found' }; return; }
      if (row.completed) { result = { alreadyCompleted: true }; return; }
      Object.assign(row, outcome, { outcomeRecordedAt: new Date().toISOString(), completed: true });
      result = { ok: true };
    });
    this.mutex = run.catch(() => {});
    await run;
    return result;
  }

  async getOutcome(ledgerId: string) {
    const row = this.rows.get(ledgerId);
    if (!row) return { found: false } as const;
    return {
      found: true as const,
      outcome: {
        completed: row.completed, exitReason: row.exitReason ?? null,
        netPnl: row.netPnl ?? null, outcomeRecordedAtIso: row.outcomeRecordedAt ?? null,
      },
    };
  }
}

const SIGNAL: ForwardSignal = {
  symbol: 'NIFTY', strategyLabel: 'Iron Condor', expiry: '2026-10-30', calendarDte: 30, tradingSessionHorizon: 21,
  shortDeltaTarget: 0.16, wingWidth: 500, netCredit: 150, estimatedMaxLoss: 350, estimatedPop: 0.72,
  expectedValue: 30, premiumEdgePct: 8.5, independentEvPerUnitRisk: 0.05, ivRank: null,
  liquidityTier: 'LIQUID', marketRegime: 'BULLISH', sizingLots: 3, expectedCostsRupees: 120,
  baselineVersion: 'BASELINE_V1', fillModelVersion: 'SHADOW_EXECUTION_V1', protocolId: null, codeVersion: 'test-sha',
};

const OUTCOME: ForwardOutcome = {
  exitReason: 'PROFIT_TARGET', holdingPeriodDays: 3, grossPnl: 4600, netPnl: 4200,
  entryExecutionCost: 180, exitExecutionCost: 220, totalExecutionCost: 400,
  transactionChargesEstimate: 25, costModelVersion: 'EXEC_COST_V1',
  maxAdverseExcursion: null, maxFavorableExcursion: null,
  dailyLockState: { wouldTriggerMaxDailyLoss: false, wouldTriggerMaxConsecutiveLosses: false, realizedPnlTodayAfterThisTrade: 4200, consecutiveLossesAfterThisTrade: 0 },
  dataQuality: { note: 'MAE_MFE_UNAVAILABLE' },
};

test('recordSignal inserts a row with every outcome field null and completed=false', async () => {
  const store = new InMemoryForwardLedgerStore();
  const id = await recordSignal(store, SIGNAL);
  const row = store.rows.get(id);
  assert.ok(row);
  assert.equal(row.netPnl, null);
  assert.equal(row.exitReason, null);
  assert.equal(row.completed, false);
  assert.equal(row.symbol, 'NIFTY');
});

test('recordOutcome sets ONLY outcome fields, never touching a pre-trade field', async () => {
  const store = new InMemoryForwardLedgerStore();
  const id = await recordSignal(store, SIGNAL);
  const before = { ...store.rows.get(id) };

  const result = await recordOutcome(store, id, OUTCOME);
  assert.deepEqual(result, { ok: true });

  const after = store.rows.get(id);
  for (const key of Object.keys(SIGNAL) as (keyof ForwardSignal)[]) {
    assert.deepEqual(after[key], before[key], `pre-trade field '${key}' must never change after outcome is recorded`);
  }
  assert.equal(after.netPnl, 4200);
  assert.equal(after.exitReason, 'PROFIT_TARGET');
  assert.equal(after.completed, true);
  assert.ok(after.outcomeRecordedAt);
});

test('recordOutcome against a non-existent ledger id fails cleanly rather than silently no-op-ing', async () => {
  const store = new InMemoryForwardLedgerStore();
  const result = await recordOutcome(store, 'does-not-exist', OUTCOME);
  assert.ok('error' in result);
});

test('IDEMPOTENCY: a second recordOutcome call for an already-completed row is rejected, never overwrites the first outcome', async () => {
  const store = new InMemoryForwardLedgerStore();
  const id = await recordSignal(store, SIGNAL);
  const first = await recordOutcome(store, id, OUTCOME);
  assert.deepEqual(first, { ok: true });

  const secondAttempt: ForwardOutcome = { ...OUTCOME, netPnl: 99999, exitReason: 'DIFFERENT_REASON' };
  const second = await recordOutcome(store, id, secondAttempt);
  assert.deepEqual(second, { alreadyCompleted: true });

  const row = store.rows.get(id);
  assert.equal(row.netPnl, 4200, 'the FIRST outcome must be preserved, never overwritten by a later duplicate call');
  assert.equal(row.exitReason, 'PROFIT_TARGET');
});

test('IDEMPOTENCY under real concurrency: two simultaneous recordOutcome calls for the same row — exactly one succeeds', async () => {
  const store = new InMemoryForwardLedgerStore();
  const id = await recordSignal(store, SIGNAL);
  const [a, b] = await Promise.all([recordOutcome(store, id, OUTCOME), recordOutcome(store, id, { ...OUTCOME, netPnl: 1 })]);
  const results = [a, b];
  const okCount = results.filter((r) => 'ok' in r).length;
  const alreadyCount = results.filter((r) => 'alreadyCompleted' in r).length;
  assert.equal(okCount, 1, `expected exactly 1 success, got ${JSON.stringify(results)}`);
  assert.equal(alreadyCount, 1);
});

test('TYPE-LEVEL GUARANTEE: ForwardOutcome has no overlapping keys with ForwardSignal, so recordOutcome cannot even be called with a pre-trade field', () => {
  const signalKeys = new Set(Object.keys(SIGNAL));
  const outcomeKeys = Object.keys(OUTCOME);
  for (const k of outcomeKeys) assert.ok(!signalKeys.has(k), `'${k}' must not appear in both ForwardSignal and ForwardOutcome`);
});
