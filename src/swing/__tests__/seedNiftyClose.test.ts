import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeNiftySpotFromBundle } from '../scripts/seedNiftyClose.ts';

test('mergeNiftySpotFromBundle unions overlapping expiry windows into one continuous series', () => {
  const bundle = {
    expiries: {
      '2026-01-02': { spot: { '2025-12-29': 100, '2025-12-30': 101, '2025-12-31': 102 } },
      '2026-01-09': { spot: { '2025-12-31': 102, '2026-01-02': 103, '2026-01-05': 104 } },
    },
  };
  const merged = mergeNiftySpotFromBundle(bundle);
  assert.equal(merged.size, 5);
  assert.equal(merged.get('2025-12-29'), 100);
  assert.equal(merged.get('2025-12-31'), 102, 'the overlapping date should agree, not double up');
  assert.equal(merged.get('2026-01-05'), 104);
});

test('mergeNiftySpotFromBundle keeps the first value and warns on a genuine conflict', () => {
  const bundle = {
    expiries: {
      a: { spot: { '2026-01-02': 100 } },
      b: { spot: { '2026-01-02': 999 } }, // should never happen in real data — exercised anyway
    },
  };
  const merged = mergeNiftySpotFromBundle(bundle);
  assert.equal(merged.get('2026-01-02'), 100);
});

test('mergeNiftySpotFromBundle tolerates an expiry with no spot field at all', () => {
  const bundle = { expiries: { a: {}, b: { spot: { '2026-01-02': 100 } } } };
  const merged = mergeNiftySpotFromBundle(bundle);
  assert.equal(merged.size, 1);
});
