import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeObservedFills, buildEmpiricalConfig, MIN_OBSERVATIONS_FOR_CALIBRATION, type ObservedFill } from '../execution/empiricalExecutionModel.ts';
import { REALISTIC_CONFIG } from '../execution/fillSimulator.ts';

function fill(overrides: Partial<ObservedFill> = {}): ObservedFill {
  return { side: 'BUY', decisionMid: 100, bid: 98, ask: 102, actualFill: 101, latencyMs: 900, openInterest: 5000, volume: 1000, ...overrides };
}

test('refuses to calibrate below the minimum observation count — never guesses from too little data', () => {
  const fills = Array.from({ length: MIN_OBSERVATIONS_FOR_CALIBRATION - 1 }, () => fill());
  assert.equal(summarizeObservedFills(fills), null);
});

test('calibrates once the minimum observation count is met', () => {
  const fills = Array.from({ length: MIN_OBSERVATIONS_FOR_CALIBRATION }, () => fill());
  const summary = summarizeObservedFills(fills);
  assert.ok(summary);
  assert.equal(summary!.n, MIN_OBSERVATIONS_FOR_CALIBRATION);
  assert.ok(Math.abs(summary!.meanSpreadPct - 0.04) < 1e-9); // (102-98)/100
});

test('a BUY fill closer to the ask than the mid produces positive slippage bps and a spread-fraction near 1', () => {
  const fills = Array.from({ length: MIN_OBSERVATIONS_FOR_CALIBRATION }, () => fill({ actualFill: 102 })); // fills exactly at the ask
  const summary = summarizeObservedFills(fills)!;
  assert.ok(summary.meanSlippageBps > 0);
  assert.ok(Math.abs(summary.observedSpreadFraction - 1) < 1e-9);
});

test('a BUY fill exactly at mid produces zero slippage and zero spread-fraction', () => {
  const fills = Array.from({ length: MIN_OBSERVATIONS_FOR_CALIBRATION }, () => fill({ actualFill: 100 }));
  const summary = summarizeObservedFills(fills)!;
  assert.ok(Math.abs(summary.meanSlippageBps) < 1e-9);
  assert.ok(Math.abs(summary.observedSpreadFraction) < 1e-9);
});

test('buildEmpiricalConfig never mutates or aliases REALISTIC_CONFIG', () => {
  const fills = Array.from({ length: MIN_OBSERVATIONS_FOR_CALIBRATION }, () => fill({ actualFill: 102 }));
  const summary = summarizeObservedFills(fills)!;
  const before = JSON.stringify(REALISTIC_CONFIG);
  const empirical = buildEmpiricalConfig(summary);
  assert.notEqual(empirical, REALISTIC_CONFIG);
  assert.equal(JSON.stringify(REALISTIC_CONFIG), before, 'REALISTIC_V1 (REALISTIC_CONFIG) must be unchanged by building an empirical config');
  assert.ok(Math.abs(empirical.realisticSpreadFraction - 1) < 1e-9);
});
