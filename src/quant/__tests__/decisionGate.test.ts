import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain, yearFraction } from '../enrich.ts';
import { black76 } from '../pricing/black76.ts';
import { evaluateExpiries } from '../strategies/expirySelector.ts';
import { classifyTradeQuality, decideTrade, DEFAULT_DECISION_THRESHOLDS } from '../strategies/decisionGate.ts';
import type { ContractSpec } from '../types.ts';

const NIFTY: ContractSpec = {
  underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 50,
  currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures',
};
const NOW = Date.parse('2026-08-31T09:30:00Z');
const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);
const DAY_MS = 86_400_000;

function expirySlice(dte: number, vol: number, openInterest = 50_000) {
  const expiry = NOW + dte * DAY_MS;
  const T = yearFraction(NOW, expiry);
  const r = 0.065;
  return (['CE', 'PE'] as const).flatMap((right) =>
    STRIKES.map((strike) => ({
      right, strike, expiry, asOf: NOW,
      settle: black76({ forward: FORWARD, strike, timeToExpiry: T, vol, rate: r, right }).price,
      openInterest,
    })),
  );
}

function multiExpiryChain(entries: Array<{ dte: number; vol: number }>): RawChainPayload {
  return {
    source: { providerId: 'test-bhavcopy', kind: 'eod', retrievedAt: NOW },
    contract: NIFTY,
    context: { valuationTime: NOW, spot: FORWARD * 0.998, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows: entries.flatMap(({ dte, vol }) => expirySlice(dte, vol)),
  };
}

const BASE_PARAMS = { lotSize: 75, wingWidths: [200, 400, 600] };

test('classifyTradeQuality is exactly threshold-bounded on the default bands', () => {
  assert.equal(classifyTradeQuality(0), 'NO_TRADE');
  assert.equal(classifyTradeQuality(69.9), 'NO_TRADE');
  assert.equal(classifyTradeQuality(70), 'WATCH');
  assert.equal(classifyTradeQuality(79.9), 'WATCH');
  assert.equal(classifyTradeQuality(80), 'TRADE_CANDIDATE');
  assert.equal(classifyTradeQuality(89.9), 'TRADE_CANDIDATE');
  assert.equal(classifyTradeQuality(90), 'HIGH_CONVICTION');
  assert.equal(classifyTradeQuality(100), 'HIGH_CONVICTION');
});

test('classifyTradeQuality honors custom thresholds over the defaults', () => {
  const custom = { noTradeBelow: 50, watchBelow: 60, highConvictionAtOrAbove: 70 };
  assert.equal(classifyTradeQuality(55, custom), 'WATCH');
  assert.equal(classifyTradeQuality(75, custom), 'HIGH_CONVICTION');
  // The SAME raw score classifies differently under the default bands —
  // 75 sits in the default WATCH band (70-80), not TRADE_CANDIDATE.
  assert.equal(classifyTradeQuality(75, DEFAULT_DECISION_THRESHOLDS), 'WATCH');
  assert.equal(classifyTradeQuality(85, DEFAULT_DECISION_THRESHOLDS), 'TRADE_CANDIDATE');
});

test('decideTrade produces a real action with an explanation citing actual strikes, bias and score', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 21, vol: 0.16 }]));
  const evaluations = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, ivRank: 68 });
  const decision = decideTrade(evaluations);

  assert.notEqual(decision.expiryEvaluation, null);
  assert.ok(['NO_TRADE', 'WATCH', 'TRADE_CANDIDATE', 'HIGH_CONVICTION'].includes(decision.action));
  assert.match(decision.explanation, /IRON CONDOR/);
  assert.match(decision.explanation, /Bias: neutral/);
  assert.match(decision.explanation, /Trade Quality Score: \d+\/100/);
  assert.match(decision.explanation, /Risk\/Reward: [\d.]+/);
  // The candidate's own legs must appear verbatim, not a summary.
  const leg = decision.expiryEvaluation!.best!.result.legs[0];
  assert.match(decision.explanation, new RegExp(`${leg.side} ${leg.strike}${leg.right}`));
});

test('decideTrade returns NO_TRADE with the real per-expiry skip reasons when nothing is eligible', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 1, vol: 0.13 }, { dte: 90, vol: 0.13 }]));
  const evaluations = evaluateExpiries(enrichChain(chain), BASE_PARAMS);
  const decision = decideTrade(evaluations);

  assert.equal(decision.action, 'NO_TRADE');
  assert.equal(decision.expiryEvaluation, null);
  assert.match(decision.explanation, /no eligible expiry today/i);
  assert.match(decision.explanation, /1d:.*gamma-risk window/);
  assert.match(decision.explanation, /90d:.*beyond the configured max/);
});

test('a score forced below a custom noTradeBelow threshold is refused with the exact reason, even though a candidate exists', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 21, vol: 0.16 }]));
  const evaluations = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, ivRank: 68 });
  const decision = decideTrade(evaluations, { noTradeBelow: 101, watchBelow: 101, highConvictionAtOrAbove: 101 });

  assert.equal(decision.action, 'NO_TRADE');
  assert.notEqual(decision.expiryEvaluation, null); // a candidate DID exist — it was just scored below the bar
  assert.match(decision.explanation, /below the configured threshold \(101\)/);
});

test('a score forced into HIGH_CONVICTION via a permissive threshold is labeled accordingly', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 21, vol: 0.16 }]));
  const evaluations = evaluateExpiries(enrichChain(chain), { ...BASE_PARAMS, ivRank: 68 });
  const decision = decideTrade(evaluations, { noTradeBelow: -1, watchBelow: -1, highConvictionAtOrAbove: -1 });

  assert.equal(decision.action, 'HIGH_CONVICTION');
  assert.match(decision.explanation, /^HIGH CONVICTION/);
});

test('missing IV rank is stated plainly in the explanation rather than a fabricated number', () => {
  const { chain } = normalise(multiExpiryChain([{ dte: 21, vol: 0.16 }]));
  const evaluations = evaluateExpiries(enrichChain(chain), BASE_PARAMS); // no ivRank supplied
  const decision = decideTrade(evaluations);
  assert.match(decision.explanation, /IV Rank: n\/a — no history supplied/);
  assert.match(decision.explanation, /excluded, not penalized:.*\bivRank\b/);
});
