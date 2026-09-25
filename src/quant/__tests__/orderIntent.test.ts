import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  claimOrderIntent, computeCandidateHash, computeIntentKey,
  type OrderIntentStore, type IntentUpdatePatch,
} from '../execution/orderIntent.ts';

/**
 * A real in-memory store, not a canned-response mock — this is what makes
 * the concurrency tests below meaningful. `insertClaim` deliberately awaits
 * an artificial delay BEFORE checking/writing its map, to simulate real
 * network latency to a database and force overlapping calls to genuinely
 * interleave rather than run one-at-a-time by accident of a fast event
 * loop. The critical section itself is serialized with a promise-chain
 * mutex — the same class of guarantee a real unique index provides for
 * free — so this test proves the LOCKING PATTERN is correct, independent
 * of Postgres itself (which is what the production adapter actually
 * relies on for the real cross-instance guarantee).
 */
class InMemoryOrderIntentStore implements OrderIntentStore {
  private rows = new Map<string, { id: string; status: string }>();
  private nextId = 1;
  private mutex: Promise<void> = Promise.resolve();
  claimAttempts = 0;

  async insertClaim(row: Parameters<OrderIntentStore['insertClaim']>[0]) {
    this.claimAttempts++;
    // Simulate network latency to a real database BEFORE entering the
    // critical section — this is what actually creates the race window a
    // buggy check-then-act implementation would fall into.
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));

    let result!: { id: string } | { conflict: true };
    // Serialize the check+write critical section — mirrors what a real
    // unique index gives you atomically; here it's explicit.
    const run = this.mutex.then(async () => {
      const existing = this.rows.get(row.intentKey);
      const nonTerminal = existing && existing.status !== 'COMPLETED' && existing.status !== 'FAILED';
      if (nonTerminal) {
        result = { conflict: true };
        return;
      }
      const id = String(this.nextId++);
      this.rows.set(row.intentKey, { id, status: 'CLAIMED' });
      result = { id };
    });
    this.mutex = run.catch(() => {});
    await run;
    return result;
  }

  async updateStatus(intentId: string, patch: IntentUpdatePatch) {
    for (const [key, row] of this.rows) {
      if (row.id === intentId) {
        this.rows.set(key, { id: intentId, status: patch.status });
        return { ok: true } as const;
      }
    }
    return { error: 'not found' } as const;
  }
}

const NIFTY_LEGS = [
  { side: 'SELL' as const, right: 'CE' as const, strike: 23700 },
  { side: 'BUY' as const, right: 'CE' as const, strike: 24000 },
  { side: 'SELL' as const, right: 'PE' as const, strike: 23400 },
  { side: 'BUY' as const, right: 'PE' as const, strike: 23200 },
];

test('computeCandidateHash is order-independent and shape-sensitive', () => {
  const shuffled = [NIFTY_LEGS[2], NIFTY_LEGS[0], NIFTY_LEGS[3], NIFTY_LEGS[1]];
  assert.equal(computeCandidateHash(NIFTY_LEGS), computeCandidateHash(shuffled));

  const differentStrike = [...NIFTY_LEGS.slice(0, 3), { side: 'BUY' as const, right: 'PE' as const, strike: 23150 }];
  assert.notEqual(computeCandidateHash(NIFTY_LEGS), computeCandidateHash(differentStrike));
});

test('computeIntentKey differs when candidateHash differs, even for the same symbol/expiry/strategy/day', () => {
  const base = { symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25' };
  const k1 = computeIntentKey({ ...base, candidateHash: 'aaa' });
  const k2 = computeIntentKey({ ...base, candidateHash: 'bbb' });
  assert.notEqual(k1, k2);
});

test('a single claim succeeds and returns a distinct intentKey/intentId', async () => {
  const store = new InMemoryOrderIntentStore();
  const result = await claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: NIFTY_LEGS, executionMode: 'PAPER',
  });
  assert.ok(result.claimed, JSON.stringify(result));
  if (!result.claimed) return;
  assert.ok(result.intentId);
  assert.ok(result.intentKey);
});

