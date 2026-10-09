import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCreditSpread, spreadRisk, expiryPnlPoints, structureLabel } from '../structure.ts';
import { deriveStrikeStep, selectATM } from '../../nifty-alpha-ladder/instruments/strikeResolver.ts';
import { selectExpiry } from '../../nifty-alpha-ladder/calendar/expirySelection.ts';
import { marketableLimitPrice } from '../../nifty-alpha-ladder/execution/marketableLimit.ts';
import { computeUnitModeUnits } from '../../nifty-alpha-ladder/sizing/unitSizing.ts';
import { totalPnl, creditPoints } from '../lifecycle.ts';
import { UNIT_BUDGET_RUPEES } from '../parameters.ts';
import { STRIKES } from './fakes.ts';

// ---- golden worked example (doc §14 / original §19) ----

test('worked example: spot 24,137.40, step 50 -> ATM 24,150; bear call spread = BUY CE 24,350 then SELL CE 24,150', () => {
  assert.equal(deriveStrikeStep(STRIKES), 50);
  const atm = selectATM(24_137.4, STRIKES);
  assert.equal(atm, 24_150);
  const legs = resolveCreditSpread(-1, atm, 50, '2026-10-20', STRIKES)!;
  assert.deepEqual(legs.map((l) => [l.side, l.strike, l.right]), [['BUY', 24_350, 'CE'], ['SELL', 24_150, 'CE']]);
  assert.equal(structureLabel(-1), 'Bear Call Spread');
});

test('bullish mirror: BUY PE ATM-200 then SELL PE ATM', () => {
  const legs = resolveCreditSpread(1, 24_150, 50, '2026-10-20', STRIKES)!;
  assert.deepEqual(legs.map((l) => [l.side, l.strike, l.right]), [['BUY', 23_950, 'PE'], ['SELL', 24_150, 'PE']]);
  assert.equal(structureLabel(1), 'Bull Put Spread');
});

test('a missing leg strike means no structure — never a substitute strike', () => {
  assert.equal(resolveCreditSpread(-1, 24_150, 50, '2026-10-20', STRIKES.filter((s) => s !== 24_350)), null);
});

test('ATM ties resolve to the lower strike', () => {
  assert.equal(selectATM(24_175, STRIKES), 24_150);
});

test('expiry: a Wednesday signal takes the following Tuesday (6 days); a 1-day-away nearest expiry is skipped', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  assert.equal(selectExpiry(d('2026-10-14'), [d('2026-10-20'), d('2026-10-27')])!.toISOString().slice(0, 10), '2026-10-20');
  assert.equal(selectExpiry(d('2026-10-19'), [d('2026-10-20'), d('2026-10-27')])!.toISOString().slice(0, 10), '2026-10-27');
});

test('worked example limits: BUY p=36.80 -> 39.80, SELL p=118.60 -> 109.10', () => {
  assert.equal(marketableLimitPrice('BUY', 36.8, 0.05).toFixed(2), '39.80');
  assert.equal(marketableLimitPrice('SELL', 118.6, 0.05).toFixed(2), '109.10');
});

test('worked example sizing: ₹3,00,000 / ₹1,25,000 -> 2 units -> 150 per leg at lot 75', () => {
  const units = computeUnitModeUnits(300_000, UNIT_BUDGET_RUPEES);
  assert.equal(units, 2);
  assert.equal(units * 75, 150);
});

test('worked example risk: credit 81.50 -> max loss ₹17,775, max gain ₹12,225, break-even 24,231.50', () => {
  const credit = creditPoints([{ side: 'BUY', entryFill: 36.95 }, { side: 'SELL', entryFill: 118.45 }]);
  assert.equal(credit.toFixed(2), '81.50');
  const r = spreadRisk(-1, 24_150, 200, credit, 150);
  assert.equal(Math.round(r.maxLossRupees), 17_775);
  assert.equal(Math.round(r.maxGainRupees), 12_225);
  assert.equal(r.breakeven.toFixed(2), '24231.50');
});

test('worked example exit: short bought back 3.50, wing sold 0.40 -> 78.40 pts = ₹11,760 (96.2% of credit)', () => {
  const pnl = totalPnl([
    { side: 'BUY', quantity: 150, entryFill: 36.95, exitPrice: 0.4 },
    { side: 'SELL', quantity: 150, entryFill: 118.45, exitPrice: 3.5 },
  ]);
  assert.equal(Math.round(pnl), 11_760);
  assert.equal(((78.4 / 81.5) * 100).toFixed(1), '96.2');
});

test('worked example adverse case: index 24,420 at expiry -> -118.50 pts = -₹17,775', () => {
  const pts = expiryPnlPoints(-1, 24_150, 200, 81.5, 24_420);
  assert.equal(pts.toFixed(2), '-118.50');
  assert.equal(Math.round(pts * 150), -17_775);
});

test('payoff is bounded: never below -(W - c) and never above c, on both sides', () => {
  for (const dir of [-1, 1] as const) {
    for (let s = 23_000; s <= 25_500; s += 25) {
      const p = expiryPnlPoints(dir, 24_150, 200, 81.5, s);
      assert.ok(p <= 81.5 + 1e-9 && p >= -118.5 - 1e-9, `${dir} ${s} ${p}`);
    }
  }
});

test('limit rounding never softens the buffer and a sell limit is never below one tick', () => {
  for (const p of [0.05, 0.4, 3, 12.37, 36.8, 118.6, 401.15]) {
    const buy = marketableLimitPrice('BUY', p, 0.05);
    const sell = marketableLimitPrice('SELL', p, 0.05);
    const b = Math.max(0.08 * p, 3);
    assert.ok(buy >= p + b - 1e-9);
    assert.ok(sell <= Math.max(0.05, p - b) + 1e-9 && sell >= 0.05 - 1e-9);
  }
});
