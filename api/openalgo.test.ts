import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAlgoStatus } from './openalgo.ts';

const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('openAlgoStatus: reads needs_setup, caches 15 s, reports down without throwing', async () => {
  const a = await openAlgoStatus(1_000_000, ok({ needs_setup: true, status: 'success' }));
  assert.equal(a.up, true); assert.equal(a.needsSetup, true); assert.match(a.url, /^https:\/\/openalgo\./);
  const cached = await openAlgoStatus(1_010_000, ok({ needs_setup: false }));
  assert.equal(cached.needsSetup, true, 'cached within 15 s');
  const b = await openAlgoStatus(1_020_000, ok({ needs_setup: false }));
  assert.equal(b.needsSetup, false);
  const down = await openAlgoStatus(1_040_000, (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch);
  assert.equal(down.up, false); assert.equal(down.needsSetup, null); assert.match(down.error!, /ECONNREFUSED/);
  const bad = await openAlgoStatus(1_060_000, ok({}, 502));
  assert.equal(bad.up, false); assert.equal(bad.error, 'HTTP 502');
});
