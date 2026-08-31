/**
 * Phase 1 + 2 join point.
 *
 *   OptionChain -> enrichChain() -> EnrichedChain
 *
 * Responsibilities, in order:
 *   1. time to expiry
 *   2. mark price + spread quality
 *   3. forward (futures > put-call parity > spot with carry)
 *   4. implied vol (provider's, else solved)
 *   5. model Greeks, kept separate from observed Greeks
 *   6. validation issues attached per quote and per chain
 *
 * The validator never repairs data. It labels it. A fatal issue removes the
 * quote from selection; it does not get silently replaced with a guess.
 */

import { black76, forwardFromParity, impliedVol, MIN_T } from './pricing/black76.ts';
import { DEFAULT_CONFIG, type QuantConfig } from './config.ts';
import {
  EMPTY_GREEKS,
  type DataIssue,
  type EnrichedChain,
  type EnrichedQuote,
  type EnrichedSlice,
  type Greeks,
  type OptionChain,
  type OptionQuote,
  type ValueSource,
} from './types.ts';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** ACT/365 year fraction, floored at zero. */
export function yearFraction(from: number, to: number): number {
  return Math.max(0, (to - from) / MS_PER_YEAR);
}

interface MarkResult {
  mid: number | null;
  spread: number | null;
  spreadPct: number | null;
  markPrice: number | null;
  markPriceSource: EnrichedQuote['markPriceSource'];
  issues: DataIssue[];
}

function markPrice(q: OptionQuote, cfg: QuantConfig): MarkResult {
  const issues: DataIssue[] = [];
  const ref = { right: q.right, strike: q.strike, expiry: q.expiry };

  let mid: number | null = null;
  let spread: number | null = null;
  let spreadPct: number | null = null;

  const hasBid = q.bid !== null && q.bid > 0;
  const hasAsk = q.ask !== null && q.ask > 0;

  if (q.bid !== null && q.bid < 0) {
    issues.push({ code: 'NON_POSITIVE_PRICE', severity: 'error', message: 'negative bid', ref, value: q.bid });
  }
  if (hasBid && hasAsk) {
    if (q.ask! < q.bid!) {
      issues.push({
        code: 'CROSSED_QUOTE',
        severity: 'fatal',
        message: `ask ${q.ask} below bid ${q.bid}`,
        ref,
      });
    } else {
      mid = (q.bid! + q.ask!) / 2;
      spread = q.ask! - q.bid!;
      spreadPct = mid > 0 ? spread / mid : null;

      if (spreadPct !== null && spreadPct > cfg.dataQuality.fatalSpreadPct) {
        issues.push({
          code: 'WIDE_SPREAD',
          severity: 'fatal',
          message: `spread ${(spreadPct * 100).toFixed(1)}% of mid — no realistic fill`,
          ref,
          value: spreadPct,
        });
      } else if (spreadPct !== null && spreadPct > cfg.dataQuality.maxSpreadPct) {
        issues.push({
          code: 'WIDE_SPREAD',
          severity: 'warn',
          message: `spread ${(spreadPct * 100).toFixed(1)}% of mid`,
          ref,
          value: spreadPct,
        });
      }
    }
  }

  let chosen: number | null = null;
  let source: EnrichedQuote['markPriceSource'] = 'none';
  for (const pref of cfg.pricing.markPricePreference) {
    if (pref === 'mid' && mid !== null && mid > 0) {
      chosen = mid;
      source = 'mid';
      break;
    }
    if (pref === 'settle' && q.settle !== null && q.settle > 0) {
      chosen = q.settle;
      source = 'settle';
      break;
    }
    if (pref === 'last' && q.last !== null && q.last > 0) {
      chosen = q.last;
      source = 'last';
      break;
    }
  }

  if (chosen === null) {
    issues.push({
      code: 'MISSING_PRICE',
      severity: 'fatal',
      message: 'no usable price (bid/ask, settle or last)',
      ref,
    });
  }

  if (q.openInterest !== null && q.openInterest <= 0) {
    issues.push({ code: 'ZERO_OPEN_INTEREST', severity: 'warn', message: 'no open interest', ref });
  }
  if (q.volume !== null && q.volume <= 0) {
    issues.push({ code: 'ZERO_VOLUME', severity: 'warn', message: 'no traded volume', ref });
  }

  return { mid, spread, spreadPct, markPrice: chosen, markPriceSource: source, issues };
}

