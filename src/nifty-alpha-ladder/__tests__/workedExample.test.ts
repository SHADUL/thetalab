/**
 * The PDF's own worked numerical example (spec §15 / §19 of the source
 * document) as one end-to-end deterministic replay: signal -> alignment ->
 * Variation C -> instrument resolution -> sizing -> payoff. Every
 * intermediate and final value asserted below is copied verbatim from the
 * PDF; none have been adjusted to make the test pass, per your instruction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSignal } from '../signal/signalEngine.ts';
import { computeG1Knots } from '../signal/largeOrderNet.ts';
import { computeG2Knots } from '../signal/imbalancePath.ts';
import { selectExpiry } from '../calendar/expirySelection.ts';
import { selectATM, deriveStrikeStep } from '../instruments/strikeResolver.ts';
import { resolveLadder, allLegsResolved } from '../instruments/ladderTemplate.ts';
import { computeUnitModeUnits } from '../sizing/unitSizing.ts';
import { computePayoffSummary } from '../risk/payoff.ts';
import type { AggregateSnapshot } from '../types.ts';

const ORIGIN = Date.UTC(2026, 8, 30, 9, 15, 0); // 09:15 IST, the shared t=0 for both grids
const CUTOFF_SEC = (14 * 60 + 30 - (9 * 60 + 15)) * 60; // 14:30
const toSec = (h: number, m: number) => (h * 60 + m - (9 * 60 + 15)) * 60;

function buildG1Knots() {
  const stamps: Array<[string, number]> = [
    ['09:16', 420], ['09:24', 1380], ['09:35', 2610], ['09:47', 1950],
    ['09:58', 3240], ['10:06', 2880], ['10:15', 3700],
  ];
  const events = stamps.map(([hm, cumulative], i) => {
    const [h, m] = hm.split(':').map(Number);
    const delta = i === 0 ? cumulative : cumulative - stamps[i - 1][1];
    return { side: 'b' as const, timestampMs: Date.UTC(2026, 8, 30, h, m, 0), quantity: delta, orderCount: 1 };
  });
  return computeG1Knots(events, ORIGIN);
}

function buildG2Knots() {
  const rows: Array<[string, number]> = [
    ['09:18', -0.41], ['09:21', -0.44], ['09:24', 0.02], ['09:27', -0.46], ['09:30', -0.52],
    ['09:33', -0.38], ['09:36', -0.61], ['09:39', -0.27], ['09:42', -0.02], ['09:45', -0.55],
    ['09:48', -0.63], ['09:51', -0.49], ['09:54', -0.58], ['09:57', -0.41], ['10:00', -0.72],
    ['10:03', -0.66], ['10:06', -0.57], ['10:09', -0.69], ['10:12', -0.74],
  ];
  const snapshots: AggregateSnapshot[] = rows.map(([hm, rho]) => {
    const [h, m] = hm.split(':').map(Number);
    return { timeSec: (Date.UTC(2026, 8, 30, h, m, 0) - ORIGIN) / 1000, bidQty: (1 + rho) * 50, askQty: (1 - rho) * 50 };
  });
  return computeG2Knots(snapshots);
}

test('worked example — full replay reproduces every stated PDF value', () => {
  const g1Knots = buildG1Knots();
  const g2Knots = buildG2Knots();

  // --- Step 2/3/4/5: signal engine ---
  const decision = evaluateSignal({
    g1Knots,
    g2Knots,
    nowSec: toSec(10, 13), // t_f — the lattice evaluation that notices the 10:12 crossing
    cutoffSec: CUTOFF_SEC,
    vix: { value: 11.87, available: true },
  });

  assert.equal(decision.fired, true);
  if (!decision.fired) return;

  assert.equal(decision.path, 'crossing');
  assert.equal(decision.signalInstantSec, toSec(10, 12));
  assert.ok(Math.abs(decision.crossingG2Value! - -9.13) < 0.01, `crossing G2 value: ${decision.crossingG2Value}`);
  assert.equal(decision.d2, -1);
  assert.ok(Math.abs(decision.area1 - 7_707_000) < 1, `G1 signed area: ${decision.area1}`);
  assert.equal(decision.d1, 1);
  assert.equal(decision.alpha, 0); // divergent
  assert.equal(decision.baseDirection, 1); // D0 bullish
  assert.equal(decision.vixValue, 11.87);
  assert.equal(decision.variationCActed, true);
  assert.equal(decision.finalDirection, -1); // D bearish — the family trades bearish for the week

  // --- Step 6: monitor leg (reference values only, monitor module is Milestone 3 — asserted here as plain arithmetic) ---
  const F0 = 24_211.80;
  const storedTarget = F0 + decision.finalDirection * 300;
  assert.ok(Math.abs(storedTarget - 23_911.80) < 1e-6);

  // --- Step 7: strike and expiry resolution ---
  const spotAtResolution = 24_137.40;
  const listedStrikes = [23_750, 23_950, 24_150, 24_350, 23_550, 24_000, 24_100, 24_200];
  const strikeStep = deriveStrikeStep(listedStrikes);
  assert.equal(strikeStep, 50);
  const atm = selectATM(spotAtResolution, listedStrikes);
  assert.equal(atm, 24_150);

  const signalDate = new Date('2026-09-30T00:00:00Z'); // the hypothetical Wednesday W
  const followingTuesday = new Date('2026-10-06T00:00:00Z'); // six calendar days out
  const expiry = selectExpiry(signalDate, [followingTuesday]);
  assert.equal(expiry?.toISOString().slice(0, 10), '2026-10-06');

  const legs = resolveLadder(decision.finalDirection, atm, strikeStep, expiry!.toISOString().slice(0, 10), listedStrikes);
  assert.ok(allLegsResolved(legs));
  assert.deepEqual(
    legs.map((l) => [l.side, l.right, l.strike, l.ratio]),
    [
      ['BUY', 'PE', 24_150, 4],
      ['BUY', 'PE', 23_750, 1],
      ['SELL', 'PE', 23_950, 5],
    ],
  );

  // --- Step 8: sizing ---
  const allocatedCapital = 700_000;
  const unitBudget = 340_000;
  const units = computeUnitModeUnits(allocatedCapital, unitBudget);
  assert.equal(units, 2);

  // --- Step 9: fills and net debit (fills are Milestone 3 execution concerns; the
  // PDF's own hypothetical fills are taken as given inputs to the payoff math here) ---
  const fillBuy1 = 111.35; // Buy 4x 24,150 PE
  const fillBuy2 = 17.45; // Buy 1x 23,750 PE
  const fillSell = 47.45; // Sell 5x 23,950 PE
  // Net debit per unit = 4*buy1 + 1*buy2 - 5*sell (index points; the PDF's own worked value is 225.60)
  const netDebitPerUnit = 4 * fillBuy1 + 1 * fillBuy2 - 5 * fillSell;
  assert.ok(Math.abs(netDebitPerUnit - 225.60) < 0.01, `net debit per unit: ${netDebitPerUnit}`);

  // --- Payoff / risk ---
  const lotSize = 75;
  const summary = computePayoffSummary(netDebitPerUnit, units, lotSize, atm);
  assert.ok(Math.abs(summary.maxLoss - 33_840) < 1, `max loss: ${summary.maxLoss}`);
  assert.ok(Math.abs(summary.maxGain - 86_160) < 1, `max gain: ${summary.maxGain}`);
  assert.ok(Math.abs(summary.tailValue - 56_160) < 1, `tail value: ${summary.tailValue}`);
  assert.equal(summary.breakEvens.length, 1);
  assert.ok(Math.abs(summary.breakEvens[0] - 24_093.60) < 0.01, `break-even: ${summary.breakEvens[0]}`);
});
