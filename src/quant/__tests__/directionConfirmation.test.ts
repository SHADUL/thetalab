import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { evaluateExpiries } from '../strategies/expirySelector.ts';
import {
  selectDirectionConfirmed, normalizeTrend, isIronCondorSuitable, parseDirectionConfirmationMode,
  type DirectionTrend, type ConfirmationOutput,
} from '../strategies/directionConfirmation.ts';
import { evaluateExpiriesWithConfirmation } from '../strategies/directionConfirmationEval.ts';
import { decideTrade, DEFAULT_DECISION_THRESHOLDS } from '../strategies/decisionGate.ts';
import type { Bias } from '../strategies/regimeSelect.ts';
import type { TrendAssessment } from '../analytics/marketRegime.ts';
import type { ContractSpec } from '../types.ts';

const sel = (rrBias: Bias | null, trend: DirectionTrend, o: { stale?: boolean; veto?: boolean } = {}): ConfirmationOutput =>
  selectDirectionConfirmed({ rrBias, trend, trendStale: o.stale ?? false, strongTrendVeto: o.veto ?? true });

// ---- the decision matrix, every row (Version C) ----
const MATRIX: Array<[Bias, DirectionTrend, string, string | null, string]> = [
  // rr,        trend,            decision,       structure,           code
  ['bullish', 'STRONG_BULLISH', 'CONFIRMED', 'Bull Put Spread', 'RR_TREND_ALIGNED'],
  ['bullish', 'BULLISH', 'CONFIRMED', 'Bull Put Spread', 'RR_TREND_ALIGNED'],
  ['bullish', 'NEUTRAL', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_CONFLICT'],
  ['bullish', 'BEARISH', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_CONFLICT'],
  ['bullish', 'STRONG_BEARISH', 'NO_TRADE', null, 'RR_TREND_STRONG_CONFLICT'],
  ['bearish', 'STRONG_BEARISH', 'CONFIRMED', 'Bear Call Spread', 'RR_TREND_ALIGNED'],
  ['bearish', 'BEARISH', 'CONFIRMED', 'Bear Call Spread', 'RR_TREND_ALIGNED'],
  ['bearish', 'NEUTRAL', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_CONFLICT'],
  ['bearish', 'BULLISH', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_CONFLICT'],
  ['bearish', 'STRONG_BULLISH', 'NO_TRADE', null, 'RR_TREND_STRONG_CONFLICT'],
  ['neutral', 'NEUTRAL', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_ALIGNED'],
  ['neutral', 'STRONG_BULLISH', 'NO_TRADE', null, 'RR_NEUTRAL_TREND_STRONG'],
  ['neutral', 'STRONG_BEARISH', 'NO_TRADE', null, 'RR_NEUTRAL_TREND_STRONG'],
  ['neutral', 'BULLISH', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_CONFLICT'], // gap in the stated matrix: mild trend, no strong veto applies
  ['neutral', 'BEARISH', 'IC_CANDIDATE', 'Iron Condor', 'RR_TREND_CONFLICT'],
];
for (const [rr, trend, decision, structure, code] of MATRIX) {
  test(`matrix: RR ${rr} + ${trend} -> ${decision}${structure ? ` (${structure})` : ''} [${code}]`, () => {
    const r = sel(rr, trend);
    assert.equal(r.decision, decision);
    assert.equal(r.structure, structure);
    assert.equal(r.reasonCode, code);
  });
}

test('matrix: UNKNOWN trend is NO_TRADE for every RR direction — never treated as NEUTRAL', () => {
  for (const rr of ['bullish', 'bearish', 'neutral'] as Bias[]) {
    const r = sel(rr, 'UNKNOWN');
    assert.equal(r.decision, 'NO_TRADE');
    assert.equal(r.reasonCode, 'RR_TREND_UNKNOWN');
  }
});

test('matrix: stale trend is NO_TRADE for every RR direction and trend value', () => {
  for (const rr of ['bullish', 'bearish', 'neutral'] as Bias[]) {
    for (const t of ['STRONG_BULLISH', 'BULLISH', 'NEUTRAL', 'BEARISH', 'STRONG_BEARISH'] as DirectionTrend[]) {
      const r = sel(rr, t, { stale: true });
      assert.equal(r.decision, 'NO_TRADE');
      assert.equal(r.reasonCode, 'RR_TREND_STALE');
    }
  }
});

test('matrix: an unavailable RR reading is NO_TRADE, not neutral', () => {
  assert.equal(sel(null, 'NEUTRAL').decision, 'NO_TRADE');
});

test('no bearish workaround: when both signals are bearish the structure is bearish, never bullish', () => {
  assert.equal(sel('bearish', 'STRONG_BEARISH').structure, 'Bear Call Spread');
  assert.notEqual(sel('bearish', 'BEARISH').structure, 'Bull Put Spread');
});

test('Version B (no strong-trend veto): strong conflicts become Iron Condor candidates instead of NO_TRADE', () => {
  assert.equal(sel('bullish', 'STRONG_BEARISH', { veto: false }).decision, 'IC_CANDIDATE');
  assert.equal(sel('neutral', 'STRONG_BULLISH', { veto: false }).decision, 'IC_CANDIDATE');
  // missing data still blocks in B
  assert.equal(sel('bullish', 'UNKNOWN', { veto: false }).decision, 'NO_TRADE');
});

test('IC suitability: the strong-trend veto rejects an Iron Condor against a strong trend', () => {
  assert.equal(isIronCondorSuitable('STRONG_BEARISH', true), false);
  assert.equal(isIronCondorSuitable('STRONG_BULLISH', true), false);
  assert.equal(isIronCondorSuitable('BEARISH', true), true);
  assert.equal(isIronCondorSuitable('NEUTRAL', true), true);
  assert.equal(isIronCondorSuitable('STRONG_BEARISH', false), true);
});

test('normalizeTrend: missing assessment is UNKNOWN; old closes are stale; fresh closes are not', () => {
  const t = (state: TrendAssessment['state']): TrendAssessment => ({ state, emaFast: 1, emaSlow: 1, emaFastVsSlowPct: 0, spotVsEmaSlowPct: 0 });
  assert.equal(normalizeTrend(null, '2026-10-05', '2026-10-06').state, 'UNKNOWN');
  assert.equal(normalizeTrend(t('BULLISH'), '2026-10-05', '2026-10-06').stale, false);
  assert.equal(normalizeTrend(t('BULLISH'), '2026-10-02', '2026-10-06').stale, false); // long weekend tolerance
  assert.equal(normalizeTrend(t('BULLISH'), '2026-09-25', '2026-10-06').stale, true);
  assert.equal(normalizeTrend(t('BULLISH'), null, '2026-10-06').stale, true);
});

test('mode parsing: unknown/missing values fall back to OBSERVE, never ENFORCED', () => {
  assert.equal(parseDirectionConfirmationMode(undefined), 'RR_TREND_OBSERVE');
  assert.equal(parseDirectionConfirmationMode('garbage'), 'RR_TREND_OBSERVE');
  assert.equal(parseDirectionConfirmationMode('RR_ONLY'), 'RR_ONLY');
  assert.equal(parseDirectionConfirmationMode('RR_TREND_ENFORCED'), 'RR_TREND_ENFORCED');
});

// ---- integration with the real optimizer, on a skewed chain ----
const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);
const DAY_MS = 86_400_000;
const BASE_PARAMS = { lotSize: 75, wingWidths: [200, 400, 600] };

function skewedChain(dte: number, callVol: number, putVol: number): RawChainPayload {
  const expiry = NOW + dte * DAY_MS;
  const T = yearFraction(NOW, expiry);
  const rows = (['CE', 'PE'] as const).flatMap((right) => STRIKES.map((strike) => ({
    right, strike, expiry, asOf: NOW, openInterest: 50_000,
    settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol: right === 'CE' ? callVol : putVol, rate: 0.065, right }).price,
  })));
  return { source: { providerId: 't', kind: 'eod', retrievedAt: NOW }, contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: 0.065, dividendYield: 0 }, rows };
}
const trendOf = (state: DirectionTrend, stale = false) => ({ state, stale, ageDays: 1, asOfDate: '2026-08-30' });
const ctx = (mode: any, state: DirectionTrend, stale = false) => ({ mode, trend: trendOf(state, stale), trendDetail: null });

test('policy hook absent: evaluateExpiries output is exactly the original RR-only behavior', () => {
  const { chain } = normalise(skewedChain(10, 0.13, 0.18));
  const a = evaluateExpiries(enrichChain(chain), BASE_PARAMS);
  const b = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, strategyLabelPolicy: undefined });
  assert.deepEqual(a, b);
  assert.equal(a[0].strategyLabel, 'Bear Call Spread'); // heavy put skew -> RR bearish
});

