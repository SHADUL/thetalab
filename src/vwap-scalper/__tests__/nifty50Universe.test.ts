import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NIFTY_50_UNIVERSE } from '../nifty50Universe.ts';

test('the universe has exactly 50 constituents, matching the index\'s own definition', () => {
  assert.equal(NIFTY_50_UNIVERSE.length, 50);
});

test('every symbol is unique — no accidental duplicate entries', () => {
  const symbols = NIFTY_50_UNIVERSE.map((s) => s.symbol);
  assert.equal(new Set(symbols).size, symbols.length);
});

test('every entry has a non-empty symbol, company name and industry', () => {
  for (const s of NIFTY_50_UNIVERSE) {
    assert.ok(s.symbol.length > 0);
    assert.ok(s.companyName.length > 0);
    assert.ok(s.industry.length > 0);
  }
});
