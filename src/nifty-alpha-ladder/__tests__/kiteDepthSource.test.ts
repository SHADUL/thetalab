import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KiteAlphaLadderDepthSource, type WebSocketLike } from '../live/kiteDepthSource.ts';
import type { NormalizedDepthTick } from '../live/depthSource.ts';

/** A fake WebSocket — proves connect/subscribe/message/reconnect logic without ever opening a real socket, per your instruction to test with mocks. */
class FakeSocket implements WebSocketLike {
  public sent: string[] = [];
  private handlers: Record<string, Array<(...a: any[]) => void>> = {};
  send(data: string) { this.sent.push(data); }
  close() { this.emit('close'); }
  on(event: string, handler: (...a: any[]) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
  emit(event: string, ...args: any[]) {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
}

function buildMinimalFrame(instrumentToken: number): Buffer {
  const packet = Buffer.alloc(184);
  packet.writeUInt32BE(instrumentToken, 0);
  packet.writeInt32BE(2282200, 4); // 22,822.00
  // one bid level, one ask level, rest zeroed (filtered out as empty slots)
  packet.writeInt32BE(260, 64); packet.writeInt32BE(2281560, 68); packet.writeInt16BE(2, 72);
  packet.writeInt32BE(65, 124); packet.writeInt32BE(2282000, 128); packet.writeInt16BE(1, 132); // ask depth starts at offset 64+5*12=124
  const count = Buffer.alloc(2); count.writeInt16BE(1, 0);
  const len = Buffer.alloc(2); len.writeInt16BE(packet.length, 0);
  return Buffer.concat([count, len, packet]);
}

test('KiteAlphaLadderDepthSource: connect -> subscribe sends both subscribe and mode-full messages', async () => {
  let createdSocket: FakeSocket | null = null;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', wsFactory: (url) => { createdSocket = new FakeSocket(); return createdSocket; },
  });
  await source.connect();
  await source.subscribe({ tradingsymbol: 'NIFTY26OCTFUT', instrumentToken: 12468226, expiry: '2026-10-27' });
  createdSocket!.emit('open');
  assert.equal(createdSocket!.sent.length, 2);
  assert.match(createdSocket!.sent[0], /"a":"subscribe"/);
  assert.match(createdSocket!.sent[1], /"a":"mode"/);
});

test('KiteAlphaLadderDepthSource: a real depth frame reaches the registered handler as NormalizedDepthTick[]', async () => {
  let createdSocket: FakeSocket | null = null;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', wsFactory: (url) => { createdSocket = new FakeSocket(); return createdSocket; },
  });
  const received: NormalizedDepthTick[][] = [];
  source.onDepthSnapshot((ticks) => received.push(ticks));
  await source.connect();
  createdSocket!.emit('open');
  createdSocket!.emit('message', buildMinimalFrame(12468226));
  assert.equal(received.length, 1);
  const ticks = received[0];
  assert.equal(ticks.some((t) => t.side === 'b' && t.price === 22815.6 && t.orderCount === 2), true);
  assert.equal(ticks.some((t) => t.side === 'a' && t.price === 22820 && t.orderCount === 1), true);
});

test('KiteAlphaLadderDepthSource: health status transitions CONNECTING -> WARMING_UP -> HEALTHY as messages arrive, never HEALTHY from a bare open', async () => {
  let createdSocket: FakeSocket | null = null;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', wsFactory: (url) => { createdSocket = new FakeSocket(); return createdSocket; },
  });
  assert.equal(source.getHealth().status, 'STARTING');
  await source.connect();
  assert.equal(source.getHealth().status, 'CONNECTING');
  createdSocket!.emit('open');
  assert.equal(source.getHealth().status, 'WARMING_UP'); // open alone is NOT healthy
  createdSocket!.emit('message', buildMinimalFrame(12468226));
  assert.equal(source.getHealth().status, 'HEALTHY');
});

test('KiteAlphaLadderDepthSource: a close event increments reconnectCount and reports RECONNECTING', async () => {
  let createdSocket: FakeSocket | null = null;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', wsFactory: (url) => { createdSocket = new FakeSocket(); return createdSocket; },
  });
  await source.connect();
  createdSocket!.emit('open');
  createdSocket!.emit('close');
  const health = source.getHealth();
  assert.equal(health.status, 'RECONNECTING');
  assert.equal(health.reconnectCount, 1);
});

test('KiteAlphaLadderDepthSource: calling connect() again (e.g. after a full worker restart) bumps connectionGeneration', async () => {
  let sockets: FakeSocket[] = [];
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.connect();
  assert.equal(source.getHealth().connectionGeneration, 1);
  await source.connect();
  assert.equal(source.getHealth().connectionGeneration, 2);
});

