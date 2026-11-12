/**
 * Vertical credit-spread construction and executable pricing.
 *
 *   BULLISH → BULL PUT  credit spread: SELL put K_s, BUY put K_l < K_s
 *   BEARISH → BEAR CALL credit spread: SELL call K_s, BUY call K_l > K_s
 *
 * Executable prices only — never last traded price:
 *   open:  sell short at its BID, buy long at its ASK (each less/plus slippage)
 *   close: buy short at its ASK, sell long at its BID
 *
 * Gross max loss = (width − credit) × qty. The risk figure used for decisions
 * adds the configured round-trip cost estimate on top.
 */
import { atmStrike, mid, type ChainSnapshot, type OptionQuote, type Right } from './chain.ts';
import { spreadEntryDetailed, spreadRoundTripDetailed, modelRoundTripCost, type CostBreakdown } from './costs.ts';
import type { PulseConfig } from './config.ts';

export type SpreadKind = 'BULL_PUT' | 'BEAR_CALL';

export interface CandidateCheck { key: string; label: string; pass: boolean; detail: string }

export interface SpreadLegQuote {
  strike: number;
  right: Right;
  tradingsymbol: string;
  bid: number | null;
  ask: number | null;
  bidQty: number;
  askQty: number;
  spreadPts: number | null;
  ageMs: number | null;
}

