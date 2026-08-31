/**
 * Phase 2 — Greek calculation engine.
 *
 * Black-76: European options on a forward/futures price F.
 *
 *   d1 = [ln(F/K) + 0.5 s^2 T] / (s sqrt(T))
 *   d2 = d1 - s sqrt(T)
 *   call = e^{-rT} [F N(d1) - K N(d2)]
 *   put  = e^{-rT} [K N(-d2) - F N(-d1)]
 *
 * This is the right model for NIFTY options: they are quoted against the
 * forward, not the cash index, and using spot with a dividend yield instead
 * introduces a systematic skew error at the wings.
 *
 * Known limitations, stated rather than hidden:
 *  - Assumes lognormal terminal distribution. Index returns are fat-tailed
 *    and gap. Every probability produced downstream inherits this error and
 *    UNDERSTATES tail risk. Do not present these as true probabilities.
 *  - Assumes constant vol to expiry. The per-strike IV we solve for is a
 *    quoting convention, not a forecast.
 *  - Theta is the calendar-time derivative. It does not know about weekends
 *    or holidays; realised weekend decay differs.
 */

import { normCdf, normPdf } from '../math/normal.ts';
import type { Greeks, Right } from '../types.ts';

/** Below this time-to-expiry (years) we treat the option as expiring now. */
export const MIN_T = 1e-8;
/** Below this vol we treat the option as deterministic. */
export const MIN_VOL = 1e-8;

export interface Black76Input {
  /** Forward/futures price. */
  forward: number;
  strike: number;
  /** Time to expiry in years, ACT/365. */
  timeToExpiry: number;
  /** Volatility, decimal (0.14 = 14%). */
  vol: number;
  /** Continuously compounded risk-free rate, decimal. */
  rate: number;
  right: Right;
}

export interface PricedOption extends Greeks {
  price: number;
  d1: number | null;
  d2: number | null;
  /** True when T or vol collapsed and the result is the intrinsic payoff. */
  degenerate: boolean;
}

function d1d2(F: number, K: number, T: number, s: number) {
  const sqrtT = Math.sqrt(T);
  const v = s * sqrtT;
  const d1 = (Math.log(F / K) + 0.5 * s * s * T) / v;
  return { d1, d2: d1 - v, sqrtT, v };
}

/** Intrinsic value on the forward, discounted. Used at T=0 or vol=0. */
function degenerateValue(input: Black76Input): PricedOption {
  const { forward: F, strike: K, rate: r, timeToExpiry: T, right } = input;
  const df = Math.exp(-r * Math.max(T, 0));
  const intrinsic = right === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const itm = intrinsic > 0;

  return {
    price: df * intrinsic,
    // Delta is a step function at expiry. Exactly-ATM is undefined; we return
    // the one-sided value rather than pretending 0.5 is meaningful.
    delta: right === 'CE' ? (itm ? df : 0) : itm ? -df : 0,
    // Gamma is a Dirac delta at K. Reporting Infinity would poison every net
    // Greek downstream, so we return 0 and rely on the 0-DTE gamma guard in
    // the risk engine instead of a number.
    gamma: 0,
    theta: 0,
    vega: 0,
    rho: 0,
    d1: null,
    d2: null,
    degenerate: true,
  };
}

