import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildShadowLegQuotes, runShadowFillSimulation, isEligibleForForwardValidation, type ShadowCandidateLeg } from '../execution/shadowExecution.ts';
import type { EnrichedQuote } from '../types.ts';

function enrichedQuote(overrides: Partial<{ strike: number; right: 'CE' | 'PE'; bid: number | null; ask: number | null; oi: number | null; vol: number | null; spreadPct: number | null }> = {}): EnrichedQuote {
  const { strike = 24000, right = 'CE', bid = 98, ask = 102, oi = 5000, vol = 1000, spreadPct = 0.04 } = overrides;
  return {
    quote: { symbol: `NIFTY26SEP${strike}${right}`, right, strike, expiry: 0, asOf: 0, bid, ask, last: 100, settle: null, openInterest: oi, oiChange: null, volume: vol, observedIv: null, observedGreeks: { delta: null, gamma: null, theta: null, vega: null, rho: null } } as any,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    spread: bid !== null && ask !== null ? ask - bid : null,
    spreadPct,
    markPrice: 100, markPriceSource: 'mid',
    timeToExpiry: 30 / 365,
    iv: 0.14, ivSource: 'model',
    greeks: { delta: 0.16, gamma: 0.001, theta: -5, vega: 10, rho: 1 }, greeksSource: 'model',
    modelGreeks: { delta: 0.16, gamma: 0.001, theta: -5, vega: 10, rho: 1 },
    logMoneyness: 0, distanceFromForward: 0, issues: [],
  } as any;
}

const LEGS: ShadowCandidateLeg[] = [
  { side: 'SELL', right: 'CE', strike: 24000, price: 100, quantity: 75 },
  { side: 'BUY', right: 'CE', strike: 24500, price: 40, quantity: 75 },
];

test('buildShadowLegQuotes finds each leg\'s exact EnrichedQuote by strike/right, never a fresh fetch', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE' }), enrichedQuote({ strike: 24500, right: 'CE', bid: 38, ask: 42 })];
  const resolved = buildShadowLegQuotes(LEGS, slice);
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((r) => r.legQuote !== null));
  assert.equal(resolved[1].legQuote!.bid, 38);
});

test('a leg with no matching enriched quote resolves to null, never silently guessed at', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE' })]; // missing the 24500 CE leg
  const resolved = buildShadowLegQuotes(LEGS, slice);
  assert.equal(resolved[0].legQuote !== null, true);
  assert.equal(resolved[1].legQuote, null);
});

test('runShadowFillSimulation: FILLED with real bid/ask on every leg', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE' }), enrichedQuote({ strike: 24500, right: 'CE', bid: 38, ask: 42 })];
  const outcome = runShadowFillSimulation(LEGS, slice);
  assert.equal(outcome.status, 'FILLED');
  if (outcome.status !== 'FILLED') return;
  assert.equal(outcome.hasRealBidAsk, true);
  assert.equal(outcome.fills.length, 2);
  // SELL leg should move toward bid (worse than mid), matching SHADOW_EXECUTION_V1 == REALISTIC.
  const sellFill = outcome.fills.find((f) => f.side === 'SELL')!;
  assert.ok(sellFill.filledPrice < sellFill.decisionPrice);
});

test('runShadowFillSimulation: EXECUTION_DATA_INSUFFICIENT when a leg is missing from the slice', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE' })];
  const outcome = runShadowFillSimulation(LEGS, slice);
  assert.equal(outcome.status, 'EXECUTION_DATA_INSUFFICIENT');
});

test('runShadowFillSimulation: hasRealBidAsk is false when a leg has no real bid/ask, but a diagnostic fill is still produced (never discarded)', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE', bid: null, ask: null }), enrichedQuote({ strike: 24500, right: 'CE', bid: 38, ask: 42 })];
  const outcome = runShadowFillSimulation(LEGS, slice);
  assert.equal(outcome.status, 'FILLED');
  if (outcome.status !== 'FILLED') return;
  assert.equal(outcome.hasRealBidAsk, false);
  assert.equal(outcome.fills.length, 2); // still produced, for diagnostic storage
});

