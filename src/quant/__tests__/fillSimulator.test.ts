import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  simulateFill, simulateStructureFill, computeLeggingCost, describeFillMode,
  IDEAL_CONFIG, REALISTIC_CONFIG, STRESS_CONFIG, type LegQuote,
} from '../execution/fillSimulator.ts';

const LIQUID_BUY: LegQuote = {
  side: 'BUY', tradingsymbol: 'NIFTY26SEP24000CE', bid: 98, ask: 102, referencePrice: 100,
  spreadPct: 0.04, openInterest: 100_000, volume: 50_000,
};
const LIQUID_SELL: LegQuote = {
  side: 'SELL', tradingsymbol: 'NIFTY26SEP23700CE', bid: 148, ask: 152, referencePrice: 150,
  spreadPct: (152 - 148) / 150, openInterest: 100_000, volume: 50_000,
};
const EOD_ONLY: LegQuote = {
  side: 'BUY', tradingsymbol: 'NIFTY26SEP24000CE', bid: null, ask: null, referencePrice: 100,
  spreadPct: null, openInterest: 100_000, volume: 50_000,
};
const THIN_LEG: LegQuote = {
  side: 'SELL', tradingsymbol: 'NIFTY26SEP20000PE', bid: 4, ask: 8, referencePrice: 6,
  spreadPct: (8 - 4) / 6, openInterest: 50, volume: 10,
};

test('IDEAL: a BUY and a SELL both land at (approximately) mid, not at the touch', () => {
  const buy = simulateFill(LIQUID_BUY, IDEAL_CONFIG);
  const sell = simulateFill(LIQUID_SELL, IDEAL_CONFIG);
  assert.ok(Math.abs(buy.filledPrice - 100) < 1e-9, `buy filled at ${buy.filledPrice}`);
  assert.ok(Math.abs(sell.filledPrice - 150) < 1e-9, `sell filled at ${sell.filledPrice}`);
  assert.equal(buy.slippageRupees, 0);
});

test('REALISTIC: BUY moves toward ask, SELL moves toward bid — never favorably', () => {
  const buy = simulateFill(LIQUID_BUY, REALISTIC_CONFIG);
  const sell = simulateFill(LIQUID_SELL, REALISTIC_CONFIG);
  assert.ok(buy.filledPrice > 100 && buy.filledPrice <= 102, `buy filled at ${buy.filledPrice}, expected between mid and ask`);
  assert.ok(sell.filledPrice < 150 && sell.filledPrice >= 148, `sell filled at ${sell.filledPrice}, expected between bid and mid`);
  assert.ok(buy.slippageRupees > 0, 'a BUY must never show negative (favorable) slippage in this simulator');
  assert.ok(sell.slippageRupees > 0, 'a SELL must never show negative (favorable) slippage in this simulator');
});

test('STRESS is strictly worse than REALISTIC, which is strictly worse than IDEAL, for the same quote', () => {
  const ideal = simulateFill(LIQUID_BUY, IDEAL_CONFIG);
  const realistic = simulateFill(LIQUID_BUY, REALISTIC_CONFIG);
  const stress = simulateFill(LIQUID_BUY, STRESS_CONFIG);
  assert.ok(ideal.slippageRupees <= realistic.slippageRupees);
  assert.ok(realistic.slippageRupees <= stress.slippageRupees);
  assert.ok(ideal.slippageRupees < stress.slippageRupees, 'STRESS must be materially worse, not just tied');
});

test('EOD-only data (no real bid/ask) is labeled EOD_APPROXIMATION, and a real live quote is labeled LIVE_QUOTE', () => {
  const eod = simulateFill(EOD_ONLY, REALISTIC_CONFIG);
  const live = simulateFill(LIQUID_BUY, REALISTIC_CONFIG);
  assert.equal(eod.executionDataQuality, 'EOD_APPROXIMATION');
  assert.equal(live.executionDataQuality, 'LIVE_QUOTE');
});

test('EOD-only IDEAL fill is exactly the settlement price — never fabricates a spread when there is none to model favorably', () => {
  const fill = simulateFill(EOD_ONLY, IDEAL_CONFIG);
  assert.equal(fill.filledPrice, 100);
});

test('a thin/illiquid leg (below OI/volume floor) gets a worse simulated fill than an otherwise-identical liquid leg', () => {
  const liquidVersion: LegQuote = { ...THIN_LEG, openInterest: 100_000, volume: 50_000 };
  const thinFill = simulateFill(THIN_LEG, REALISTIC_CONFIG);
  const liquidFill = simulateFill(liquidVersion, REALISTIC_CONFIG);
  assert.ok(thinFill.slippageBps > liquidFill.slippageBps, `thin=${thinFill.slippageBps}bps vs liquid=${liquidFill.slippageBps}bps`);
});

test('simulateStructureFill: STRESS applies growing adverse movement to later legs in the sequence', () => {
  const legs: LegQuote[] = [LIQUID_BUY, LIQUID_SELL, { ...LIQUID_BUY, tradingsymbol: 'third-leg' }];
  const fills = simulateStructureFill(legs, 'STRESS', { stressLeggingAdverseMovePerLeg: 2 });
  // First leg (index 0) has no legging penalty; later legs do.
  assert.ok(fills[1].slippageRupees > 0);
  assert.ok(fills[2].slippageRupees > fills[0].slippageRupees, 'a later leg must show more slippage than the first leg under legging stress');
});

test('computeLeggingCost is non-negative and zero when every leg fills exactly at its decision price', () => {
  const fills = simulateStructureFill([LIQUID_BUY, LIQUID_SELL], 'IDEAL');
  const cost = computeLeggingCost(fills, [75, 75]);
  assert.ok(Math.abs(cost) < 1e-9, `expected ~0, got ${cost}`);
});

test('computeLeggingCost is strictly positive once STRESS legging movement is introduced', () => {
  const fills = simulateStructureFill([LIQUID_BUY, LIQUID_SELL], 'STRESS', { stressLeggingAdverseMovePerLeg: 3 });
  const cost = computeLeggingCost(fills, [75, 75]);
  assert.ok(cost > 0, `expected > 0, got ${cost}`);
});

test('describeFillMode never lets IDEAL pass without an explicit "theoretical ceiling only" warning', () => {
  assert.match(describeFillMode('IDEAL'), /theoretical ceiling/i);
  assert.match(describeFillMode('IDEAL'), /never present/i);
});
