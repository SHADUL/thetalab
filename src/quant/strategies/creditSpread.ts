/**
 * A single-sided defined-risk credit spread — sell one strike, buy a
 * further OTM strike on the SAME side as protection. Right='PE' is a bull
 * put spread (bullish/neutral view, profits above the breakeven); right='CE'
 * is a bear call spread (bearish/neutral view, profits below it). Same
 * shape either way, just mirrored — one implementation for both rather than
 * two near-identical copies.
 *
 * Same discipline as ironCondor.ts: strike/delta selection always runs on
 * `slice`'s own (settlement) pricing; entryPriceOverride swaps in the
 * app's actual tradeable price for the two selected strikes only, after
 * selection, and refuses rather than mixing prices from two sources.
 */
import { atmIvOf } from '../analytics/atmIv.ts';
import { normCdf } from '../math/normal.ts';
import { isUsable } from '../types.ts';
import type { EnrichedQuote, EnrichedSlice, Greeks, Right } from '../types.ts';

export interface CreditSpreadLeg {
  side: 'BUY' | 'SELL';
  right: Right;
  strike: number;
  price: number;
  iv: number | null;
  delta: number | null;
}

export interface CreditSpreadResult {
  strategy: 'bull-put-spread' | 'bear-call-spread';
  legs: [CreditSpreadLeg, CreditSpreadLeg];
  netCredit: number;
  maxProfit: number;
  maxLoss: number;
  breakeven: number;
  netGreeks: Greeks;
  /** Model-implied, same lognormal caveat as everywhere else in this engine. */
  pop: number | null;
  forward: number;
  forwardSource: EnrichedSlice['forwardSource'];
  atmIv: number | null;
  dte: number;
}

export interface CreditSpreadFailure {
  reason: string;
}

export interface CreditSpreadParams {
  /** 'PE' = bull put spread, 'CE' = bear call spread. */
  right: Right;
  targetShortDelta: number;
  wingWidth: number;
  lotSize: number;
  entryPriceOverride?: (strike: number, right: Right) => number | null;
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

export function buildCreditSpread(
  slice: EnrichedSlice,
  params: CreditSpreadParams,
): CreditSpreadResult | CreditSpreadFailure {
  const isPut = params.right === 'PE';
  const strategy: CreditSpreadResult['strategy'] = isPut ? 'bull-put-spread' : 'bear-call-spread';

  const usable = slice.quotes.filter(isUsable);
  const candidates = usable.filter((q) =>
    q.quote.right === params.right &&
    (isPut ? q.quote.strike < slice.forward : q.quote.strike > slice.forward) &&
    q.greeks.delta !== null,
  );
  if (candidates.length === 0) {
    return { reason: `Not enough usable OTM ${params.right} strikes with valid Greeks.` };
  }

  const short = closestByAbsDelta(candidates, params.targetShortDelta);
  const longStrike = isPut ? short.quote.strike - params.wingWidth : short.quote.strike + params.wingWidth;
  const long = usable.find((q) => q.quote.strike === longStrike && q.quote.right === params.right);

  if (!long) {
    return {
      reason: `No usable quote at the ${params.wingWidth}-point wing (${longStrike} ${params.right}) ` +
        `— try a narrower wing.`,
    };
  }
  if (short.markPrice === null || long.markPrice === null) {
    return { reason: 'One or more legs has no usable mark price.' };
  }

  let shortPrice = short.markPrice;
  let longPrice = long.markPrice;
  if (params.entryPriceOverride) {
    const oShort = params.entryPriceOverride(short.quote.strike, params.right);
    const oLong = params.entryPriceOverride(long.quote.strike, params.right);
    if (oShort === null || oLong === null) {
      return {
        reason: 'The strikes this delta target selects have no tradeable entry price under ' +
          'the current price basis — try Close basis, a different delta, or a wider wing.',
      };
    }
    shortPrice = oShort; longPrice = oLong;
  }

  const netCredit = shortPrice - longPrice;
  if (netCredit <= 0) {
    return { reason: 'Net credit at these strikes is zero or negative — not worth selling.' };
  }

  const width = params.wingWidth;
  const maxLossPerUnit = width - netCredit;
  const breakeven = isPut ? short.quote.strike - netCredit : short.quote.strike + netCredit;

  const legQuotes: Array<{ side: CreditSpreadLeg['side']; q: EnrichedQuote; dir: 1 | -1; price: number }> = [
    { side: 'SELL', q: short, dir: -1, price: shortPrice },
    { side: 'BUY', q: long, dir: 1, price: longPrice },
  ];
  const legs = legQuotes.map(({ side, q, price }): CreditSpreadLeg => ({
    side, right: q.quote.right, strike: q.quote.strike, price, iv: q.iv, delta: q.greeks.delta,
  })) as [CreditSpreadLeg, CreditSpreadLeg];

  const greeksIn = legQuotes.map(({ dir, q }) => ({ dir, g: q.greeks }));
  const netGreeks: Greeks = {
    delta: netOf(greeksIn, 'delta'), gamma: netOf(greeksIn, 'gamma'),
    theta: netOf(greeksIn, 'theta'), vega: netOf(greeksIn, 'vega'), rho: netOf(greeksIn, 'rho'),
  };

  const atmIv = atmIvOf(slice);
  let pop: number | null = null;
  if (atmIv !== null && slice.timeToExpiry > 0) {
    const sqrtT = Math.sqrt(slice.timeToExpiry);
    const d2 = (Math.log(slice.forward / breakeven) - 0.5 * atmIv * atmIv * slice.timeToExpiry) / (atmIv * sqrtT);
    // Bull put spread profits above breakeven: P(S_T > breakeven) = N(d2).
    // Bear call spread profits below it: P(S_T < breakeven) = 1 - N(d2).
    pop = isPut ? normCdf(d2) : 1 - normCdf(d2);
  }

  return {
    strategy,
    legs,
    netCredit,
    maxProfit: netCredit * params.lotSize,
    maxLoss: maxLossPerUnit * params.lotSize,
    breakeven,
    netGreeks,
    pop,
    forward: slice.forward,
    forwardSource: slice.forwardSource,
    atmIv,
    dte: Math.round(slice.timeToExpiry * 365),
  };
}

export function isCreditSpreadFailure(
  r: CreditSpreadResult | CreditSpreadFailure,
): r is CreditSpreadFailure {
  return 'reason' in r;
}
