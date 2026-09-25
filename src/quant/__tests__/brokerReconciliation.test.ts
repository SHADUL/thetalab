import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile, type DbPositionSummary, type BrokerPosition, type BrokerOrder } from '../execution/brokerReconciliation.ts';

const EMPTY = { dbActivePositions: [], dbPendingReconciliation: [], openIntents: [], brokerPositions: [], brokerOrders: [] };

const IC_POSITION: DbPositionSummary = {
  id: 1, symbol: 'NIFTY', expiry: '2026-09-30',
  legs: [
    { tradingsymbol: 'NIFTY26S3023700CE', side: 'SELL', quantity: 75, strike: 23700, right: 'CE' },
    { tradingsymbol: 'NIFTY26S3024000CE', side: 'BUY', quantity: 75, strike: 24000, right: 'CE' },
    { tradingsymbol: 'NIFTY26S3023400PE', side: 'SELL', quantity: 75, strike: 23400, right: 'PE' },
    { tradingsymbol: 'NIFTY26S3023200PE', side: 'BUY', quantity: 75, strike: 23200, right: 'PE' },
  ],
};

function brokerPositionsFor(pos: DbPositionSummary): BrokerPosition[] {
  return pos.legs.map((l) => ({ tradingsymbol: l.tradingsymbol, quantity: l.side === 'BUY' ? l.quantity : -l.quantity }));
}

test('SAFE_NO_POSITION: nothing open anywhere', () => {
  const result = reconcile(EMPTY);
  assert.equal(result.status, 'SAFE_NO_POSITION');
  assert.equal(result.findings.length, 0);
});

test('MATCHED: DB active position exactly matches broker positions, no stray orders', () => {
  const result = reconcile({
    ...EMPTY,
    dbActivePositions: [IC_POSITION],
    brokerPositions: brokerPositionsFor(IC_POSITION),
    brokerOrders: [
      { orderId: 'o1', tradingsymbol: 'NIFTY26S3023700CE', status: 'COMPLETE', transactionType: 'SELL', quantity: 75, filledQuantity: 75 },
    ],
  });
  assert.equal(result.status, 'MATCHED');
  assert.equal(result.findings.length, 0);
});

test('MISMATCH: DB position exists but broker holds nothing for one leg', () => {
  const partialBroker = brokerPositionsFor(IC_POSITION).slice(0, 3); // missing one leg
  const result = reconcile({ ...EMPTY, dbActivePositions: [IC_POSITION], brokerPositions: partialBroker });
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some((f) => f.code === 'DB_POSITION_MISSING_AT_BROKER'));
});

test('MISMATCH: broker holds a position the DB has never heard of (orphan short)', () => {
  const result = reconcile({
    ...EMPTY,
    brokerPositions: [{ tradingsymbol: 'NIFTY26S3023000PE', quantity: -75 }], // net short, no DB record
  });
  assert.equal(result.status, 'MISMATCH');
  const finding = result.findings.find((f) => f.code === 'ORPHAN_SHORT');
  assert.ok(finding, JSON.stringify(result.findings));
});

test('MISMATCH: broker holds an unrecognized LONG position (orphan hedge)', () => {
  const result = reconcile({
    ...EMPTY,
    brokerPositions: [{ tradingsymbol: 'NIFTY26S3025000CE', quantity: 75 }],
  });
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some((f) => f.code === 'ORPHAN_HEDGE'));
});

test('MISMATCH: unexpected quantity at the broker', () => {
  const broker = brokerPositionsFor(IC_POSITION);
  broker[0] = { ...broker[0], quantity: -150 }; // DB expects 75, broker shows 150
  const result = reconcile({ ...EMPTY, dbActivePositions: [IC_POSITION], brokerPositions: broker });
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some((f) => f.code === 'QUANTITY_MISMATCH'));
});

