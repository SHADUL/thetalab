/**
 * Option pre-subscription planner (approved 23 Nov 2026).
 *
 * From 09:46 — once the opening range is final — keep the shared Kite stream
 * subscribed to the 150-point ITM contracts a signal would most likely need,
 * so their quotes are already flowing when an entry minute starts:
 *   GAP_GO_ARMED   gap direction only: the selector's strike for the breakout
 *                  band and for the latest NIFTY close, ± one listed strike.
 *   WILLIAMS_ARMED both sides: the same around the CE and PE levels.
 *   any other state → nothing (session decided / position handled by the
 *                  engine's own wanted tokens).
 * Strikes, interval and expiry come from the same selector the engine uses
 * (instrument master, Q7–Q9). Capped at MAX_PRESUBSCRIBED contracts.
 * Pure: it only returns contracts; the service does the `want`.
 */
import type { AscentEngine } from '../core/engine.ts';
import { selectContract, type Instrument } from '../core/contracts.ts';
import type { Right } from '../core/levels.ts';

export const MAX_PRESUBSCRIBED = 8;

export interface PresubPlan { contracts: Instrument[]; reason: string }

export function planPresubscription(e: AscentEngine, lastClose: number | null): PresubPlan {
  if (!e.or || lastClose == null) return { contracts: [], reason: 'opening range not final' };
  const refs: Array<[Right, number]> = [];
  if (e.state === 'GAP_GO_ARMED' && e.gap) {
    const up = e.gap.direction === 'UP';
    const right: Right = up ? 'CE' : 'PE';
    refs.push([right, up ? e.or.upsideBand : e.or.downsideBand], [right, lastClose]);
  } else if (e.state === 'WILLIAMS_ARMED' && e.williams) {
    refs.push(['CE', e.williams.ceLevel], ['PE', e.williams.peLevel], ['CE', lastClose], ['PE', lastClose]);
  } else {
    return { contracts: [], reason: `no pre-subscription in ${e.state}` };
  }
  const primary: Instrument[] = [], neighbours: Instrument[] = [];
  const seen = new Set<number>();
  const add = (list: Instrument[], i: Instrument | undefined) => { if (i && !seen.has(i.token)) { seen.add(i.token); list.push(i); } };
  for (const [right, ref] of refs) {
    const sel = selectContract(e.instruments, e.date, right, ref, e.rules);
    if (!sel.ok) continue;
    add(primary, sel.instrument);
    const chain = e.instruments.filter((i) => i.expiry === sel.expiry && i.right === right);
    add(neighbours, chain.find((i) => Math.abs(i.strike - (sel.strike - sel.step)) < 1e-6));
    add(neighbours, chain.find((i) => Math.abs(i.strike - (sel.strike + sel.step)) < 1e-6));
  }
  const contracts = [...primary, ...neighbours].slice(0, MAX_PRESUBSCRIBED);
  return { contracts, reason: `${e.state}: ${contracts.map((c) => c.tradingsymbol).join(', ')}` };
}