const BASE_ELIGIBILITY = {
  baselineVersion: 'BASELINE_V1', executionMode: 'SHADOW' as const, fillModel: 'SHADOW_EXECUTION_V1' as const,
  everyLegHasRealBidAsk: true, quotesFreshMs: 500, maxQuoteAgeMs: 5000,
  snapshotStoredSuccessfully: true, ledgerSignalStoredSuccessfully: true, knownIngestionBug: false, brokerOrderPlaced: false,
  expectedBaselineVersion: 'BASELINE_V1', expectedFillModel: 'SHADOW_EXECUTION_V1' as const,
};

test('isEligibleForForwardValidation: a fully clean signal is eligible', () => {
  const result = isEligibleForForwardValidation(BASE_ELIGIBILITY);
  assert.equal(result.eligible, true);
  assert.equal(result.reasons.length, 0);
});

test('isEligibleForForwardValidation: missing real bid/ask on any leg is ineligible, with a specific reason', () => {
  const result = isEligibleForForwardValidation({ ...BASE_ELIGIBILITY, everyLegHasRealBidAsk: false });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('bid/ask')));
});

test('isEligibleForForwardValidation: a broker order having been placed is an automatic, unconditional disqualifier', () => {
  const result = isEligibleForForwardValidation({ ...BASE_ELIGIBILITY, brokerOrderPlaced: true });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('broker order')));
});

test('isEligibleForForwardValidation: baseline or fill-model drift is caught explicitly', () => {
  const baselineDrift = isEligibleForForwardValidation({ ...BASE_ELIGIBILITY, baselineVersion: 'BASELINE_V2' });
  assert.equal(baselineDrift.eligible, false);
  assert.ok(baselineDrift.reasons.some((r) => r.includes('baseline drift')));
});

test('isEligibleForForwardValidation: a stale quote past maxQuoteAgeMs is ineligible', () => {
  const result = isEligibleForForwardValidation({ ...BASE_ELIGIBILITY, quotesFreshMs: 9000, maxQuoteAgeMs: 5000 });
  assert.equal(result.eligible, false);
});

test('isEligibleForForwardValidation: multiple simultaneous failures are ALL reported, not just the first', () => {
  const result = isEligibleForForwardValidation({ ...BASE_ELIGIBILITY, everyLegHasRealBidAsk: false, snapshotStoredSuccessfully: false, brokerOrderPlaced: true });
  assert.equal(result.eligible, false);
  assert.equal(result.reasons.length, 3);
});

import { runShadowExecutionForLegs } from '../execution/shadowExecution.ts';
import type { PlannedLeg } from '../execution/paperFill.ts';

const PLANNED_LEGS: PlannedLeg[] = [
  { side: 'SELL', right: 'CE', strike: 24000, tradingsymbol: 'NIFTY26SEP24000CE', quantity: 75, fillPrice: 100 },
  { side: 'BUY', right: 'CE', strike: 24500, tradingsymbol: 'NIFTY26SEP24500CE', quantity: 75, fillPrice: 40 },
];
function passingValidation() { return { passed: true, checks: [{ name: 'x', passed: true, detail: 'ok' }] }; }
function failingValidation() { return { passed: false, checks: [{ name: 'riskLimits', passed: false, detail: 'zero lots' }] }; }

test('runShadowExecutionForLegs: a validation failure never calls the fill simulator, returns FAILED', () => {
  const result = runShadowExecutionForLegs(PLANNED_LEGS, failingValidation(), []);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.protection, 'NONE');
});

test('runShadowExecutionForLegs: a passing validation with real bid/ask fills every leg via SHADOW_EXECUTION_V1 and reaches ACTIVE/FULL', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE', bid: 98, ask: 102 }), enrichedQuote({ strike: 24500, right: 'CE', bid: 38, ask: 42 })];
  const result = runShadowExecutionForLegs(PLANNED_LEGS, passingValidation(), slice);
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.protection, 'FULL');
  assert.equal(result.hasRealBidAsk, true);
  // The SELL leg's fill price must differ from its raw decision price (100) — SHADOW_EXECUTION_V1 moved it toward the bid.
  const sellLeg = result.legFills.find((l) => l.side === 'SELL')!;
  assert.notEqual(sellLeg.fillPrice, 100);
  assert.ok(sellLeg.fillPrice < 100);
});