test('MISMATCH: unexpected side at the broker (DB says SELL, broker sign implies BUY)', () => {
  const broker = brokerPositionsFor(IC_POSITION);
  broker[0] = { ...broker[0], quantity: 75 }; // DB leg is SELL(-75 expected), broker shows +75
  const result = reconcile({ ...EMPTY, dbActivePositions: [IC_POSITION], brokerPositions: broker });
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some((f) => f.code === 'SIDE_MISMATCH'));
});

test('RECONCILIATION_REQUIRED: an ABANDONED intent blocks even with a clean position match', () => {
  const result = reconcile({
    ...EMPTY,
    dbActivePositions: [IC_POSITION],
    brokerPositions: brokerPositionsFor(IC_POSITION),
    openIntents: [{ id: 'intent-1', symbol: 'BANKNIFTY', status: 'ABANDONED', intentKey: 'k', ageMs: 120_000 }],
  });
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.ok(result.findings.some((f) => f.code === 'ABANDONED_INTENT'));
});

test('RECONCILIATION_REQUIRED: a position already flagged elsewhere for manual reconciliation blocks new entries', () => {
  const result = reconcile({ ...EMPTY, dbPendingReconciliation: [IC_POSITION] });
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.ok(result.findings.some((f) => f.code === 'KNOWN_RECONCILIATION_PENDING'));
});

test('MISMATCH: an OPEN order at the broker not yet reflected as a position (unambiguous status, still blocking)', () => {
  const order: BrokerOrder = { orderId: 'o2', tradingsymbol: 'SENSEX26O0875000CE', status: 'OPEN', transactionType: 'SELL', quantity: 20, filledQuantity: 0 };
  const result = reconcile({ ...EMPTY, brokerOrders: [order] });
  assert.equal(result.status, 'MISMATCH'); // OPEN_ORDER_UNTRACKED is 'blocking' but not in the trulyAmbiguous set
  assert.ok(result.findings.some((f) => f.code === 'OPEN_ORDER_UNTRACKED'));
});

test('RECONCILIATION_REQUIRED: a PARTIALLY FILLED order at the broker', () => {
  const order: BrokerOrder = { orderId: 'o3', tradingsymbol: 'SENSEX26O0875000CE', status: 'PARTIALLY FILLED', transactionType: 'SELL', quantity: 20, filledQuantity: 10 };
  const result = reconcile({ ...EMPTY, brokerOrders: [order] });
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.ok(result.findings.some((f) => f.code === 'PARTIALLY_FILLED_ORDER'));
});

test('RECONCILIATION_REQUIRED: an UNKNOWN/ambiguous broker order status', () => {
  const order: BrokerOrder = { orderId: 'o4', tradingsymbol: 'SENSEX26O0875000CE', status: 'UNKNOWN', transactionType: 'SELL', quantity: 20, filledQuantity: 0 };
  const result = reconcile({ ...EMPTY, brokerOrders: [order] });
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.ok(result.findings.some((f) => f.code === 'AMBIGUOUS_ORDER_STATUS'));
});

test('REJECTED and CANCELLED orders are informational only — do not block on their own', () => {
  const rejected: BrokerOrder = { orderId: 'o5', tradingsymbol: 'NIFTY26S3023700CE', status: 'REJECTED', transactionType: 'SELL', quantity: 75, filledQuantity: 0 };
  const cancelled: BrokerOrder = { orderId: 'o6', tradingsymbol: 'NIFTY26S3023700CE', status: 'CANCELLED', transactionType: 'SELL', quantity: 75, filledQuantity: 0 };
  const result = reconcile({ ...EMPTY, brokerOrders: [rejected, cancelled] });
  assert.equal(result.status, 'SAFE_NO_POSITION');
  assert.ok(result.findings.every((f) => f.severity === 'info'));
  assert.equal(result.findings.length, 2);
});

test('never suggests flattening an unknown position — findings are descriptive only, no action field', () => {
  const result = reconcile({ ...EMPTY, brokerPositions: [{ tradingsymbol: 'X', quantity: -75 }] });
  for (const f of result.findings) {
    assert.ok(!('action' in f), 'a finding must never carry an executable action');
  }
});