test('OBSERVE: evaluations handed to the pipeline are identical to RR-only, even when the proposal differs', () => {
  const { chain } = normalise(skewedChain(10, 0.13, 0.18));
  const enriched = enrichChain(chain);
  const rrOnly = evaluateExpiries(enriched, BASE_PARAMS);
  const observed = evaluateExpiriesWithConfirmation(enriched, BASE_PARAMS, ctx('RR_TREND_OBSERVE', 'BULLISH'));
  assert.deepEqual(observed.evaluations, rrOnly);
  assert.equal(observed.telemetry.length, 1);
  assert.equal(observed.telemetry[0].originalStructure, 'Bear Call Spread');
  assert.equal(observed.telemetry[0].proposedStructure, 'Iron Condor'); // bearish RR + mild bullish trend
  assert.equal(observed.telemetry[0].reasonCode, 'RR_TREND_CONFLICT');
  assert.ok(observed.telemetry[0].optimizerProposed, 'the proposed structure is optimized in parallel for telemetry');
});

test('RR_ONLY: no parallel evaluation, no telemetry', () => {
  const { chain } = normalise(skewedChain(10, 0.13, 0.18));
  const r = evaluateExpiriesWithConfirmation(enrichChain(chain), BASE_PARAMS, ctx('RR_ONLY', 'BULLISH'));
  assert.equal(r.telemetry.length, 0);
  assert.equal(r.proposed, null);
});