test('INVARIANT B: two concurrent identical entry attempts — exactly one claims, the other gets CONFLICT with zero further action', async () => {
  const store = new InMemoryOrderIntentStore();
  const attempt = () => claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: NIFTY_LEGS, executionMode: 'AUTO',
  });

  const [a, b] = await Promise.all([attempt(), attempt()]);
  const claimedCount = [a, b].filter((r) => r.claimed).length;
  const conflictCount = [a, b].filter((r) => !r.claimed && r.reason === 'CONFLICT').length;
  assert.equal(claimedCount, 1, `expected exactly 1 claim, got ${claimedCount}: ${JSON.stringify([a, b])}`);
  assert.equal(conflictCount, 1, `expected exactly 1 conflict, got ${conflictCount}`);
});

test('INVARIANT B, harder: five concurrent identical attempts — still exactly one winner', async () => {
  const store = new InMemoryOrderIntentStore();
  const attempt = () => claimOrderIntent(store, {
    symbol: 'BANKNIFTY', expiry: '2026-09-30', strategyLabel: 'Bear Call Spread', tradeDate: '2026-09-25',
    legs: [
      { side: 'SELL' as const, right: 'CE' as const, strike: 51000 },
      { side: 'BUY' as const, right: 'CE' as const, strike: 51500 },
    ], executionMode: 'AUTO',
  });

  const results = await Promise.all(Array.from({ length: 5 }, attempt));
  const claimedCount = results.filter((r) => r.claimed).length;
  assert.equal(claimedCount, 1, `expected exactly 1 winner out of 5 concurrent attempts, got ${claimedCount}`);
});

test('a genuinely different candidate (different strikes) on the same symbol/expiry/strategy/day does NOT collide', async () => {
  const store = new InMemoryOrderIntentStore();
  const first = await claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: NIFTY_LEGS, executionMode: 'PAPER',
  });
  assert.ok(first.claimed);

  const differentShape = await claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: [
      { side: 'SELL' as const, right: 'CE' as const, strike: 23800 }, // different strikes -> different candidate shape
      { side: 'BUY' as const, right: 'CE' as const, strike: 24100 },
      { side: 'SELL' as const, right: 'PE' as const, strike: 23300 },
      { side: 'BUY' as const, right: 'PE' as const, strike: 23100 },
    ], executionMode: 'PAPER',
  });
  assert.ok(differentShape.claimed, 'a distinct candidate shape must not be blocked by an unrelated open intent');
});

test('after an intent reaches a terminal status, the SAME candidate shape can be claimed again later the same day', async () => {
  const store = new InMemoryOrderIntentStore();
  const first = await claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: NIFTY_LEGS, executionMode: 'PAPER',
  });
  assert.ok(first.claimed);
  if (!first.claimed) return;

  // While still non-terminal, a second identical attempt must conflict.
  const whileOpen = await claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: NIFTY_LEGS, executionMode: 'PAPER',
  });
  assert.ok(!whileOpen.claimed && whileOpen.reason === 'CONFLICT');

  // Position closes; intent reaches a terminal status (COMPLETED).
  await store.updateStatus(first.intentId, { status: 'COMPLETED' });

  // A LEGITIMATE later entry of the identical shape (the market reverted to
  // the same strikes after the earlier position closed) must now succeed —
  // this is the exact "could incorrectly prevent legitimate later trades"
  // failure mode the task explicitly warned against.
  const afterClose = await claimOrderIntent(store, {
    symbol: 'NIFTY', expiry: '2026-09-30', strategyLabel: 'Iron Condor', tradeDate: '2026-09-25',
    legs: NIFTY_LEGS, executionMode: 'PAPER',
  });
  assert.ok(afterClose.claimed, 'a terminal (closed) intent must not block a later legitimate re-entry of the same shape');
});
