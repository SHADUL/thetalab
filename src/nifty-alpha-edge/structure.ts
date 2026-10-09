/**
 * Instrument selection and payoff for the hedged131 vertical credit spread.
 * Expiry, strike-step and ATM selection reuse the shared hedged-family
 * resolvers unchanged; only the two-leg template is specific to this
 * strategy.
 */
import { resolveLadder } from '../nifty-alpha-ladder/instruments/ladderTemplate.ts';
import type { Direction, LegTemplateEntry, ResolvedLeg } from '../nifty-alpha-ladder/types.ts';
import { BEARISH_OPTION_TYPE, WING_STEPS } from './parameters.ts';

/** Declared in BEARISH orientation, in placement order: protective wing first, then the short ATM. */
export const CREDIT_SPREAD_TEMPLATE: LegTemplateEntry[] = [
  { offsetSteps: WING_STEPS, ratio: 1, side: 'BUY' },
  { offsetSteps: 0, ratio: 1, side: 'SELL' },
];

export type StructureLabel = 'Bear Call Spread' | 'Bull Put Spread';

export function structureLabel(direction: Direction): StructureLabel {
  return direction === -1 ? 'Bear Call Spread' : 'Bull Put Spread';
}

/**
 * Resolves both legs in ONE atomic step around a single ATM (spec §5).
 * Returns null if any leg's strike is not listed — the structure is then
 * not created that day (never substitute a strike).
 */
export function resolveCreditSpread(
  direction: Direction, atm: number, strikeStep: number, expiry: string, listedStrikes: number[],
): ResolvedLeg[] | null {
  const legs = resolveLadder(direction, atm, strikeStep, expiry, listedStrikes, CREDIT_SPREAD_TEMPLATE, BEARISH_OPTION_TYPE);
  return legs.every((l) => l !== null) ? (legs as ResolvedLeg[]) : null;
}

export interface SpreadRisk {
  /** Net credit per unit, index points. */
  creditPoints: number;
  wingPoints: number;
  maxGainRupees: number;
  maxLossRupees: number;
  breakeven: number;
}

/** Spec §6: max gain = c, max loss = W − c, break-even A + c (bearish) / A − c (bullish), all × quantity. */
export function spreadRisk(direction: Direction, atm: number, wingPoints: number, creditPoints: number, quantity: number): SpreadRisk {
  return {
    creditPoints, wingPoints,
    maxGainRupees: quantity * creditPoints,
    maxLossRupees: quantity * (wingPoints - creditPoints),
    breakeven: direction === -1 ? atm + creditPoints : atm - creditPoints,
  };
}

/** Expiry P&L per unit (points) at index level S — V(S) + c, mirrored for bullish. */
export function expiryPnlPoints(direction: Direction, atm: number, wingPoints: number, creditPoints: number, spot: number): number {
  const pos = (x: number) => Math.max(x, 0);
  const value = direction === -1
    ? -pos(spot - atm) + pos(spot - atm - wingPoints)
    : -pos(atm - spot) + pos(atm - wingPoints - spot);
  return creditPoints + value;
}

/** Points for the UI payoff chart: P&L in rupees across a spot range centred on the ATM. */
export function payoffCurve(direction: Direction, atm: number, wingPoints: number, creditPoints: number, quantity: number, halfRange = 600, step = 10): Array<{ spot: number; pnl: number }> {
  const out: Array<{ spot: number; pnl: number }> = [];
  for (let s = atm - halfRange; s <= atm + halfRange; s += step) {
    out.push({ spot: s, pnl: quantity * expiryPnlPoints(direction, atm, wingPoints, creditPoints, s) });
  }
  return out;
}