test('runShadowExecutionForLegs: missing a leg\'s quote in the slice fails cleanly (never a broker call, never a crash)', () => {
  const slice = [enrichedQuote({ strike: 24000, right: 'CE' })]; // 24500 CE leg missing
  const result = runShadowExecutionForLegs(PLANNED_LEGS, passingValidation(), slice);
  assert.equal(result.state, 'FAILED');
});

import { isCompletedTradeEligibleForForwardValidation } from '../execution/shadowExecution.ts';

const CLEAN_ENTRY_ELIGIBILITY = { eligible: true, reasons: [] as string[] };
const BASE_COMPLETED = {
  entryEligibility: CLEAN_ENTRY_ELIGIBILITY, exitEverLegHasRealBidAsk: true, exitQuotesFreshMs: 500, maxQuoteAgeMs: 5000,
  entryExecutionTelemetryStored: true, exitExecutionTelemetryStored: true, outcomeStoredSuccessfully: true,
  strategyDrift: false, fillModelDrift: false, knownIngestionBug: false, brokerOrderPlaced: false,
};

test('isCompletedTradeEligibleForForwardValidation: a fully clean completed trade is eligible', () => {
  const result = isCompletedTradeEligibleForForwardValidation(BASE_COMPLETED);
  assert.equal(result.eligible, true);
});

test('isCompletedTradeEligibleForForwardValidation: an ineligible ENTRY makes the whole completed trade ineligible, with the reason prefixed', () => {
  const result = isCompletedTradeEligibleForForwardValidation({ ...BASE_COMPLETED, entryEligibility: { eligible: false, reasons: ['not every leg had real bid/ask at decision time'] } });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.startsWith('entry:')));
});

test('isCompletedTradeEligibleForForwardValidation: missing exit execution telemetry is its own distinct failure reason', () => {
  const result = isCompletedTradeEligibleForForwardValidation({ ...BASE_COMPLETED, exitExecutionTelemetryStored: false });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('exit execution-quality')));
});

test('isCompletedTradeEligibleForForwardValidation: an already-completed outcome write (idempotency loser) is ineligible', () => {
  const result = isCompletedTradeEligibleForForwardValidation({ ...BASE_COMPLETED, outcomeStoredSuccessfully: false });
  assert.equal(result.eligible, false);
});

test('isCompletedTradeEligibleForForwardValidation: a broker order placed at ANY point disqualifies the completed trade', () => {
  const result = isCompletedTradeEligibleForForwardValidation({ ...BASE_COMPLETED, brokerOrderPlaced: true });
  assert.equal(result.eligible, false);
});

test('isCompletedTradeEligibleForForwardValidation: a failing protocolTiming verdict is folded in with a "protocol:" prefix', () => {
  const result = isCompletedTradeEligibleForForwardValidation({
    ...BASE_COMPLETED, protocolTiming: { eligible: false, reasons: ['signal recorded before the protocol run started'] },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r === 'protocol: signal recorded before the protocol run started'));
});

test('isCompletedTradeEligibleForForwardValidation: an eligible protocolTiming verdict adds no reasons and does not affect the clean case', () => {
  const result = isCompletedTradeEligibleForForwardValidation({ ...BASE_COMPLETED, protocolTiming: { eligible: true, reasons: [] } });
  assert.equal(result.eligible, true);
});

test('isCompletedTradeEligibleForForwardValidation: omitting protocolTiming entirely still evaluates the rest cleanly (backward-compatible call sites)', () => {
  const result = isCompletedTradeEligibleForForwardValidation(BASE_COMPLETED);
  assert.equal(result.eligible, true);
});
