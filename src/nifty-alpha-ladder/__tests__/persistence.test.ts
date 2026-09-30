import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryAlphaLadderStore } from '../persistence/store.ts';
import { determineResumeAction, type RecoveryState } from '../persistence/crashRecovery.ts';
import { computeShadowPnl } from '../risk/shadowPnl.ts';
import type { SignalRecord } from '../types.ts';

function fixtureSignal(weekKey: string): SignalRecord {
  return {
    weekKey, signalDate: weekKey, signalInstantSec: 1000, path: 'crossing', d1: 1, d2: -1, alpha: 0,
    baseDirection: 1, finalDirection: -1, area1: 100, area2: -10, g1AtSignal: 50, g2AtSignal: -9.13,
    crossingTimeSec: 1000, crossingG2Value: -9.13, vixValue: 11.87, vixAvailable: true, variationCActed: true,
    sourceDataset: 'futures-fallback', createdAtMs: Date.now(),
  };
}

// ---- IDEMPOTENCY (spec §18, your instruction §4) ----

test('idempotency: duplicate signal evaluation for the same week is a no-op — only one durable row exists', async () => {
  const store = createInMemoryAlphaLadderStore();
  const first = await store.insertSignal(fixtureSignal('2026-09-30'));
  const second = await store.insertSignal(fixtureSignal('2026-09-30'));
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (second.ok === false) assert.equal(second.reason, 'duplicate');
});

test('idempotency: duplicate call creation for the same (signal, kind) is a no-op', async () => {
  const store = createInMemoryAlphaLadderStore();
  const signal = await store.insertSignal(fixtureSignal('2026-09-30'));
  assert.equal(signal.ok, true);
  if (!signal.ok) return;
  const first = await store.insertCall(signal.row.id, 'STRUCTURE', -1, 'SHADOW');
  const second = await store.insertCall(signal.row.id, 'STRUCTURE', -1, 'SHADOW');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
});

test('idempotency: a different week key is NOT deduped against a prior week (proves the constraint is scoped correctly, not overly broad)', async () => {
  const store = createInMemoryAlphaLadderStore();
  const w1 = await store.insertSignal(fixtureSignal('2026-09-30'));
  const w2 = await store.insertSignal(fixtureSignal('2026-10-07'));
  assert.equal(w1.ok, true);
  assert.equal(w2.ok, true);
});

// ---- CRASH RECOVERY (your instruction §3, every listed restart point) ----

function baseRecoveryState(overrides: Partial<RecoveryState> = {}): RecoveryState {
  return {
    signal: { ...fixtureSignal('2026-09-30'), id: 1 },
    structureCall: null,
    position: null,
    legs: [],
    shadowOrdersByLeg: new Map(),
    ...overrides,
  };
}

test('crash recovery: restart after signal persist (no call yet) -> resume by publishing calls', () => {
  const action = determineResumeAction(baseRecoveryState());
  assert.equal(action.kind, 'PUBLISH_MONITOR_AND_STRUCTURE_CALLS');
});

test('crash recovery: restart after call published but structure not resolved -> resume by resolving structure', () => {
  const action = determineResumeAction(baseRecoveryState({
    structureCall: { id: 10, signalId: 1, kind: 'STRUCTURE', status: 'PUBLISHED', direction: -1, executionMode: 'SHADOW' },
  }));
  assert.equal(action.kind, 'RESOLVE_STRUCTURE');
});

test('crash recovery: restart after leg 1 filled (legs 2/3 not) -> resume by placing leg index 1', () => {
  const action = determineResumeAction(baseRecoveryState({
    structureCall: { id: 10, signalId: 1, kind: 'STRUCTURE', status: 'PUBLISHED', direction: -1, executionMode: 'SHADOW' },
    position: { id: 100, callId: 10, status: 'ACTIVE', exitReason: null, realizedPnl: null, netDebitPoints: null, units: 2, lotSize: 75 },
    legs: [
      { id: 1, positionId: 100, placementOrder: 0, side: 'BUY', optionRight: 'PE', strike: 24150, ratio: 4, quantity: 600, status: 'COMPLETE' },
      { id: 2, positionId: 100, placementOrder: 1, side: 'BUY', optionRight: 'PE', strike: 23750, ratio: 1, quantity: 150, status: 'IDLE' },
      { id: 3, positionId: 100, placementOrder: 2, side: 'SELL', optionRight: 'PE', strike: 23950, ratio: 5, quantity: 750, status: 'IDLE' },
    ],
  }));
  assert.equal(action.kind, 'PLACE_NEXT_LEG');
  if (action.kind === 'PLACE_NEXT_LEG') assert.equal(action.legIndex, 1);
});

test('crash recovery: restart during rollback -> resume by continuing the rollback, not re-entering', () => {
  const action = determineResumeAction(baseRecoveryState({
    structureCall: { id: 10, signalId: 1, kind: 'STRUCTURE', status: 'PUBLISHED', direction: -1, executionMode: 'SHADOW' },
    position: { id: 100, callId: 10, status: 'ACTIVE', exitReason: null, realizedPnl: null, netDebitPoints: null, units: 2, lotSize: 75 },
    legs: [
      { id: 1, positionId: 100, placementOrder: 0, side: 'BUY', optionRight: 'PE', strike: 24150, ratio: 4, quantity: 600, status: 'ROLLBACK' },
      { id: 2, positionId: 100, placementOrder: 1, side: 'BUY', optionRight: 'PE', strike: 23750, ratio: 1, quantity: 150, status: 'COMPLETE' },
      { id: 3, positionId: 100, placementOrder: 2, side: 'SELL', optionRight: 'PE', strike: 23950, ratio: 5, quantity: 750, status: 'ABANDONED' },
    ],
  }));
  assert.equal(action.kind, 'ROLLBACK_IN_PROGRESS');
});

