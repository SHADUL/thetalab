import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstValidToken, waitForValidToken } from '../live/kiteToken.ts';

const valid = (good: string) => async (t: string) => t === good;

test('token: the first source whose token Kite accepts wins', async () => {
  assert.equal(await firstValidToken([async () => 'db-fresh', async () => 'env-stale'], valid('db-fresh')), 'db-fresh');
});

test('token: a stale stored token falls through to the next source', async () => {
  assert.equal(await firstValidToken([async () => 'db-stale', async () => 'env-good'], valid('env-good')), 'env-good');
});

test('token: missing or throwing sources are skipped, never crash', async () => {
  assert.equal(await firstValidToken([async () => null, async () => { throw new Error('db down'); }, async () => 'ok'], valid('ok')), 'ok');
});

test('token: before the morning login it waits (announcing once), then picks up the fresh token', async () => {
  let current = 'yesterday';
  let waits = 0;
  let announced = 0;
  const token = await waitForValidToken([async () => current], valid('today'), {
    pollMs: 60_000, maxAttempts: 10,
    sleep: async () => { waits++; if (waits === 3) current = 'today'; },
    onWaiting: () => { announced++; },
  });
  assert.equal(token, 'today');
  assert.equal(announced, 1);
});

test('token: gives up only when told to (bounded attempts)', async () => {
  assert.equal(await waitForValidToken([async () => 'bad'], valid('good'), { pollMs: 1, maxAttempts: 2, sleep: async () => {} }), null);
});