/** Price + all analytic Greeks in one pass (shares d1/d2/pdf work). */
export function black76(input: Black76Input): PricedOption {
  const { forward: F, strike: K, timeToExpiry: T, vol: s, rate: r, right } = input;

  if (!(F > 0) || !(K > 0)) {
    throw new RangeError(
      `black76: forward and strike must be positive (F=${F}, K=${K})`,
    );
  }
  if (T <= MIN_T || s <= MIN_VOL) return degenerateValue(input);

  const { d1, d2, sqrtT } = d1d2(F, K, T, s);
  const df = Math.exp(-r * T);
  const pdf1 = normPdf(d1);

  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const Nmd1 = 1 - Nd1;
  const Nmd2 = 1 - Nd2;

  const price = right === 'CE' ? df * (F * Nd1 - K * Nd2) : df * (K * Nmd2 - F * Nmd1);

  const delta = right === 'CE' ? df * Nd1 : -df * Nmd1;
  const gamma = (df * pdf1) / (F * s * sqrtT);
  // Vega per 1.00 of vol. Identical for calls and puts.
  const vega = df * F * pdf1 * sqrtT;

  // theta = -dPrice/dT. Derivation:
  //   dc/dT = -r*c + e^{-rT} F n(d1) s / (2 sqrt(T))
  // so theta = r*c - e^{-rT} F n(d1) s / (2 sqrt(T)).
  const decayTerm = (df * F * pdf1 * s) / (2 * sqrtT);
  const thetaPerYear =
    right === 'CE'
      ? r * df * (F * Nd1 - K * Nd2) - decayTerm
      : r * df * (K * Nmd2 - F * Nmd1) - decayTerm;

  // Rho under Black-76 is simply -T * price (the forward is unaffected by r).
  const rho = -T * price;

  return {
    price,
    delta,
    gamma,
    // Reported per calendar day, which is how traders read it.
    theta: thetaPerYear / 365,
    vega,
    rho,
    d1,
    d2,
    degenerate: false,
  };
}

/* ------------------------------------------------------------------ */
/* Implied volatility                                                  */
/* ------------------------------------------------------------------ */

export type IvFailure =
  | 'BELOW_INTRINSIC'
  | 'ABOVE_MAX'
  | 'NON_POSITIVE_PRICE'
  | 'EXPIRED'
  | 'ILL_CONDITIONED'
  | 'NO_CONVERGENCE';

export interface IvResult {
  vol: number | null;
  iterations: number;
  failure?: IvFailure;
  /** Absolute price error at the returned vol. */
  residual?: number;
  /** Vega at the solution. Near zero means the IV is not identifiable. */
  vega?: number;
}

/**
 * Below this vega (price change per 1.00 of vol) the option price carries no
 * information about volatility: deep-ITM contracts trading at intrinsic, and
 * far wings on 0-1 DTE. Returning a number there would be inventing an IV,
 * so the solver reports ILL_CONDITIONED instead.
 *
 * Expressed in price units. 1e-6 means a full 100-vol-point move would not
 * shift the price by even 1e-6 index points.
 */
export const DEFAULT_MIN_VEGA = 1e-6;

export const IV_LOWER = 1e-4;
export const IV_UPPER = 5.0;

/**
 * Solve for implied vol from a market price.
 *
 * Newton-Raphson seeded with the Brenner-Subrahmanyam ATM approximation, with
 * a bisection fallback. Newton alone is unreliable on deep-OTM weeklies where
 * vega collapses towards zero; the bracket guarantees termination.
 *
 * Arbitrage bounds are checked first. A price below intrinsic has NO implied
 * vol, and returning a fitted number for it would be fabricating data — this
 * happens constantly in bhavcopy settlement prices for illiquid wings.
 */
