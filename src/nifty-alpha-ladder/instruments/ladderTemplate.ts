/**
 * Definition 3.4 — leg template (bearish orientation, declared once) and the
 * mirror operator ℳ. Definition 3.5 / Eq (3.1) — atomic resolution to actual
 * contracts. Placement order is the declared order and must never be
 * reordered (your instruction §13/§19 — "Do not reorder").
 */
import type { Direction, LegTemplateEntry, OptionRight, ResolvedLeg } from '../types.ts';

/** The declared bearish-orientation template, in placement order: Buy ATM, Buy far, Sell middle (spec §7 leg table). */
export const BEARISH_TEMPLATE: LegTemplateEntry[] = [
  { offsetSteps: 0, ratio: 4, side: 'BUY' },
  { offsetSteps: -8, ratio: 1, side: 'BUY' },
  { offsetSteps: -4, ratio: 5, side: 'SELL' },
];

/** ω⁻ — the bearish option type for THIS structure (ratio ladders are naturally bearish in puts; a single hard-coded type would silently invert a call-spread-shaped sibling, so this is stated per-structure, not globally). */
export const BEARISH_OPTION_TYPE: OptionRight = 'PE';

function mirrorType(right: OptionRight): OptionRight {
  return right === 'PE' ? 'CE' : 'PE';
}

/**
 * Resolves every leg of the template for direction D around one shared ATM
 * strike, strike step and expiry — a single atomic call, never leg-by-leg
 * (so the spot cannot move between requests and key different legs to
 * different ATM strikes). `listedStrikes` is the set of strikes actually
 * listed for `expiry` (the caller's job to fetch); a leg whose resolved
 * strike is not in that set resolves to `null` for that leg, and the whole
 * structure must then be treated as unresolvable for the day (spec: "If any
 * leg is null the structure is not created for that day").
 */
export function resolveLadder(
  direction: Direction,
  atmStrike: number,
  strikeStep: number,
  expiry: string,
  listedStrikes: number[],
  template: LegTemplateEntry[] = BEARISH_TEMPLATE,
  bearishType: OptionRight = BEARISH_OPTION_TYPE,
): Array<ResolvedLeg | null> {
  const listed = new Set(listedStrikes);
  const right: OptionRight = direction === -1 ? bearishType : mirrorType(bearishType);

  return template.map((leg) => {
    const offset = direction === -1 ? leg.offsetSteps : -leg.offsetSteps;
    const strike = atmStrike + offset * strikeStep;
    if (!listed.has(strike)) return null;
    return { strike, expiry, right, side: leg.side, ratio: leg.ratio };
  });
}

/** Convenience: true iff every leg resolved (no null) — the structure-resolvability gate (Gate 5.7's first clause). */
export function allLegsResolved(legs: Array<ResolvedLeg | null>): legs is ResolvedLeg[] {
  return legs.every((l) => l !== null);
}
