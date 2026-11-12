import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { packetExchangeTs, decodePacket, marketStream } from '../marketStream.ts';
import { TickRecorder } from '../niftyPulseRecorder.ts';

test('packetExchangeTs reads index-full and F&O-full exchange timestamps', () => {
  const idx = Buffer.alloc(32);
  idx.writeUInt32BE(256265, 0);
  idx.writeInt32BE(2500000, 4);
  idx.writeInt32BE(1_794_000_000, 28);
  assert.equal(packetExchangeTs(idx), 1_794_000_000_000);
  const fo = Buffer.alloc(184);
  fo.writeInt32BE(1_794_000_001, 60);
  assert.equal(packetExchangeTs(fo), 1_794_000_001_000);
  assert.equal(packetExchangeTs(Buffer.alloc(28)), null);
  assert.equal(packetExchangeTs(Buffer.alloc(8)), null);
  // Existing decode output is unchanged (no new fields).
  assert.deepEqual(Object.keys(decodePacket(idx, 1)!).sort(), ['ask', 'bid', 'depth', 'ltp', 'oi', 'receivedAt', 'token', 'volume']);
});

test('marketStream.onQuote adds an observer without opening a connection', () => {
  const off = marketStream.onQuote(() => {});
  assert.equal(marketStream.status().connected, false);
  off();
});

test('recorder writes gzip NDJSON per IST day/hour and enforces retention', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'np-rec-'));
  const now = Date.parse('2026-11-13T10:05:00+05:30');
  mkdirSync(path.join(dir, '2026-10-01'));
  writeFileSync(path.join(dir, '2026-10-01', '10.ndjson.gz'), 'x');
  const rec = new TickRecorder({ dir, retentionDays: 10, maxBytes: 100 * 1024 * 1024, minFreeBytes: 1, now: () => now, freeBytes: async () => 10 * 1024 ** 3 });
  await rec.start();
  assert.equal(existsSync(path.join(dir, '2026-10-01')), false, 'old day removed by retention');
  rec.record({ token: 256265, ltp: 25000.5, bid: null, ask: null, depth: null, receivedAt: now }, now - 400, 'INDEX');
  rec.record({ token: 1001, ltp: 101.2, bid: 101.1, ask: 101.3, depth: { buy: [{ price: 101.1, quantity: 650 }], sell: [{ price: 101.3, quantity: 325 }] }, receivedAt: now + 5 }, null, 'OPTION');
  await rec.stop();
  const file = path.join(dir, '2026-11-13', '10.ndjson.gz');
  const lines = zlib.gunzipSync(readFileSync(file)).toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], ['I', 256265, 25000.5, null, null, null, null, null, null, now - 400, now]);
  assert.deepEqual(lines[1].slice(0, 7), ['O', 1001, 101.2, 101.1, 101.3, 650, 325]);
  assert.equal(rec.status().linesThisProcess, 2);
});

test('recorder pauses when the disk is low and drops instead of writing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'np-rec-'));
  const now = Date.parse('2026-11-13T10:05:00+05:30');
  const rec = new TickRecorder({ dir, retentionDays: 10, maxBytes: 1024 ** 3, minFreeBytes: 5 * 1024 ** 3, now: () => now, freeBytes: async () => 1024 ** 3 });
  await rec.start();
  rec.record({ token: 256265, ltp: 1, bid: null, ask: null, depth: null, receivedAt: now }, null, 'INDEX');
  await rec.stop();
  const st = rec.status();
  assert.equal(st.recording, false);
  assert.match(String(st.paused), /free on disk/);
  assert.equal(st.dropped, 1);
  assert.equal(readdirSync(dir).length, 0);
});

test('recorder: size cap deletes oldest days first, never today', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'np-rec-'));
  const now = Date.parse('2026-11-13T10:05:00+05:30');
  for (const d of ['2026-11-11', '2026-11-12', '2026-11-13']) { mkdirSync(path.join(dir, d)); writeFileSync(path.join(dir, d, '10.ndjson.gz'), Buffer.alloc(600)); }
  const rec = new TickRecorder({ dir, retentionDays: 10, maxBytes: 1000, minFreeBytes: 1, now: () => now, freeBytes: async () => 1024 ** 3 });
  await rec.start();
  await rec.stop();
  assert.deepEqual(readdirSync(dir).sort(), ['2026-11-13']);
  assert.equal(rec.status().recording, true);
});

test('paper-only: NIFTY PULSE server and API files contain no order-placement code', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = ['server/niftyPulse.ts', 'server/niftyPulseRecorder.ts', 'server/niftyPulseStore.ts', 'api/nifty-pulse.ts'];
  const banned = [/\/orders\b/, /place_?order/i, /kiteconnect/i, /api\.kite\.trade/, /transaction_type/i];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), 'utf8');
    for (const re of banned) assert.ok(!re.test(src), `${f} matches ${re}`);
  }
  // The API never returns credentials.
  const api = readFileSync(path.join(root, 'api/nifty-pulse.ts'), 'utf8');
  assert.ok(!/access_token|api_key|KITE_API_KEY/.test(api));
});
