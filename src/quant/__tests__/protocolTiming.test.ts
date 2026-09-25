import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateProtocolTimingEligibility, type ProtocolRunFacts, type SignalProtocolFacts } from '../execution/protocolTiming.ts';

const T0 = Date.parse('2026-01-10T00:00:00.000Z'); // protocol start
const ACTIVE_RUN: ProtocolRunFacts = {
  runExists: true, runStatus: 'ACTIVE', runProtocolId: 'NIFTY-BASELINE_V1-2026-01-10-abcd1234',
  runBaselineVersion: 'BASELINE_V1', runFillModel: 'SHADOW_EXECUTION_V1',
  runStartedAtMs: T0, runTerminalAtMs: null,
};
const GOOD_SIGNAL: SignalProtocolFacts = {
  signalProtocolId: ACTIVE_RUN.runProtocolId, signalBaselineVersion: 'BASELINE_V1',
  signalFillModelVersion: 'SHADOW_EXECUTION_V1', signalTimestampMs: T0 + 1000,
};

test('signal before protocol start -> ineligible', () => {
  const result = evaluateProtocolTimingEligibility({ ...GOOD_SIGNAL, signalTimestampMs: T0 - 1000 }, ACTIVE_RUN);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('before the protocol run started')));
});

test('signal exactly at protocol start -> eligible', () => {
  const result = evaluateProtocolTimingEligibility({ ...GOOD_SIGNAL, signalTimestampMs: T0 }, ACTIVE_RUN);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test('signal after protocol start -> eligible', () => {
  const result = evaluateProtocolTimingEligibility(GOOD_SIGNAL, ACTIVE_RUN);
  assert.equal(result.eligible, true);
});

test('wrong protocol ID -> ineligible', () => {
  const result = evaluateProtocolTimingEligibility({ ...GOOD_SIGNAL, signalProtocolId: 'some-other-protocol-id' }, ACTIVE_RUN);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('protocol_id mismatch')));
});

test('wrong baseline -> ineligible', () => {
  const result = evaluateProtocolTimingEligibility({ ...GOOD_SIGNAL, signalBaselineVersion: 'BASELINE_V2' }, ACTIVE_RUN);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('baseline_version mismatch')));
});

test('wrong fill model -> ineligible', () => {
  const result = evaluateProtocolTimingEligibility({ ...GOOD_SIGNAL, signalFillModelVersion: 'SOME_OTHER_MODEL' }, ACTIVE_RUN);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('fill_model mismatch')));
});

test('STOPPED run -> ineligible for a signal timestamped at/after the stop', () => {
  const stoppedRun: ProtocolRunFacts = { ...ACTIVE_RUN, runStatus: 'STOPPED', runTerminalAtMs: T0 + 500 };
  const lateSignal: SignalProtocolFacts = { ...GOOD_SIGNAL, signalTimestampMs: T0 + 600 };
  const result = evaluateProtocolTimingEligibility(lateSignal, stoppedRun);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('stopped')));
  // A signal legitimately captured BEFORE the stop remains eligible.
  const earlySignal: SignalProtocolFacts = { ...GOOD_SIGNAL, signalTimestampMs: T0 + 100 };
  assert.equal(evaluateProtocolTimingEligibility(earlySignal, stoppedRun).eligible, true);
});

test('INVALIDATED run -> ineligible', () => {
  const invalidatedRun: ProtocolRunFacts = { ...ACTIVE_RUN, runStatus: 'INVALIDATED', runTerminalAtMs: T0 + 500 };
  const lateSignal: SignalProtocolFacts = { ...GOOD_SIGNAL, signalTimestampMs: T0 + 600 };
  const result = evaluateProtocolTimingEligibility(lateSignal, invalidatedRun);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('invalidated')));
});

test('pre-protocol SHADOW trade (signal has no protocol_id) -> ineligible but explicitly labeled, never a query error', () => {
  const result = evaluateProtocolTimingEligibility({ ...GOOD_SIGNAL, signalProtocolId: null }, ACTIVE_RUN);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('PRE_PROTOCOL')));
});

test('no protocol run exists at all for the referenced protocol_id -> ineligible, distinct reason', () => {
  const noRun: ProtocolRunFacts = { runExists: false, runStatus: null, runProtocolId: null, runBaselineVersion: null, runFillModel: null, runStartedAtMs: null, runTerminalAtMs: null };
  const result = evaluateProtocolTimingEligibility(GOOD_SIGNAL, noRun);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('no protocol run found')));
});