export function impliedVol(
  targetPrice: number,
  input: Omit<Black76Input, 'vol'>,
  opts: { tolerance?: number; maxIterations?: number; minVega?: number } = {},
): IvResult {
  const tol = opts.tolerance ?? 1e-8;
  const maxIter = opts.maxIterations ?? 100;
  const minVega = opts.minVega ?? DEFAULT_MIN_VEGA;
  const { forward: F, strike: K, timeToExpiry: T, rate: r, right } = input;

  if (!(targetPrice > 0)) return { vol: null, iterations: 0, failure: 'NON_POSITIVE_PRICE' };
  if (T <= MIN_T) return { vol: null, iterations: 0, failure: 'EXPIRED' };

  const df = Math.exp(-r * T);
  const intrinsic = df * (right === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0));
  // Upper bound: a call cannot exceed df*F, a put cannot exceed df*K.
  const upperBound = df * (right === 'CE' ? F : K);

  if (targetPrice < intrinsic - tol) {
    return { vol: null, iterations: 0, failure: 'BELOW_INTRINSIC' };
  }
  if (targetPrice >= upperBound) {
    return { vol: null, iterations: 0, failure: 'ABOVE_MAX' };
  }

  const priceAt = (v: number) => black76({ ...input, vol: v }).price;

  /** Accept a root only if the price is actually sensitive to vol there. */
  const finish = (v: number, iterations: number, residual: number): IvResult => {
    const vega = black76({ ...input, vol: v }).vega ?? 0;
    if (vega < minVega) {
      return { vol: null, iterations, failure: 'ILL_CONDITIONED', residual, vega };
    }
    return { vol: v, iterations, residual, vega };
  };

  // Bracket the root first so the fallback is always available.
  let lo = IV_LOWER;
  let hi = IV_UPPER;
  if (priceAt(hi) < targetPrice) {
    return { vol: null, iterations: 0, failure: 'ABOVE_MAX' };
  }

  // Brenner-Subrahmanyam seed: sigma ~ sqrt(2pi/T) * price / F.
  let v = Math.sqrt((2 * Math.PI) / T) * (targetPrice / F);
  if (!Number.isFinite(v) || v <= IV_LOWER || v >= IV_UPPER) v = 0.2;

  let iterations = 0;

  for (; iterations < maxIter; iterations++) {
    const priced = black76({ ...input, vol: v });
    const diff = priced.price - targetPrice;

    if (Math.abs(diff) < tol) return finish(v, iterations, Math.abs(diff));

    // Maintain the bracket using every evaluation we make.
    if (diff > 0) hi = Math.min(hi, v);
    else lo = Math.max(lo, v);

    const vega = priced.vega ?? 0;
    let next = vega > 1e-10 ? v - diff / vega : NaN;

    // Newton stepped outside the bracket or blew up -> bisect instead.
    if (!Number.isFinite(next) || next <= lo || next >= hi) {
      next = 0.5 * (lo + hi);
    }

    if (Math.abs(next - v) < 1e-12) {
      const residual = Math.abs(priceAt(next) - targetPrice);
      return residual < 1e-4
        ? finish(next, iterations, residual)
        : { vol: null, iterations, failure: 'NO_CONVERGENCE', residual };
    }
    v = next;
  }

  const residual = Math.abs(priceAt(v) - targetPrice);
  return residual < 1e-4
    ? finish(v, iterations, residual)
    : { vol: null, iterations, failure: 'NO_CONVERGENCE', residual };
}

/* ------------------------------------------------------------------ */
/* Forward derivation                                                  */
/* ------------------------------------------------------------------ */

export interface ForwardEstimate {
  forward: number;
  source: 'futures' | 'parity' | 'spot-carry';
  /** Strike used for the parity solve, when source='parity'. */
  strikeUsed?: number;
}

/**
 * Synthetic forward from put-call parity: F = K + e^{rT}(C - P).
 *
 * This matters more in India than most places. Using the cash index as the
 * underlying prices every call too cheap and every put too dear by the whole
 * cost of carry, which shows up as a fake skew and pushes strike selection
 * systematically in one direction. Where a real futures price exists, use it;
 * otherwise solve parity at the most liquid (tightest-spread) strike.
 */
export function forwardFromParity(
  pairs: Array<{ strike: number; callMid: number; putMid: number; weight: number }>,
  timeToExpiry: number,
  rate: number,
): ForwardEstimate | null {
  const usable = pairs.filter(
    (p) => Number.isFinite(p.callMid) && Number.isFinite(p.putMid) && p.weight > 0,
  );
  if (usable.length === 0) return null;

  // Highest weight = tightest relative spread, set by the caller.
  const best = usable.reduce((a, b) => (b.weight > a.weight ? b : a));
  const carry = Math.exp(rate * timeToExpiry);
  const forward = best.strike + carry * (best.callMid - best.putMid);

  if (!(forward > 0)) return null;
  return { forward, source: 'parity', strikeUsed: best.strike };
}
