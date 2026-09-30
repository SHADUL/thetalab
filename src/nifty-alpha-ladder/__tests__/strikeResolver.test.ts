import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStrikeStep, selectATM } from '../instruments/strikeResolver.ts';

test('strike step is derived from the actual listed strikes, never hard-coded', () => {
  const strikes = [23900, 23950, 24000, 24050, 24100, 24150, 24200];
  assert.equal(deriveStrikeStep(strikes), 50);
});

test('strike step derivation ignores non-minimal gaps and duplicate strikes', () => {
  const strikes = [24000, 24000, 24100, 24150]; // one 100-gap, one 50-gap, one duplicate
  assert.equal(deriveStrikeStep(strikes), 50);
});

test('ATM: nearest strike selected', () => {
  const strikes = [23900, 23950, 24000, 24050, 24100, 24150, 24200];
  assert.equal(selectATM(24137.40, strikes), 24150);
});

test('ATM exact tie resolves to the LOWER strike', () => {
  const strikes = [24100, 24200];
  assert.equal(selectATM(24150, strikes), 24100);
});
