import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectExpiry } from '../calendar/expirySelection.ts';

test('nearest listed expiry more than 1 day out is selected directly', () => {
  const signalDate = new Date('2026-09-30T00:00:00Z'); // Wednesday
  const listed = [new Date('2026-10-06T00:00:00Z')]; // following Tuesday, 6 days out
  const selected = selectExpiry(signalDate, listed);
  assert.equal(selected?.toISOString().slice(0, 10), '2026-10-06');
});

test('nearest listed expiry <=1 day out with a second expiry available -> the second is selected', () => {
  const signalDate = new Date('2026-09-30T00:00:00Z'); // Wednesday
  const nearTomorrow = new Date('2026-10-01T00:00:00Z'); // 1 day out
  const followingWeek = new Date('2026-10-06T00:00:00Z');
  const selected = selectExpiry(signalDate, [nearTomorrow, followingWeek]);
  assert.equal(selected?.toISOString().slice(0, 10), '2026-10-06');
});

test('nearest listed expiry <=1 day out with NO second expiry -> falls back to the near one', () => {
  const signalDate = new Date('2026-09-30T00:00:00Z');
  const nearTomorrow = new Date('2026-10-01T00:00:00Z');
  const selected = selectExpiry(signalDate, [nearTomorrow]);
  assert.equal(selected?.toISOString().slice(0, 10), '2026-10-01');
});

test('no listed expiries strictly after the signal date -> null', () => {
  const signalDate = new Date('2026-09-30T00:00:00Z');
  assert.equal(selectExpiry(signalDate, [new Date('2026-09-29T00:00:00Z')]), null);
  assert.equal(selectExpiry(signalDate, []), null);
});

test('worked example: Wednesday signal, expiry 6 calendar days out resolves to that Tuesday', () => {
  const signalDate = new Date('2026-09-30T00:00:00Z');
  const tuesday = new Date('2026-10-06T00:00:00Z');
  assert.equal(selectExpiry(signalDate, [tuesday])?.toISOString().slice(0, 10), '2026-10-06');
});
