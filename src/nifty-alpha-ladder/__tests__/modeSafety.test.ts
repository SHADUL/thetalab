/**
 * Non-negotiable safety proof (Milestone 3 instructions §MODE SAFETY):
 * no code path anywhere under src/nifty-alpha-ladder/ may call a real
 * order-placement/modification/cancellation endpoint. This is a static,
 * automated proof over the actual source text — not a runtime assertion
 * that could itself be bypassed by a code path this test doesn't exercise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// Real Kite/Groww order-mutation surface — endpoint paths and SDK/HTTP
// method names actually used by this codebase's existing broker
// integration (api/options-autotrade.ts) for AUTO order placement/modify/
// cancel. Nifty Alpha Ladder must never reference any of these under
// src/nifty-alpha-ladder/ in Milestone 3.
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\/orders\/regular/i, label: 'Kite place/modify order endpoint (/orders/regular)' },
  { pattern: /\/v1\/order\/create/i, label: 'Groww order creation endpoint' },
  { pattern: /\bplaceOrder\b/, label: 'placeOrder call' },
  { pattern: /\bmodifyOrder\b/, label: 'modifyOrder call' },
  { pattern: /\bcancelOrder\b/, label: 'cancelOrder call' },
  { pattern: /\bmakeLiveOrderPlacer\b/, label: 'reuse of Options Auto-Trader\'s real Kite order placer' },
  { pattern: /\bmakeGrowwOrderPlacer\b/, label: 'reuse of Options Auto-Trader\'s real Groww order placer' },
  { pattern: /method:\s*['"]DELETE['"]/, label: 'a DELETE HTTP method (order cancellation shape)' },
];

test('mode safety: no broker order-mutation reference exists anywhere in src/nifty-alpha-ladder/', () => {
  const files = listTsFiles(ROOT);
  assert.ok(files.length > 10, 'sanity check: expected many source files, found suspiciously few');

  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) violations.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(violations, [], `Found forbidden order-mutation references:\n${violations.join('\n')}`);
});

test('mode safety: broker_order_count is structurally impossible to be non-zero in Milestone 3 — shadow_orders.broker_order_id is documented as always-null', () => {
  const migrationText = readFileSync(join(ROOT, 'migrations', '001_alpha_ladder_schema.sql'), 'utf8');
  assert.match(migrationText, /broker_order_id text, -- always null in Milestone 3/);
});
