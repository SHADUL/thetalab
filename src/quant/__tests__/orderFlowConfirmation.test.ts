import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessFeatureAvailability, classifyRawFlow, classifyAlphaFlow, compareRrToFlow, hypotheticalStructure,
  parseOrderFlowConfirmationMode, type OrderFlowFeatureRow,
} from '../strategies/orderFlowConfirmation.ts';

const NOW = Date.parse('2026-10-07T06:00:00Z');
function row(o: Partial<OrderFlowFeatureRow> = {}): OrderFlowFeatureRow {
  return { created_at: new Date(NOW - 30_000).toISOString(), session_date: '2026-10-07', as_of_sec: 3600,
    g1: 1, a1: 5, d1: 1, g2: 3, a2: 4, d2: 1, d2_basis: 'running_area', g2_crossed: false,
    alpha: 1, base_direction: -1, final_direction: -1, g1_active: true, session_valid: true, ...o };
}
const avail = (r: OrderFlowFeatureRow | null) => assessFeatureAvailability(r, NOW, '2026-10-07');

test('mode parsing: default OBSERVE; only OFF/OBSERVE exist (no ENFORCED)', () => {
  assert.equal(parseOrderFlowConfirmationMode(undefined), 'OBSERVE');
  assert.equal(parseOrderFlowConfirmationMode('OFF'), 'OFF');
  assert.equal(parseOrderFlowConfirmationMode('ENFORCED'), 'OBSERVE');
});

test('availability: missing, stale, wrong-day and un-warmed features are each reported, never silently used', () => {
  assert.equal(avail(null).reason, 'NO_FEATURE_ROW');
  assert.equal(avail(row({ created_at: new Date(NOW - 600_000).toISOString() })).reason, 'STALE');
  assert.equal(avail(row({ session_date: '2026-10-06' })).reason, 'WRONG_SESSION_DATE');
  assert.equal(avail(row({ g1_active: false })).reason, 'G1_NOT_ACTIVE');
  assert.equal(avail(row()).available, true);
});

test('variant A (raw d1/d2): both agree -> that side; disagree/zero -> mixed; unavailable stays unavailable', () => {
  assert.equal(classifyRawFlow(row({ d1: 1, d2: 1 }), avail(row())), 'bullish');
  assert.equal(classifyRawFlow(row({ d1: -1, d2: -1 }), avail(row())), 'bearish');
  assert.equal(classifyRawFlow(row({ d1: 1, d2: -1 }), avail(row())), 'mixed');
  assert.equal(classifyRawFlow(row({ d1: 1, d2: 0 }), avail(row())), 'mixed');
  assert.equal(classifyRawFlow(row({ d1: 0, d2: 0 }), avail(row())), 'mixed');
  assert.equal(classifyRawFlow(null, avail(null)), 'unavailable');
});

test('variant B (Alpha Ladder final D) differs from raw: an aligned bullish-looking read is a bearish D', () => {
  const r = row({ d1: 1, d2: 1, alpha: 1, base_direction: -1, final_direction: -1 });
  assert.equal(classifyRawFlow(r, avail(r)), 'bullish');
  assert.equal(classifyAlphaFlow(r, avail(r)), 'bearish');
});

test('variant B: no D yet (d1 = 0) is mixed; unavailable stays unavailable', () => {
  const r = row({ final_direction: null, d1: 0 });
  assert.equal(classifyAlphaFlow(r, avail(r)), 'mixed');
  assert.equal(classifyAlphaFlow(null, avail(null)), 'unavailable');
});

test('compare: MATCH / CONFLICT only for a directional RR against a directional flow', () => {
  assert.equal(compareRrToFlow('bearish', 'bearish'), 'MATCH');
  assert.equal(compareRrToFlow('bullish', 'bullish'), 'MATCH');
  assert.equal(compareRrToFlow('bearish', 'bullish'), 'CONFLICT');
  assert.equal(compareRrToFlow('bullish', 'bearish'), 'CONFLICT');
  assert.equal(compareRrToFlow('neutral', 'bullish'), 'NOT_COMPARABLE');
  assert.equal(compareRrToFlow('bearish', 'mixed'), 'NOT_COMPARABLE');
  assert.equal(compareRrToFlow('bearish', 'unavailable'), 'NOT_COMPARABLE');
  assert.equal(compareRrToFlow(null, 'bearish'), 'NOT_COMPARABLE');
});

test('hypothetical structure: match keeps the RR structure, conflict/mixed -> Iron Condor, missing data -> NO_TRADE', () => {
  assert.equal(hypotheticalStructure('bearish', 'Bear Call Spread', 'bearish'), 'Bear Call Spread');
  assert.equal(hypotheticalStructure('bearish', 'Bear Call Spread', 'bullish'), 'Iron Condor');
  assert.equal(hypotheticalStructure('bearish', 'Bear Call Spread', 'mixed'), 'Iron Condor');
  assert.equal(hypotheticalStructure('bearish', 'Bear Call Spread', 'unavailable'), 'NO_TRADE');
  assert.equal(hypotheticalStructure(null, 'Iron Condor', 'bullish'), 'NO_TRADE');
});

test('no bearish workaround: a bullish flow never converts a bearish RR into a bullish structure', () => {
  assert.notEqual(hypotheticalStructure('bearish', 'Bear Call Spread', 'bullish'), 'Bull Put Spread');
});
