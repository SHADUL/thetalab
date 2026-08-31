/**
 * The thin end-to-end slice: one real strategy, built from Greeks rather than
 * "strike ± N points from spot" the way the app's existing readymade builder
 * works. Short strikes are chosen by target delta; everything downstream
 * (credit, max profit/loss, breakevens, net Greeks, POP) is computed from
 * the engine's own priced quotes, not re-derived separately.
 *
 * Deliberately narrow: this is not Phase 4-12's full strategy library,
 * scoring model or risk engine. It exists to prove the wiring — real chain
 * data in, a real Greek-selected trade out, onto the actual site — before
 * any of that gets built on top.
 */
import { normCdf } from '../math/normal.ts';
import { isUsable } from '../types.ts';
import type { EnrichedQuote, EnrichedSlice, Greeks, Right } from '../types.ts';

export interface IronCondorLeg {
  side: 'BUY' | 'SELL';
  right: Right;
  strike: number;
  price: number;
  iv: number | null;
  delta: number | null;
}

export interface IronCondorResult {
  legs: IronCondorLeg[];
  netCredit: number;
  maxProfit: number;
  maxLoss: number;
  breakevens: [number, number];
  netGreeks: Greeks;
  /**
   * Model-implied probability of expiring between the breakevens, from the
   * same lognormal assumption as the rest of this engine. NOT a guarantee —
   * it understates tail risk the same way every number from this model does.
   */
  pop: number | null;
  forward: number;
  forwardSource: EnrichedSlice['forwardSource'];
  atmIv: number | null;
  dte: number;
}

export interface IronCondorFailure {
  reason: string;
}

export interface IronCondorParams {
  /** Positive number, e.g. 0.16 — the |delta| the short strikes should sit near. */
  targetShortDelta: number;
  /** Width of each wing, in strike points. */
  wingWidth: number;
  lotSize: number;
}

function closestByAbsDelta(qs: EnrichedQuote[], target: number): EnrichedQuote {
  return qs.reduce((best, q) =>
    Math.abs(Math.abs(q.greeks.delta ?? 0) - target) < Math.abs(Math.abs(best.greeks.delta ?? 0) - target)
      ? q
      : best,
  );
}

function netOf(legs: Array<{ dir: 1 | -1; g: Greeks }>, key: keyof Greeks): number {
  return legs.reduce((sum, l) => sum + l.dir * (l.g[key] ?? 0), 0);
}

export function buildIronCondor(
  slice: EnrichedSlice,
  params: IronCondorParams,
): IronCondorResult | IronCondorFailure {
  const usable = slice.quotes.filter(isUsable);

  const calls = usable.filter(
    (q) => q.quote.right === 'CE' && q.quote.strike > slice.forward && q.greeks.delta !== null,
  );
  const puts = usable.filter(
    (q) => q.quote.right === 'PE' && q.quote.strike < slice.forward && q.greeks.delta !== null,
  );
  if (calls.length === 0 || puts.length === 0) {
    return { reason: 'Not enough usable OTM strikes with valid Greeks on both sides.' };
  }

  const shortCall = closestByAbsDelta(calls, params.targetShortDelta);
  const shortPut = closestByAbsDelta(puts, params.targetShortDelta);

  const byKey = new Map(usable.map((q) => [`${q.quote.strike}:${q.quote.right}`, q]));
  const longCallStrike = shortCall.quote.strike + params.wingWidth;
  const longPutStrike = shortPut.quote.strike - params.wingWidth;
  const longCall = byKey.get(`${longCallStrike}:CE`);
  const longPut = byKey.get(`${longPutStrike}:PE`);

  if (!longCall || !longPut) {
    return {
      reason: `No usable quote at the ${params.wingWidth}-point wing ` +
        `(${longCallStrike} CE / ${longPutStrike} PE) — try a narrower wing.`,
    };
  }
  if (
    shortCall.markPrice === null || longCall.markPrice === null ||
    shortPut.markPrice === null || longPut.markPrice === null
  ) {
    return { reason: 'One or more legs has no usable mark price.' };
  }

  const callCredit = shortCall.markPrice - longCall.markPrice;
  const putCredit = shortPut.markPrice - longPut.markPrice;
  const netCredit = callCredit + putCredit;
  if (netCredit <= 0) {
    return { reason: 'Net credit at these strikes is zero or negative — not worth selling.' };
  }

  const callWidth = longCallStrike - shortCall.quote.strike;
  const putWidth = shortPut.quote.strike - longPutStrike;
  const maxLossPerUnit = Math.max(callWidth - callCredit, putWidth - putCredit);

  const legQuotes: Array<{ side: IronCondorLeg['side']; q: EnrichedQuote; dir: 1 | -1 }> = [
    { side: 'SELL', q: shortPut, dir: -1 },
    { side: 'BUY', q: longPut, dir: 1 },
    { side: 'SELL', q: shortCall, dir: -1 },
    { side: 'BUY', q: longCall, dir: 1 },
  ];

  const legs: IronCondorLeg[] = legQuotes.map(({ side, q }) => ({
    side,
    right: q.quote.right,
    strike: q.quote.strike,
    price: q.markPrice as number,
    iv: q.iv,
    delta: q.greeks.delta,
  }));

  const greeksIn = legQuotes.map(({ dir, q }) => ({ dir, g: q.greeks }));
  const netGreeks: Greeks = {
    delta: netOf(greeksIn, 'delta'),
    gamma: netOf(greeksIn, 'gamma'),
    theta: netOf(greeksIn, 'theta'),
    vega: netOf(greeksIn, 'vega'),
    rho: netOf(greeksIn, 'rho'),
  };

  const breakevens: [number, number] = [
    shortPut.quote.strike - netCredit,
    shortCall.quote.strike + netCredit,
  ];

  // POP: model-implied probability the forward finishes between the
  // breakevens at expiry, using the true ATM IV (not the short legs' own —
  // those are already skewed away from the middle) as the vol assumption.
  const atmCall = slice.atmStrike !== null
    ? usable.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'CE') : undefined;
  const atmPut = slice.atmStrike !== null
    ? usable.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'PE') : undefined;
  const atmIv =
    atmCall?.iv != null && atmPut?.iv != null ? (atmCall.iv + atmPut.iv) / 2
      : (atmCall?.iv ?? atmPut?.iv ?? null);

  let pop: number | null = null;
  if (atmIv !== null && slice.timeToExpiry > 0) {
    const sqrtT = Math.sqrt(slice.timeToExpiry);
    // P(S_T > K) = N(d2(K)); d2 is DECREASING in K, so P(lower < S_T < upper)
    // is N(d2(lower)) minus N(d2(upper)), not the other way round.
    const d2 = (k: number) =>
      (Math.log(slice.forward / k) - 0.5 * atmIv * atmIv * slice.timeToExpiry) / (atmIv * sqrtT);
    pop = normCdf(d2(breakevens[0])) - normCdf(d2(breakevens[1]));
  }

  return {
    legs,
    netCredit,
    maxProfit: netCredit * params.lotSize,
    maxLoss: maxLossPerUnit * params.lotSize,
    breakevens,
    netGreeks,
    pop,
    forward: slice.forward,
    forwardSource: slice.forwardSource,
    atmIv,
    dte: Math.round(slice.timeToExpiry * 365),
  };
}

export function isIronCondorFailure(r: IronCondorResult | IronCondorFailure): r is IronCondorFailure {
  return 'reason' in r;
}