function greeksComplete(g: Greeks): boolean {
  return g.delta !== null && g.gamma !== null && g.theta !== null && g.vega !== null;
}

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale;
}

function resolveForward(
  chain: OptionChain,
  quotes: OptionQuote[],
  T: number,
  cfg: QuantConfig,
): { forward: number; source: EnrichedSlice['forwardSource']; issues: DataIssue[] } | null {
  const issues: DataIssue[] = [];
  const rate = chain.context.riskFreeRate ?? cfg.pricing.defaultRiskFreeRate;

  if (chain.context.futures !== null && chain.context.futures > 0) {
    return { forward: chain.context.futures, source: 'futures', issues };
  }

  // Put-call parity across strikes, weighted by quote tightness.
  const calls = new Map<number, OptionQuote>();
  const puts = new Map<number, OptionQuote>();
  for (const q of quotes) (q.right === 'CE' ? calls : puts).set(q.strike, q);

  const pairs: Array<{ strike: number; callMid: number; putMid: number; weight: number }> = [];
  for (const [strike, c] of calls) {
    const p = puts.get(strike);
    if (!p) continue;
    if (c.bid === null || c.ask === null || p.bid === null || p.ask === null) continue;
    if (c.ask < c.bid || p.ask < p.bid) continue;
    const cm = (c.bid + c.ask) / 2;
    const pm = (p.bid + p.ask) / 2;
    if (!(cm > 0) || !(pm > 0)) continue;
    // Tightest combined relative spread wins; near-ATM pairs naturally do.
    const rel = (c.ask - c.bid) / cm + (p.ask - p.bid) / pm;
    pairs.push({ strike, callMid: cm, putMid: pm, weight: 1 / (rel + 1e-6) });
  }

  const parity = forwardFromParity(pairs, T, rate);
  if (parity) return { forward: parity.forward, source: 'parity', issues };

  if (chain.context.spot !== null && chain.context.spot > 0) {
    const carry = Math.exp((rate - chain.context.dividendYield) * T);
    issues.push({
      code: 'NO_FORWARD_AVAILABLE',
      severity: 'warn',
      message:
        'no futures price and parity unsolvable; using spot with assumed carry — ' +
        'skew and strike selection will be biased',
    });
    return { forward: chain.context.spot * carry, source: 'spot-carry', issues };
  }

  issues.push({
    code: 'MISSING_UNDERLYING_PRICE',
    severity: 'fatal',
    message: 'no futures, no parity pair and no spot — cannot price this expiry',
  });
  return null;
}

