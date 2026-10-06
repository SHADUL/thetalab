import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFiredSignal, sizeFromSettings, toSignalRecord } from '../worker/signalIntake.ts';
import { createInMemoryAlphaLadderStore, type AlphaLadderSettings } from '../persistence/store.ts';

const shadow5L: AlphaLadderSettings = { executionMode: 'SHADOW', allocatedCapital: 500_000, sizingMode: 'unit', configuredUnitQuantity: 0 };

const decision = {
  fired: true as const, path: 'crossing' as const, signalInstantSec: 4000, d1: 1 as const, d2: -1 as const, alpha: 0 as const,
  baseDirection: 1 as const, finalDirection: -1 as const, area1: 100, area2: -10, g1AtSignal: 50, g2AtSignal: -9.1,
  crossingTimeSec: 4000, crossingG2Value: -9.1, vixValue: 12, vixAvailable: true, variationCActed: true,
};

test('sizing: ₹5L SHADOW allocation -> 1 unit (floor(500000/340000))', () => {
  assert.equal(sizeFromSettings(shadow5L).units, 1);
});

test('sizing: no settings row -> 0 units, never a guess', () => {
  assert.equal(sizeFromSettings(null).units, 0);
});

test('sizing: AUTO mode is locked — sizes to 0 regardless of allocation', () => {
  assert.equal(sizeFromSettings({ ...shadow5L, executionMode: 'AUTO', allocatedCapital: 5_000_000 }).units, 0);
});

test('sizing: allocation below one unit -> 0', () => {
  assert.equal(sizeFromSettings({ ...shadow5L, allocatedCapital: 300_000 }).units, 0);
});

test('signal record: Wednesday week key is the date itself', () => {
  assert.equal(toSignalRecord(decision, '2026-10-07', 1).weekKey, '2026-10-07');
});

test('intake: records the signal once and sizes it from the ₹5L allocation', async () => {
  const store = createInMemoryAlphaLadderStore(shadow5L);
  const r = await handleFiredSignal(store, decision, '2026-10-07', 1);
  assert.equal(r.recorded, true);
  assert.equal(r.sizing.units, 1);
  assert.ok(await store.getSignalByWeekKey('2026-10-07'));
});

test('intake: the per-minute re-fire for the same week is a no-op (idempotent)', async () => {
  const store = createInMemoryAlphaLadderStore(shadow5L);
  await handleFiredSignal(store, decision, '2026-10-07', 1);
  const second = await handleFiredSignal(store, decision, '2026-10-07', 2);
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, true);
});
