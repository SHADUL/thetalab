import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ObserveArchive, archiveOptionsFromEnv } from '../niftyAscentArchive.ts';

const NOW = Date.parse('2026-11-25T10:05:00+05:30');
const opts = (dir: string, o: Partial<Parameters<typeof ObserveArchive>[0]> = {}) => ({
  dir, retentionDays: 90, tickRetentionDays: 14, maxBytes: 1024 * 1024 * 1024, minFreeBytes: 1, recordTicks: true,
  now: () => NOW, freeBytes: async () => 50 * 1024 ** 3, ...o,
});

test('archive: report, events and gzip tick evidence land under the persistent dir with the documented layout', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'na-arc-'));
  const a = new ObserveArchive(opts(dir));
  assert.equal(await a.start(), true);
  a.event('TRANSITION opening_range_final → GAP_GO_ARMED: …');
  a.tick(['I', 256265, NOW, NOW + 150, 25210.5], NOW);
  a.tick(['O', 9001, NOW, NOW + 400, 180, 179.5, 180.5, 1065, NOW - 1000, 65, 1], NOW);
  await a.report('2026-11-25', { kind: 'NIFTY_ASCENT_OBSERVATION', date: '2026-11-25' });
  await a.stop();
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'reports', '2026-11-25.json'), 'utf8')).kind, 'NIFTY_ASCENT_OBSERVATION');
  const ev = readFileSync(path.join(dir, 'events', '2026-11-25.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.match(ev[0].msg, /GAP_GO_ARMED/);
  const rows = zlib.gunzipSync(readFileSync(path.join(dir, 'ticks', '2026-11-25', '10.ndjson.gz'))).toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows[1], ['O', 9001, NOW, NOW + 400, 180, 179.5, 180.5, 1065, NOW - 1000, 65, 1]);
});

test('archive: tick evidence is optional (off unless NIFTY_ASCENT_RECORD_TICKS=on)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'na-arc-'));
  const a = new ObserveArchive(opts(dir, { recordTicks: false }));
  await a.start();
  a.tick(['I', 256265, NOW, NOW, 1], NOW);
  await a.stop();
  assert.equal(readdirSync(path.join(dir, 'ticks')).length, 0);
  delete process.env.NIFTY_ASCENT_RECORD_TICKS;
  assert.equal(archiveOptionsFromEnv().recordTicks, false);
  assert.equal(archiveOptionsFromEnv().dir, '/data/nifty-ascent');
});

test('archive: retention removes old reports/events and old tick days; size cap removes oldest tick days but never today', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'na-arc-'));
  for (const s of ['reports', 'events', 'ticks']) mkdirSync(path.join(dir, s), { recursive: true });
  writeFileSync(path.join(dir, 'reports', '2026-01-02.json'), '{}');
  writeFileSync(path.join(dir, 'reports', '2026-11-20.json'), '{}');
  writeFileSync(path.join(dir, 'events', '2026-01-02.ndjson'), '');
  for (const d of ['2026-10-01', '2026-11-20', '2026-11-23', '2026-11-25']) { mkdirSync(path.join(dir, 'ticks', d)); writeFileSync(path.join(dir, 'ticks', d, '10.ndjson.gz'), Buffer.alloc(600)); }
  const a = new ObserveArchive(opts(dir, { maxBytes: 1000 }));
  await a.start(); await a.stop();
  assert.deepEqual(readdirSync(path.join(dir, 'reports')), ['2026-11-20.json']);
  assert.equal(readdirSync(path.join(dir, 'events')).length, 0);
  assert.deepEqual(readdirSync(path.join(dir, 'ticks')).sort(), ['2026-11-25'], 'retention + cap: only today left');
  assert.equal(a.status().ticksPaused, null, 'back under the cap after deleting old days');
  const b = new ObserveArchive(opts(dir, { maxBytes: 500 }));      // today alone exceeds the cap
  await b.start(); await b.stop();
  assert.deepEqual(readdirSync(path.join(dir, 'ticks')), ['2026-11-25'], 'today is never deleted');
  assert.match(String(b.status().ticksPaused), /cap/, 'recording pauses instead');
});

test('archive: low disk pauses ticks and events; the small report is still written', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'na-arc-'));
  const a = new ObserveArchive(opts(dir, { minFreeBytes: 5 * 1024 ** 3, freeBytes: async () => 1024 ** 3 }));
  await a.start();
  a.event('x'); a.tick(['I', 1, NOW, NOW, 1], NOW);
  await a.report('2026-11-25', { ok: true });
  await a.stop();
  assert.match(String(a.status().eventsPaused), /MB free/);
  assert.equal(existsSync(path.join(dir, 'events', '2026-11-25.ndjson')), false);
  assert.equal(readdirSync(path.join(dir, 'ticks')).length, 0);
  assert.ok(existsSync(path.join(dir, 'reports', '2026-11-25.json')));
});

test('archive: an unwritable directory disables the archive without throwing', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'na-arc-')), 'not-a-dir');
  writeFileSync(file, 'x');
  const a = new ObserveArchive(opts(path.join(file, 'sub')));
  assert.equal(await a.start(), false);
  a.event('ignored'); await a.report('2026-11-25', {});
  assert.ok(a.status().lastError);
});

test('archive and wiring never write or log credentials; compose mounts the archive outside the release folder', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const archiveSrc = readFileSync(path.join(root, 'server/niftyAscentArchive.ts'), 'utf8');
  assert.ok(!/access_token|accessToken|apiKey|KITE_API_KEY|SERVICE_ROLE/.test(archiveSrc));
  const wiring = readFileSync(path.join(root, 'server/niftyAscent.ts'), 'utf8');
  assert.ok(!/a\.(event|tick|report)\([^)]*(accessToken|apiKey|\bt\b\))/.test(wiring));
  const compose = readFileSync(path.join(root, 'deploy/oracle/docker-compose.yml'), 'utf8');
  assert.match(compose, /- \.\/data\/nifty-ascent:\/data\/nifty-ascent/);
});

test('api/nifty-ascent.ts: read-only status, no control/order code, no credentials; reports NOT_ENABLED when the service is off', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = readFileSync(path.join(root, 'api/nifty-ascent.ts'), 'utf8');
  for (const re of [/\/orders\b/, /place_?order/i, /transaction_type/i, /access_token|accessToken|apiKey|KITE_API_KEY/, /\.control\(/, /method === 'POST'/]) assert.ok(!re.test(src), `matches ${re}`);
  const { default: handler } = await import('../../api/nifty-ascent.ts');
  let code = 0, body: any = null;
  const res: any = { status(n: number) { code = n; return res; }, json(b: unknown) { body = b; }, setHeader() {} };
  await handler({ method: 'GET', query: { resource: 'status' } }, res);
  assert.equal(code, 200);
  assert.equal(body.enabled, false);
  assert.equal(body.livePaper, 'NOT_ENABLED');
  await handler({ method: 'POST', query: { resource: 'status' } }, res);
  assert.equal(code, 404, 'no write methods');
});
