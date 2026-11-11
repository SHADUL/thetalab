import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneFor, createKiteThrottledFetch } from '../kiteThrottle.ts';

test('laneFor classifies only Kite GETs', () => {
  assert.equal(laneFor('https://api.kite.trade/quote?i=NSE:INFY'), 'quote');
  assert.equal(laneFor('https://api.kite.trade/quote/ltp?i=NSE:INFY'), 'quote');
  assert.equal(laneFor('https://api.kite.trade/instruments/historical/256265/day?from=a&to=b'), 'historical');
  assert.equal(laneFor('https://api.kite.trade/portfolio/positions'), 'other');
  assert.equal(laneFor('https://api.kite.trade/orders/regular', { method: 'POST' }), null);
  assert.equal(laneFor('https://api.kite.trade/orders/regular/1', { method: 'DELETE' }), null);
  assert.equal(laneFor('https://example.supabase.co/rest/v1/x'), null);
  assert.equal(laneFor(new URL('https://api.kite.trade/quote?i=x')), 'quote');
});

function harness(statuses: number[] = []) {
  let clock = 0;
  const calls: Array<{ url: string; at: number }> = [];
  const base = (async (input: any) => {
    calls.push({ url: String(input), at: clock });
    return new Response('{}', { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  const f = createKiteThrottledFetch(base, {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  return { f, calls, advance: (ms: number) => { clock += ms; } };
}

test('concurrent quote calls are spaced; other lanes are not held behind them', async () => {
  const seen: Array<{ url: string; at: number }> = [];
  const base = (async (input: any) => { seen.push({ url: String(input), at: Date.now() }); return new Response('{}'); }) as typeof fetch;
  const f = createKiteThrottledFetch(base, { spacingMs: { quote: 40, other: 0 } });
  const t0 = Date.now();
  await Promise.all([
    f('https://api.kite.trade/quote?i=a'),
    f('https://api.kite.trade/quote?i=b'),
    f('https://api.kite.trade/quote?i=c'),
    f('https://api.kite.trade/portfolio/positions'),
  ]);
  const q = seen.filter((s) => s.url.includes('/quote')).map((s) => s.at).sort((a, b) => a - b);
  for (let i = 1; i < q.length; i++) assert.ok(q[i] - q[i - 1] >= 35, `gap ${q[i] - q[i - 1]}`);
  const other = seen.find((s) => s.url.includes('positions'))!;
  assert.ok(other.at - t0 < 30);
});

test('order POSTs pass through immediately and are never retried', async () => {
  const { f, calls } = harness([200, 429]);
  await f('https://api.kite.trade/quote?i=a');
  const before = calls[0].at;
  const r = await f('https://api.kite.trade/orders/regular', { method: 'POST', body: 'x' });
  assert.equal(r.status, 429);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at, before); // no pacing delay on orders
});

test('GET 429 is retried with backoff, then succeeds', async () => {
  const { f, calls } = harness([429, 200]);
  const r = await f('https://api.kite.trade/portfolio/positions');
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 1_000);
});

test('GET 429 gives up after the retry budget', async () => {
  const { f, calls } = harness([429, 429, 429, 429]);
  const r = await f('https://api.kite.trade/quote?i=a');
  assert.equal(r.status, 429);
  assert.equal(calls.length, 3);
});