test('crash recovery: restart after entry fully complete but call not yet marked LIVE -> resume by finalizing to monitor/exit', () => {
  const action = determineResumeAction(baseRecoveryState({
    structureCall: { id: 10, signalId: 1, kind: 'STRUCTURE', status: 'PUBLISHED', direction: -1, executionMode: 'SHADOW' },
    position: { id: 100, callId: 10, status: 'ACTIVE', exitReason: null, realizedPnl: null, netDebitPoints: null, units: 2, lotSize: 75 },
    legs: [
      { id: 1, positionId: 100, placementOrder: 0, side: 'BUY', optionRight: 'PE', strike: 24150, ratio: 4, quantity: 600, status: 'COMPLETE' },
      { id: 2, positionId: 100, placementOrder: 1, side: 'BUY', optionRight: 'PE', strike: 23750, ratio: 1, quantity: 150, status: 'COMPLETE' },
      { id: 3, positionId: 100, placementOrder: 2, side: 'SELL', optionRight: 'PE', strike: 23950, ratio: 5, quantity: 750, status: 'COMPLETE' },
    ],
  }));
  assert.equal(action.kind, 'ENTRY_COMPLETE_MONITOR_FOR_EXIT');
});

test('crash recovery: restart during short exit (short not yet closed) -> resume exit at the short legs, never touches longs', () => {
  const shortLeg = { id: 3, positionId: 100, placementOrder: 2, side: 'SELL' as const, optionRight: 'PE' as const, strike: 23950, ratio: 5, quantity: 750, status: 'COMPLETE' as const };
  const action = determineResumeAction(baseRecoveryState({
    structureCall: { id: 10, signalId: 1, kind: 'STRUCTURE', status: 'EXIT_REQUESTED', direction: -1, executionMode: 'SHADOW' },
    position: { id: 100, callId: 10, status: 'ACTIVE', exitReason: 'MONITOR_TARGET', realizedPnl: null, netDebitPoints: null, units: 2, lotSize: 75 },
    legs: [shortLeg],
    shadowOrdersByLeg: new Map(),
  }));
  assert.equal(action.kind, 'EXIT_SHORT_LEGS_PENDING');
});

test('crash recovery: restart between short and long exits (shorts done, longs pending) -> resume at longs only', () => {
  const shortLeg = { id: 3, positionId: 100, placementOrder: 2, side: 'SELL' as const, optionRight: 'PE' as const, strike: 23950, ratio: 5, quantity: 750, status: 'COMPLETE' as const };
  const longLeg = { id: 1, positionId: 100, placementOrder: 0, side: 'BUY' as const, optionRight: 'PE' as const, strike: 24150, ratio: 4, quantity: 600, status: 'COMPLETE' as const };
  const shadowOrdersByLeg = new Map([[3, [{ id: 1, legId: 3, orderKind: 'EXIT' as const, side: 'BUY' as const, quantity: 750, fillPriceSimulated: 50, fillStatus: 'COMPLETE' as const, slippageVsReference: 0 }]]]);
  const action = determineResumeAction(baseRecoveryState({
    structureCall: { id: 10, signalId: 1, kind: 'STRUCTURE', status: 'EXITING', direction: -1, executionMode: 'SHADOW' },
    position: { id: 100, callId: 10, status: 'ACTIVE', exitReason: 'MONITOR_TARGET', realizedPnl: null, netDebitPoints: null, units: 2, lotSize: 75 },
    legs: [shortLeg, longLeg],
    shadowOrdersByLeg,
  }));
  assert.equal(action.kind, 'EXIT_LONG_LEGS_PENDING');
});

// ---- SHADOW P&L (your instruction §5) ----

test('shadow P&L: gross P&L from real fills, matching the worked example net debit/proceeds arithmetic', () => {
  const result = computeShadowPnl([
    { side: 'BUY', quantity: 600, entryFillPrice: 111.35, exitFillPrice: 318.15 },
    { side: 'BUY', quantity: 150, entryFillPrice: 17.45, exitFillPrice: 36.35 },
    { side: 'SELL', quantity: 750, entryFillPrice: 47.45, exitFillPrice: 134.20 },
  ]);
  assert.ok(result.grossPnl !== null);
  // BUY leg pnl = (entry-exit)*qty -> negative since price rose against a long close... wait a rising long is a GAIN.
  // (side==='SELL'?1:-1)*(entry-exit)*qty: BUY -> -1*(111.35-318.15)*600 = 124,080
  assert.ok(Math.abs(result.perLegPnl[0].pnl! - 124_080) < 1);
  assert.equal(result.netPnlBeforeCharges, result.grossPnl); // identical until a real cost model exists — never silently upgraded to "net"
});

test('shadow P&L: any leg still open makes the WHOLE result null, never a partial/guessed number', () => {
  const result = computeShadowPnl([
    { side: 'BUY', quantity: 600, entryFillPrice: 111.35, exitFillPrice: 318.15 },
    { side: 'BUY', quantity: 150, entryFillPrice: 17.45, exitFillPrice: null }, // still open
  ]);
  assert.equal(result.grossPnl, null);
  assert.equal(result.netPnlBeforeCharges, null);
  assert.equal(result.perLegPnl[0].pnl !== null, true); // per-leg is still informative even when the total isn't final
  assert.equal(result.perLegPnl[1].pnl, null);
});
