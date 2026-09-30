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

test('KiteAlphaLadderDepthSource: reconnecting bumps connectionGeneration', async () => {
  let sockets: FakeSocket[] = [];
  const source = new KiteAlphaLadderDepthSource({
    apiKey: 'k', accessToken: 't', wsFactory: (url) => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  await source.connect();
  assert.equal(source.getHealth().connectionGeneration, 1);
  await source.connect(); // simulate the worker's own reconnect loop calling connect() again
  assert.equal(source.getHealth().connectionGeneration, 2);
});
