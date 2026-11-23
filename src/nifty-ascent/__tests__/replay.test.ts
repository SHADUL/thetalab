import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from '../sim/fixtures.ts';
import { Replay } from '../sim/market.ts';

for (const f of FIXTURES) {
  test(`fixture ${f.id}: produces its designed outcome (${f.expect.outcome} / ${f.expect.reason})`, () => {
    const e = new Replay(f).runToEnd();
    assert.equal(e.outcome?.kind, f.expect.outcome);
    assert.equal(e.outcome?.reason, f.expect.reason);
    if (f.expect.bot) assert.equal(e.trade?.bot ?? e.signal?.bot, f.expect.bot);
    if (f.expect.standDown) assert.equal(e.standDown?.reason, f.expect.standDown);
    assert.ok(e.positionsToday <= 1);
    assert.equal(e.position, null, 'never carried past the session');
  });
}

test('determinism: the same fixture replays to byte-identical decisions', () => {
  for (const f of FIXTURES) {
    const a = new Replay(f).runToEnd(), b = new Replay(f).runToEnd();
    assert.equal(JSON.stringify(a.events), JSON.stringify(b.events), f.id);
    assert.equal(JSON.stringify(a.trade), JSON.stringify(b.trade), f.id);
  }
});

test('replay stepping in chunks gives the same result as one run', () => {
  const f = FIXTURES.find((x) => x.id === 'filled-williams-ce')!;
  const whole = new Replay(f).runToEnd();
  const r = new Replay(f);
  for (let t = r.startMs; !r.done; t += 37_000) r.stepTo(t);
  assert.equal(JSON.stringify(r.engine.events), JSON.stringify(whole.events));
});

test('paper-only: NIFTY ASCENT code contains no order-placement or credential code', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dirs = ['src/nifty-ascent', 'src/components/nifty-ascent'];
  const banned = [/\/orders\b/, /place_?order/i, /kiteconnect/i, /api\.kite\.trade/, /transaction_type/i, /access_token/i, /api_secret/i, /makeLiveOrderPlacer|LiveOrderPlacer/];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) { if (n !== '__tests__') walk(p); } else if (/\.(ts|js|jsx)$/.test(n)) files.push(p);
    }
  };
  for (const d of dirs) { try { walk(path.join(root, d)); } catch { /* UI folder may not exist in core-only runs */ } }
  assert.ok(files.length > 5);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of banned) assert.ok(!re.test(src), `${path.relative(root, f)} matches ${re}`);
  }
});