test('KiteAlphaLadderDepthSource: a dropped connection reconnects ITSELF automatically — no external caller needs to notice RECONNECTING and call connect() again', async () => {
  // Missing entirely until this milestone's first real Railway deployment:
  // the 'close' handler updated status/reconnectCount but never actually
  // re-opened a socket, and worker/main.ts never called connect() a second
  // time either — so a single disconnect silently killed the feed forever
  // until a human manually restarted the whole process.
  const sockets: FakeSocket[] = [];
  const scheduled: Array<() => void> = [];
  const fakeSetTimeout = ((fn: () => void) => { scheduled.push(fn); return 0 as any; }) as typeof setTimeout;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', setTimeoutFn: fakeSetTimeout,
    wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.subscribe({ tradingsymbol: 'NIFTY26OCTFUT', instrumentToken: 12468226, expiry: '2026-10-27' });
  await source.connect();
  sockets[0].emit('open');
  assert.equal(source.getHealth().connectionGeneration, 1);

  sockets[0].emit('close'); // the connection drops
  assert.equal(source.getHealth().status, 'RECONNECTING');
  assert.equal(scheduled.length, 1); // a reconnect was scheduled, not left to a caller to notice

  scheduled[0](); // let the scheduled reconnect fire
  assert.equal(sockets.length, 2); // a SECOND real socket was actually opened
  assert.equal(source.getHealth().connectionGeneration, 2);

  sockets[1].emit('open');
  assert.equal(sockets[1].sent.length, 2); // re-subscribed automatically using the remembered instrument
  assert.match(sockets[1].sent[0], /"a":"subscribe"/);
});

test('KiteAlphaLadderDepthSource: an intentional disconnect() does NOT schedule a reconnect', async () => {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<() => void> = [];
  const fakeSetTimeout = ((fn: () => void) => { scheduled.push(fn); return 0 as any; }) as typeof setTimeout;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', setTimeoutFn: fakeSetTimeout,
    wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.connect();
  sockets[0].emit('open');
  await source.disconnect(); // this internally emits 'close' on the fake socket too
  assert.equal(scheduled.length, 0);
});

test('KiteAlphaLadderDepthSource: reconnect delay backs off exponentially on repeated failures, capped at a max', async () => {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const fakeSetTimeout = ((fn: () => void, ms: number) => { delays.push(ms); fn(); return 0 as any; }) as unknown as typeof setTimeout;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', setTimeoutFn: fakeSetTimeout,
    wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.connect();
  // Fail repeatedly WITHOUT ever opening/receiving a message — each
  // failure should back off further than the last, not retry at the same
  // flat interval forever (the exact bug that turned one bad connection
  // into ~370 rapid-fire attempts on the first real deployment).
  for (let i = 0; i < 5; i++) sockets[sockets.length - 1].emit('close');
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 48000]);
});

test('KiteAlphaLadderDepthSource: a successful message resets the backoff — a later drop retries fast again, not at whatever backoff an earlier incident reached', async () => {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const fakeSetTimeout = ((fn: () => void, ms: number) => { delays.push(ms); fn(); return 0 as any; }) as unknown as typeof setTimeout;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', setTimeoutFn: fakeSetTimeout,
    wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.connect();
  sockets[0].emit('close'); // one failure, backs off to 3000
  sockets[1].emit('open');
  sockets[1].emit('message', buildMinimalFrame(12468226)); // a real message — resets the counter
  sockets[1].emit('close'); // this failure should back off from ZERO again, not continue from the prior incident
  assert.deepEqual(delays, [3000, 3000]);
});

test('KiteAlphaLadderDepthSource: gives up after too many consecutive failures and reports FAILED — never hammers the server forever', async () => {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const fakeSetTimeout = ((fn: () => void, ms: number) => { delays.push(ms); fn(); return 0 as any; }) as unknown as typeof setTimeout;
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', setTimeoutFn: fakeSetTimeout,
    wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.connect();
  for (let i = 0; i < 20; i++) {
    if (source.getHealth().status === 'FAILED') break;
    sockets[sockets.length - 1].emit('close');
  }
  assert.equal(source.getHealth().status, 'FAILED');
  const attemptsBeforeGivingUp = sockets.length;
  // Emitting more closes past this point must NOT schedule any further attempts.
  const delaysBeforeGivingUp = delays.length;
  sockets[sockets.length - 1].emit('close');
  assert.equal(sockets.length, attemptsBeforeGivingUp); // no new socket was opened
  assert.equal(delays.length, delaysBeforeGivingUp); // no new reconnect was scheduled
});
