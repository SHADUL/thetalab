import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotShadowMode, CriticalShadowInvariantError } from '../execution/shadowSafetyGuard.ts';

test('SHADOW mode: any attempted broker mutation throws a hard CriticalShadowInvariantError', async () => {
  await assert.rejects(() => assertNotShadowMode('SHADOW', 'placeOrder'), CriticalShadowInvariantError);
});

test('SHADOW mode: the guard logs a CRITICAL event before throwing', async () => {
  const logged: Array<{ message: string; detail: unknown }> = [];
  const logger = { logCritical: async (message: string, detail: unknown) => { logged.push({ message, detail }); } };
  await assert.rejects(() => assertNotShadowMode('SHADOW', 'modifyOrder', logger));
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /CRITICAL_SHADOW_INVARIANT/);
  assert.deepEqual(logged[0].detail, { action: 'modifyOrder', mode: 'SHADOW' });
});

test('a logger failure never suppresses the hard throw — the throw is the real safety mechanism', async () => {
  const failingLogger = { logCritical: async () => { throw new Error('log sink down'); } };
  await assert.rejects(() => assertNotShadowMode('SHADOW', 'cancelOrder', failingLogger), CriticalShadowInvariantError);
});

test('AUTO mode does not trip the guard (Milestone 5 concern, not Milestone 3 — this guard only ever protects SHADOW)', async () => {
  await assert.doesNotReject(() => assertNotShadowMode('AUTO', 'placeOrder'));
});