export interface SpreadCandidate {
  id: string;
  kind: SpreadKind;
  underlying: 'NIFTY';
  expiry: string;
  short: SpreadLegQuote;
  long: SpreadLegQuote;
  widthPts: number;
  lots: number;
  lotSize: number;
  qty: number;
  /** Executable entry prices including slippage. */
  shortEntry: number | null;
  longEntry: number | null;
  /** Gross credit per unit (points). */
  creditPts: number | null;
  grossCredit: number | null;
  /** Detailed round-trip estimate, assuming exit at today's opposite side. */
  costsDetailed: CostBreakdown | null;
  entryCostsDetailed: CostBreakdown | null;
  /** Cost the strategy uses (FLAT or DETAILED per config). */
  costModelUsed: 'FLAT' | 'DETAILED';
  roundTripCost: number | null;
  netCredit: number | null;
  maxGain: number | null;
  /** Gross max loss = (width − credit) × qty. */
  grossMaxLoss: number | null;
  /** Gross max loss + round-trip cost — the risk figure. */
  maxLoss: number | null;
  breakeven: number | null;
  /** Paper estimate — NOT broker-confirmed margin. */
  estMargin: number | null;
  checks: CandidateCheck[];
  /** All liquidity/pricing checks pass (risk is evaluated separately). */
  eligible: boolean;
  rejectReason: string | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function legQuote(q: OptionQuote | undefined, strike: number, right: Right, now: number): SpreadLegQuote {
  return {
    strike, right,
    tradingsymbol: q?.tradingsymbol ?? `NIFTY ${strike} ${right}`,
    bid: q?.bid ?? null, ask: q?.ask ?? null, bidQty: q?.bidQty ?? 0, askQty: q?.askQty ?? 0,
    spreadPts: q && q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0 ? r2(q.ask - q.bid) : null,
    ageMs: q?.ts != null ? Math.max(0, now - q.ts) : null,
  };
}

export function kindFor(direction: 'BULLISH' | 'BEARISH'): SpreadKind {
  return direction === 'BULLISH' ? 'BULL_PUT' : 'BEAR_CALL';
}

/** Price one specific spread. Pure; used by both the engine and the Spread Builder. */
export function priceSpread(chain: ChainSnapshot, kind: SpreadKind, shortStrike: number, widthSteps: number, c: PulseConfig): SpreadCandidate {
  const right: Right = kind === 'BULL_PUT' ? 'PE' : 'CE';
  const widthPts = widthSteps * chain.strikeStep;
  const longStrike = kind === 'BULL_PUT' ? shortStrike - widthPts : shortStrike + widthPts;
  const now = chain.at;
  const sq = chain.quote(shortStrike, right);
  const lq = chain.quote(longStrike, right);
  const short = legQuote(sq, shortStrike, right, now);
  const long = legQuote(lq, longStrike, right, now);
  const qty = c.lots * chain.lotSize;
  const checks: CandidateCheck[] = [];
  const add = (key: string, label: string, pass: boolean, detail: string) => checks.push({ key, label, pass, detail });

  add('SHORT_PRESENT', 'Short leg listed', !!sq, sq ? sq.tradingsymbol : `no ${shortStrike} ${right} in instrument master`);
  add('LONG_PRESENT', 'Protective long listed', !!lq, lq ? lq.tradingsymbol : `no ${longStrike} ${right} in instrument master`);
  if (sq && lq) {
    add('SAME_EXPIRY', 'Same expiry', sq.expiry === lq.expiry, `${sq.expiry} / ${lq.expiry}`);
    add('SAME_LOT', 'Same quantity', sq.lotSize === lq.lotSize, `${qty} each`);
  }
  for (const [name, leg, q] of [['Short', short, sq], ['Long', long, lq]] as const) {
    if (!q) continue;
    const fresh = q.ts != null && now - q.ts <= c.quoteFreshnessMs;
    add(`${name.toUpperCase()}_FRESH`, `${name} quote fresh`, fresh, q.ts == null ? 'no quote received' : `${((now - q.ts) / 1000).toFixed(1)}s old (max ${(c.quoteFreshnessMs / 1000).toFixed(1)}s)`);
    const twoSided = (q.bid ?? 0) > 0 && (q.ask ?? 0) > 0;
    add(`${name.toUpperCase()}_TWO_SIDED`, `${name} bid & ask present`, twoSided, twoSided ? `${q.bid!.toFixed(2)} / ${q.ask!.toFixed(2)}` : 'one-sided or empty book');
    if (twoSided) {
      const m = mid(q)!;
      const pct = (leg.spreadPts! / m) * 100;
      const ok = leg.spreadPts! <= c.maxBidAskPts && pct <= c.maxBidAskPct;
      add(`${name.toUpperCase()}_SPREAD`, `${name} bid/ask spread`, ok, `${leg.spreadPts!.toFixed(2)} pts · ${pct.toFixed(1)}% (max ${c.maxBidAskPts} pts / ${c.maxBidAskPct}%)`);
      const depth = name === 'Short' ? q.bidQty : q.askQty;
      const need = qty * c.minDepthMultiple;
      add(`${name.toUpperCase()}_DEPTH`, `${name} top-of-book depth`, depth >= need, `${depth} vs ${need} needed (${name === 'Short' ? 'bid' : 'ask'})`);
    }
  }

  let shortEntry: number | null = null, longEntry: number | null = null, creditPts: number | null = null;
  let costsDetailed: CostBreakdown | null = null, entryCostsDetailed: CostBreakdown | null = null;
  let roundTripCost: number | null = null, grossCredit: number | null = null, netCredit: number | null = null;
  let maxGain: number | null = null, grossMaxLoss: number | null = null, maxLoss: number | null = null;
  let breakeven: number | null = null, estMargin: number | null = null;

  if (sq && lq && (sq.bid ?? 0) > 0 && (lq.ask ?? 0) > 0) {
    shortEntry = r2(Math.max(0.05, sq.bid! - c.slippagePtsPerLeg));
    longEntry = r2(lq.ask! + c.slippagePtsPerLeg);
    creditPts = r2(shortEntry - longEntry);
    const pos = creditPts > 0;
    add('CREDIT_POSITIVE', 'Net credit positive', pos, `${creditPts.toFixed(2)} pts after slippage`);
    if (pos) add('MIN_CREDIT', 'Minimum credit', creditPts >= c.minCreditPts, `${creditPts.toFixed(2)} vs ${c.minCreditPts} pts`);
    add('CREDIT_BELOW_WIDTH', 'Credit below width', creditPts < widthPts, `${creditPts.toFixed(2)} vs width ${widthPts}`);
    entryCostsDetailed = spreadEntryDetailed({ shortEntry, longEntry, qty });
    costsDetailed = spreadRoundTripDetailed({
      shortEntry, longEntry,
      shortExit: (sq.ask ?? shortEntry) + c.slippagePtsPerLeg,
      longExit: Math.max(0.05, (lq.bid ?? longEntry) - c.slippagePtsPerLeg),
      qty,
    });
    roundTripCost = r2(modelRoundTripCost(c.costModel, c.roundTripCostEstimate, costsDetailed));
    grossCredit = r2(creditPts * qty);
    netCredit = r2(grossCredit - roundTripCost);
    maxGain = netCredit;
    grossMaxLoss = r2((widthPts - creditPts) * qty);
    maxLoss = r2(grossMaxLoss + roundTripCost);
    breakeven = r2(kind === 'BULL_PUT' ? shortStrike - creditPts : shortStrike + creditPts);
    estMargin = r2(widthPts * qty);
  }

  const failed = checks.find((k) => !k.pass);
  return {
    id: `${kind}:${chain.expiry}:${shortStrike}/${longStrike}`,
    kind, underlying: 'NIFTY', expiry: chain.expiry, short, long, widthPts,
    lots: c.lots, lotSize: chain.lotSize, qty,
    shortEntry, longEntry, creditPts, grossCredit, costsDetailed, entryCostsDetailed,
    costModelUsed: c.costModel, roundTripCost, netCredit, maxGain, grossMaxLoss, maxLoss, breakeven, estMargin,
    checks, eligible: !failed && creditPts != null, rejectReason: failed ? `${failed.label}: ${failed.detail}` : creditPts == null ? 'Option spread unavailable' : null,
  };
}

/**
 * All candidate spreads for a direction, per the config's search grid.
 * Ordered: eligible first, then by lowest max loss per rupee of credit.
 */
export function buildCandidates(chain: ChainSnapshot, direction: 'BULLISH' | 'BEARISH', c: PulseConfig): SpreadCandidate[] {
  const kind = kindFor(direction);
  const atm = atmStrike(chain.spot, chain.strikeStep);
  const out: SpreadCandidate[] = [];
  for (let s = c.shortOtmStepsMin; s <= c.shortOtmStepsMax; s++) {
    const shortStrike = kind === 'BULL_PUT' ? atm - s * chain.strikeStep : atm + s * chain.strikeStep;
    for (let w = c.widthStepsMin; w <= c.widthStepsMax; w++) out.push(priceSpread(chain, kind, shortStrike, w, c));
  }
  const score = (x: SpreadCandidate) => (x.maxLoss != null && x.grossCredit ? x.maxLoss / x.grossCredit : Infinity);
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || score(a) - score(b));
}

/** Expiry payoff (₹, after the round-trip cost) at an underlying price. */
export function expiryPayoff(cand: Pick<SpreadCandidate, 'kind' | 'short' | 'long' | 'creditPts' | 'qty' | 'roundTripCost'>, underlying: number): number {
  const credit = cand.creditPts ?? 0;
  const intrinsic = (k: number) => (cand.kind === 'BULL_PUT' ? Math.max(k - underlying, 0) : Math.max(underlying - k, 0));
  const perUnit = credit - intrinsic(cand.short.strike) + intrinsic(cand.long.strike);
  return r2(perUnit * cand.qty - (cand.roundTripCost ?? 0));
}
