import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AscentHistory, monthTradingDays } from '../niftyAscentHistory.ts';

const weekday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5 && d !== '2026-11-24'; };
const lab = (d: string, m: number) => `${d}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+0530`;

function fake() {
  const calls: string[] = [];
  const fetchData = async (p: string) => {
    calls.push(p);
    if (p.includes('/264969/day')) return { candles: [['2026-11-16T00:00:00+0530', 12, 13, 11, 12.5, 0], ['2026-11-17T00:00:00+0530', 12.5, 13, 12, 13.1, 0]] };
    const day = p.match(/from=(\d{4}-\d{2}-\d{2})/)![1];
    const c: unknown[] = [];
    for (let m = 555; m <= 929; m++) c.push([lab(day, m), 25000, 25010, 24990, 25000 + (m % 7), 0]);
    return { candles: c };
  };
  return { calls, fetchData };
}

test('history: fetches today + previous session + VIX once, then serves from the disk cache', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'na-hist-'));
  const f = fake();
  const h = new AscentHistory({ dir, fetchData: f.fetchData, isTradingDay: weekday, gapMs: 0 });
  const now = Date.parse('2026-11-23T12:00:00+05:30');
  const d = await h.day('2026-11-18', now);
  assert.deepEqual([d.date, d.prevDate, d.bars.length, d.prevBars.length, d.vixPrevClose], ['2026-11-18', '2026-11-17', 375, 375, 13.1]);
  assert.deepEqual(d.expiries, ['2026-11-23', '2026-12-01']);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((c) => /^\/instruments\/historical\/\d+\/(minute|day)\?/.test(c)));
  assert.ok(existsSync(path.join(dir, '2026-11-18.json')));
  await h.day('2026-11-18', now);
  assert.equal(f.calls.length, 3, 'served from cache');
  assert.ok(!readFileSync(path.join(dir, '2026-11-18.json'), 'utf8').match(/token|api_key/i));
});

test('history: refuses today/future, non-trading days and bad dates', async () => {
  const h = new AscentHistory({ dir: mkdtempSync(path.join(tmpdir(), 'na-hist-')), fetchData: fake().fetchData, isTradingDay: weekday, gapMs: 0 });
  const now = Date.parse('2026-11-23T12:00:00+05:30');
  await assert.rejects(h.day('2026-11-23', now), /completed past/);
  await assert.rejects(h.day('2026-11-22', now), /not a trading day/);
  await assert.rejects(h.day('18-11-2026', now), /YYYY-MM-DD/);
});

test('history: Kite requests are serialised and a 429 is retried with backoff', async () => {
  const f = fake();
  let active = 0, maxActive = 0, fails = 1;
  const sleeps: number[] = [];
  const fetchData = async (p: string) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    if (fails-- > 0) throw new Error('Kite historical 429 NetworkException');
    return f.fetchData(p);
  };
  const h = new AscentHistory({ dir: mkdtempSync(path.join(tmpdir(), 'na-hist-')), fetchData, isTradingDay: weekday, gapMs: 5, sleep: async (ms) => { sleeps.push(ms); } });
  const now = Date.parse('2026-11-23T12:00:00+05:30');
  const [a, b] = await Promise.all([h.day('2026-11-18', now), h.day('2026-11-19', now)]);
  assert.equal(a.date, '2026-11-18'); assert.equal(b.date, '2026-11-19');
  assert.equal(maxActive, 1, 'never two Kite requests at once');
  assert.ok(sleeps.includes(1000), 'backed off after the 429');
  assert.equal(f.calls.length, 6);
});

test('history: a non-429 error is not retried', async () => {
  let n = 0;
  const h = new AscentHistory({ dir: mkdtempSync(path.join(tmpdir(), 'na-hist-')), fetchData: async () => { n++; throw new Error('Kite historical 403 TokenException'); }, isTradingDay: weekday, gapMs: 0 });
  await assert.rejects(h.day('2026-11-18', Date.parse('2026-11-23T12:00:00+05:30')), /403/);
  assert.equal(n, 1);
});

test('month trading days exclude weekends, holidays and today', () => {
  const days = monthTradingDays('2026-11', weekday, Date.parse('2026-11-23T12:00:00+05:30'));
  assert.equal(days[0], '2026-11-02');
  assert.ok(!days.includes('2026-11-23') && !days.includes('2026-11-21') && !days.includes('2026-11-24'));
  assert.throws(() => monthTradingDays('2026/11', weekday), /YYYY-MM/);
});

test('history module: read-only Kite GETs only, no order code', () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../niftyAscentHistory.ts'), 'utf8');
  for (const re of [/\/orders\b/, /place_?order/i, /method:\s*'POST'/, /access_token/]) assert.ok(!re.test(src), `matches ${re}`);
});