export function enrichChain(
  chain: OptionChain,
  cfg: QuantConfig = DEFAULT_CONFIG,
): EnrichedChain {
  const chainIssues: DataIssue[] = [];
  const rate = chain.context.riskFreeRate ?? cfg.pricing.defaultRiskFreeRate;
  const now = chain.context.valuationTime;

  if (!(chain.contract.lotSize > 0) || !Number.isInteger(chain.contract.lotSize)) {
    chainIssues.push({
      code: 'INVALID_LOT_SIZE',
      severity: 'fatal',
      message: `lot size must be a positive integer, got ${chain.contract.lotSize}`,
      value: chain.contract.lotSize,
    });
  }

  const slices: EnrichedSlice[] = [];

  for (const slice of chain.slices) {
    const T = yearFraction(now, slice.expiry);
    const sliceIssues: DataIssue[] = [];

    if (slice.expiry < now) {
      chainIssues.push({
        code: 'EXPIRY_IN_PAST',
        severity: 'fatal',
        message: `expiry ${new Date(slice.expiry).toISOString()} is before valuation time`,
      });
    }

    const fwd = resolveForward(chain, slice.quotes, T, cfg);
    if (!fwd) {
      chainIssues.push(...(sliceIssues.length ? sliceIssues : []));
      chainIssues.push({
        code: 'MISSING_UNDERLYING_PRICE',
        severity: 'fatal',
        message: `expiry ${new Date(slice.expiry).toISOString()} skipped: no forward`,
      });
      continue;
    }
    chainIssues.push(...fwd.issues);

    const seen = new Set<string>();
    const enriched: EnrichedQuote[] = [];

    for (const q of slice.quotes) {
      const ref = { right: q.right, strike: q.strike, expiry: q.expiry };
      const issues: DataIssue[] = [];

      const key = `${q.right}:${q.strike}`;
      if (seen.has(key)) {
        issues.push({ code: 'DUPLICATE_QUOTE', severity: 'error', message: 'duplicate contract', ref });
      }
      seen.add(key);

      if (chain.contract.strikeStep > 0 && q.strike % chain.contract.strikeStep !== 0) {
        issues.push({
          code: 'OFF_GRID_STRIKE',
          severity: 'warn',
          message: `strike not on the ${chain.contract.strikeStep}-point grid`,
          ref,
          value: q.strike,
        });
      }

      if (now - q.asOf > cfg.dataQuality.maxQuoteAgeMs && chain.source.kind === 'live') {
        issues.push({
          code: 'STALE_QUOTE',
          severity: 'warn',
          message: `quote is ${Math.round((now - q.asOf) / 1000)}s old`,
          ref,
          value: q.asOf,
        });
      }

      const mk = markPrice(q, cfg);
      issues.push(...mk.issues);

      // ---- implied volatility -------------------------------------
      let iv: number | null = null;
      let ivSource: ValueSource = 'unavailable';

      if (q.observedIv !== null) {
        iv = q.observedIv;
        ivSource = 'observed';
      } else if (mk.markPrice !== null && T > MIN_T) {
        const solved = impliedVol(
          mk.markPrice,
          { forward: fwd.forward, strike: q.strike, timeToExpiry: T, rate, right: q.right },
          { minVega: cfg.dataQuality.minVegaForIv },
        );
        if (solved.vol !== null) {
          iv = solved.vol;
          ivSource = 'model';
        } else {
          const code =
            solved.failure === 'BELOW_INTRINSIC' || solved.failure === 'ABOVE_MAX'
              ? 'ARBITRAGE_BOUND_VIOLATION'
              : solved.failure === 'ILL_CONDITIONED'
                ? 'IV_ILL_CONDITIONED'
                : 'IV_UNSOLVABLE';
          issues.push({
            code,
            severity: code === 'IV_ILL_CONDITIONED' ? 'warn' : 'error',
            message:
              code === 'IV_ILL_CONDITIONED'
                ? 'price is insensitive to volatility here (trading at intrinsic) — no implied vol exists'
                : `implied vol not solvable (${solved.failure})`,
            ref,
            value: mk.markPrice,
          });
        }
      } else if (T <= MIN_T) {
        issues.push({ code: 'MISSING_IV', severity: 'warn', message: 'at expiry: no implied vol', ref });
      }

      if (
        iv !== null &&
        (iv < cfg.dataQuality.minPlausibleIv || iv > cfg.dataQuality.maxPlausibleIv)
      ) {
        issues.push({
          code: 'IMPLAUSIBLE_IV',
          severity: 'error',
          message: `IV ${(iv * 100).toFixed(1)}% outside plausible range`,
          ref,
          value: iv,
        });
      }

      // ---- Greeks --------------------------------------------------
      let modelGreeks: Greeks = { ...EMPTY_GREEKS };
      if (iv !== null && cfg.pricing.alwaysComputeModelGreeks) {
        const priced = black76({
          forward: fwd.forward,
          strike: q.strike,
          timeToExpiry: T,
          vol: iv,
          rate,
          right: q.right,
        });
        modelGreeks = {
          delta: priced.delta,
          gamma: priced.gamma,
          theta: priced.theta,
          vega: priced.vega,
          rho: priced.rho,
        };
      }

      const observed = q.observedGreeks;
      const hasObserved = greeksComplete(observed);
      const hasModel = greeksComplete(modelGreeks);

      let greeks: Greeks = { ...EMPTY_GREEKS };
      let greeksSource: ValueSource = 'unavailable';

      if (cfg.pricing.preferredGreekSource === 'observed' && hasObserved) {
        greeks = observed;
        greeksSource = 'observed';
      } else if (hasModel) {
        greeks = modelGreeks;
        greeksSource = 'model';
      } else if (hasObserved) {
        greeks = observed;
        greeksSource = 'observed';
      } else {
        issues.push({
          code: 'MISSING_GREEKS',
          severity: 'error',
          message: 'no observed Greeks and none computable',
          ref,
        });
      }

      if (hasObserved && hasModel) {
        const dd = relDiff(observed.delta!, modelGreeks.delta!);
        if (dd > cfg.dataQuality.greekDivergenceTolerance) {
          issues.push({
            code: 'OBSERVED_MODEL_GREEK_DIVERGENCE',
            severity: 'warn',
            message:
              `provider delta ${observed.delta!.toFixed(4)} vs model ${modelGreeks.delta!.toFixed(4)} ` +
              `(${(dd * 100).toFixed(0)}% apart) — likely a spot-vs-forward difference`,
            ref,
            value: dd,
          });
        }
      }

      for (const [name, v] of Object.entries(greeks)) {
        if (v === null) continue;
        const bad =
          (name === 'delta' && Math.abs(v) > 1.0001) ||
          (name === 'gamma' && v < 0) ||
          (name === 'vega' && v < 0);
        if (bad) {
          issues.push({
            code: 'IMPLAUSIBLE_GREEK',
            severity: 'error',
            message: `${name} = ${v} is outside the possible range for a single option`,
            ref,
            value: v,
          });
        }
      }

      enriched.push({
        quote: q,
        mid: mk.mid,
        spread: mk.spread,
        spreadPct: mk.spreadPct,
        markPrice: mk.markPrice,
        markPriceSource: mk.markPriceSource,
        timeToExpiry: T,
        iv,
        ivSource,
        greeks,
        greeksSource,
        modelGreeks,
        logMoneyness: Math.log(fwd.forward / q.strike),
        distanceFromForward: fwd.forward - q.strike,
        issues,
      });
    }

    const usableStrikes = new Set(
      enriched.filter((e) => !e.issues.some((i) => i.severity === 'fatal')).map((e) => e.quote.strike),
    );
    if (usableStrikes.size < cfg.dataQuality.minStrikesForSelection) {
      chainIssues.push({
        code: 'SPARSE_CHAIN',
        severity: 'warn',
        message:
          `only ${usableStrikes.size} usable strike(s) for expiry ` +
          `${new Date(slice.expiry).toISOString().slice(0, 10)} — not enough for strike selection`,
        value: usableStrikes.size,
      });
    }

    const atmStrike =
      usableStrikes.size > 0
        ? [...usableStrikes].reduce((a, b) =>
            Math.abs(b - fwd.forward) < Math.abs(a - fwd.forward) ? b : a,
          )
        : null;

    slices.push({
      expiry: slice.expiry,
      timeToExpiry: T,
      forward: fwd.forward,
      forwardSource: fwd.source,
      atmStrike,
      quotes: enriched,
    });
  }

  return {
    contract: chain.contract,
    asOf: chain.asOf,
    context: chain.context,
    source: chain.source,
    slices,
    issues: chainIssues,
  };
}