test('ENFORCED: aligned signals keep the directional spread with the unchanged optimizer and score', () => {
  const { chain } = normalise(skewedChain(10, 0.13, 0.18));
  const enriched = enrichChain(chain);
  const rrOnly = evaluateExpiries(enriched, BASE_PARAMS);
  const enforced = evaluateExpiriesWithConfirmation(enriched, BASE_PARAMS, ctx('RR_TREND_ENFORCED', 'STRONG_BEARISH'));
  assert.equal(enforced.evaluations[0].strategyLabel, 'Bear Call Spread');
  assert.equal(enforced.evaluations[0].best!.qualityScore.score, rrOnly[0].best!.qualityScore.score);
  assert.deepEqual(enforced.evaluations[0].best!.result, rrOnly[0].best!.result);
});

test('ENFORCED: a strong opposing trend declines the expiry before the optimizer runs, and NO_TRADE reaches decideTrade', () => {
  const { chain } = normalise(skewedChain(10, 0.13, 0.18));
  const enforced = evaluateExpiriesWithConfirmation(enrichChain(chain), BASE_PARAMS, ctx('RR_TREND_ENFORCED', 'STRONG_BULLISH'));
  const e = enforced.evaluations[0];
  assert.equal(e.best, null);
  assert.equal(e.candidateCount, 0);
  assert.match(e.skipReason!, /RR_TREND_STRONG_CONFLICT/);
  const decision = decideTrade(enforced.evaluations, DEFAULT_DECISION_THRESHOLDS, null);
  assert.equal(decision.action, 'NO_TRADE');
  assert.equal(decision.expiryEvaluation?.best ?? null, null);
});

test('ENFORCED: missing or stale trend data blocks entry', () => {
  const { chain } = normalise(skewedChain(10, 0.13, 0.18));
  const enriched = enrichChain(chain);
  assert.equal(evaluateExpiriesWithConfirmation(enriched, BASE_PARAMS, ctx('RR_TREND_ENFORCED', 'UNKNOWN')).evaluations[0].best, null);
  assert.equal(evaluateExpiriesWithConfirmation(enriched, BASE_PARAMS, ctx('RR_TREND_ENFORCED', 'BEARISH', true)).evaluations[0].best, null);
});

test('neutral RR (flat smile) + NEUTRAL trend -> Iron Condor, same as RR-only', () => {
  const { chain } = normalise(skewedChain(10, 0.14, 0.14));
  const enriched = enrichChain(chain);
  const enforced = evaluateExpiriesWithConfirmation(enriched, BASE_PARAMS, ctx('RR_TREND_ENFORCED', 'NEUTRAL'));
  assert.equal(enforced.evaluations[0].strategyLabel, 'Iron Condor');
  assert.equal(enforced.telemetry[0].rrDirection, 'neutral');
});

test('expiries excluded by the DTE band produce no telemetry row (no candidate was evaluated)', () => {
  const { chain } = normalise(skewedChain(1, 0.13, 0.18));
  const r = evaluateExpiriesWithConfirmation(enrichChain(chain), BASE_PARAMS, ctx('RR_TREND_OBSERVE', 'BULLISH'));
  assert.equal(r.telemetry.length, 0);
});
