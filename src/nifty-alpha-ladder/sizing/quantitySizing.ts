/**
 * Definition 6.2 — quantity mode. n_u is the configured unit quantity
 * directly; the broker-quoted margin of a structure proxy is compared
 * against head-room by Gate 5.12 (capitalGate.ts), not consulted here.
 */
import type { LegTemplateEntry } from '../types.ts';

export function computeQuantityModeUnits(configuredUnitQuantity: number): number {
  return configuredUnitQuantity;
}

/**
 * The structure-proxy margin quote rule (Definition 6.2): for a 2-leg
 * structure, the proxy is the first declared leg at size n_u·Q1; for a
 * structure with MORE than two legs (Nifty Alpha Ladder has three), the
 * proxy is the sum of the quotes for every SHORT leg at their sizes.
 * Returns which legs (by index into the template) should be quoted and
 * summed — the actual broker margin-quote call is a Milestone 3/5 concern
 * (needs a live broker connection); this function only implements the
 * PDF's selection rule for which legs constitute the proxy.
 */
export function structureProxyLegIndices(template: LegTemplateEntry[]): number[] {
  if (template.length === 2) return [0];
  return template.reduce<number[]>((acc, leg, i) => {
    if (leg.side === 'SELL') acc.push(i);
    return acc;
  }, []);
}
