/**
 * Phase 1 — Provider adapter layer.
 *
 *   PROVIDER  ->  RawChainPayload  ->  normalise()  ->  OptionChain
 *
 * Nothing downstream may import a provider module. Swapping NSE for a broker
 * feed, or for a historical bhavcopy file, means writing one adapter and
 * changing one registration line.
 */

import type {
  ChainSource,
  ContractSpec,
  EpochMs,
  Greeks,
  OptionChain,
  OptionQuote,
  PricingContext,
  Right,
} from '../types.ts';
import { EMPTY_GREEKS } from '../types.ts';

/** What the app asks a provider for. */
export interface ChainRequest {
  underlyingSymbol: string;
  /** Restrict to these expiries (epoch ms). Empty = all available. */
  expiries?: EpochMs[];
  /** Optional strike window around the forward, in points. */
  strikeWindow?: number;
  /** For historical providers: the session to reconstruct. */
  asOf?: EpochMs;
}

/** Loose shape returned by an adapter before normalisation. */
export interface RawChainPayload {
  source: ChainSource;
  contract: ContractSpec;
  context: Partial<PricingContext> & { valuationTime: EpochMs };
  rows: RawOptionRow[];
}

/**
 * One provider row. Every field is optional and loosely typed because feeds
 * lie: strings where numbers belong, '-' for missing, 0 for absent.
 */
export interface RawOptionRow {
  right: Right | string;
  strike: number | string;
  expiry: EpochMs | string;
  asOf?: EpochMs | string | null;
  bid?: number | string | null;
  ask?: number | string | null;
  last?: number | string | null;
  settle?: number | string | null;
  openInterest?: number | string | null;
  oiChange?: number | string | null;
  volume?: number | string | null;
  iv?: number | string | null;
  delta?: number | string | null;
  gamma?: number | string | null;
  theta?: number | string | null;
  vega?: number | string | null;
  rho?: number | string | null;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly kind: ChainSource['kind'];
  fetchChain(req: ChainRequest): Promise<RawChainPayload>;
}

/* ------------------------------------------------------------------ */
/* Coercion helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Coerce to a finite number or null. Critically, an empty string, '-', 'NA'
 * and null all become null — NOT 0. Treating a missing OI as zero OI would
 * make the liquidity filter reject good strikes and accept dead ones.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '');
    if (t === '' || t === '-' || t === '--' || /^n\/?a$/i.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toEpoch(v: unknown, fallback: EpochMs): EpochMs {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

function toRight(v: unknown): Right | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  if (t === 'CE' || t === 'C' || t === 'CALL') return 'CE';
  if (t === 'PE' || t === 'P' || t === 'PUT') return 'PE';
  return null;
}

/**
 * IV normalisation. Feeds are inconsistent: NSE gives 14.2 meaning 14.2%,
 * some brokers give 0.142. We treat anything above 3.0 as percent-quoted.
 * A genuine 300% vol on an index weekly is not a thing; a mis-scaled IV is.
 */
export function normaliseIv(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  if (n <= 0) return null;
  return n > 3 ? n / 100 : n;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

export interface NormaliseResult {
  chain: OptionChain;
  /** Rows the adapter emitted that could not be normalised at all. */
  rejected: Array<{ row: RawOptionRow; reason: string }>;
}

export function normalise(payload: RawChainPayload): NormaliseResult {
  const valuationTime = payload.context.valuationTime;
  const rejected: NormaliseResult['rejected'] = [];
  const byExpiry = new Map<EpochMs, OptionQuote[]>();

  for (const row of payload.rows) {
    const right = toRight(row.right);
    if (!right) {
      rejected.push({ row, reason: `unrecognised right '${String(row.right)}'` });
      continue;
    }

    const strike = num(row.strike);
    if (strike === null || strike <= 0) {
      rejected.push({ row, reason: `invalid strike '${String(row.strike)}'` });
      continue;
    }

    const expiry = toEpoch(row.expiry, NaN);
    if (!Number.isFinite(expiry)) {
      rejected.push({ row, reason: `invalid expiry '${String(row.expiry)}'` });
      continue;
    }

    const observedGreeks: Greeks = {
      delta: num(row.delta),
      gamma: num(row.gamma),
      theta: num(row.theta),
      vega: num(row.vega),
      rho: num(row.rho),
    };
    const hasAnyGreek = Object.values(observedGreeks).some((g) => g !== null);

    const quote: OptionQuote = {
      symbol: payload.contract.underlyingSymbol,
      right,
      strike,
      expiry,
      asOf: toEpoch(row.asOf, valuationTime),
      bid: num(row.bid),
      ask: num(row.ask),
      last: num(row.last),
      settle: num(row.settle),
      openInterest: num(row.openInterest),
      oiChange: num(row.oiChange),
      volume: num(row.volume),
      observedIv: normaliseIv(row.iv),
      observedGreeks: hasAnyGreek ? observedGreeks : { ...EMPTY_GREEKS },
    };

    const bucket = byExpiry.get(expiry);
    if (bucket) bucket.push(quote);
    else byExpiry.set(expiry, [quote]);
  }

  const context: PricingContext = {
    spot: payload.context.spot ?? null,
    futures: payload.context.futures ?? null,
    riskFreeRate: payload.context.riskFreeRate ?? 0.065,
    dividendYield: payload.context.dividendYield ?? 0,
    valuationTime,
  };

  const slices = [...byExpiry.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([expiry, quotes]) => ({
      expiry,
      quotes: quotes.sort((a, b) =>
        a.strike === b.strike ? a.right.localeCompare(b.right) : a.strike - b.strike,
      ),
    }));

  return {
    chain: {
      contract: payload.contract,
      asOf: valuationTime,
      context,
      slices,
      source: payload.source,
    },
    rejected,
  };
}

/* ------------------------------------------------------------------ */
/* Manual entry mode (spec section 2)                                  */
/* ------------------------------------------------------------------ */

export interface ManualLeg {
  right: Right;
  strike: number;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  openInterest?: number | null;
  volume?: number | null;
}

export interface ManualChainInput {
  contract: ContractSpec;
  expiry: EpochMs;
  valuationTime: EpochMs;
  spot?: number | null;
  futures?: number | null;
  riskFreeRate?: number;
  legs: ManualLeg[];
}

/**
 * Builds a chain from hand-entered data. The engine treats this identically
 * to a feed, with one difference recorded in `source.note`: a manual chain of
 * two ATM legs cannot support strike selection, and the strike optimiser is
 * expected to refuse rather than interpolate a smile out of one point.
 */
export function manualChain(input: ManualChainInput): NormaliseResult {
  const distinctStrikes = new Set(input.legs.map((l) => l.strike)).size;
  const note =
    distinctStrikes < 3
      ? `manual entry with ${distinctStrikes} strike(s): sufficient for an environment ` +
        `read only, NOT for strike-level selection`
      : `manual entry with ${distinctStrikes} strikes`;

  return normalise({
    source: {
      providerId: 'manual',
      kind: 'live',
      retrievedAt: input.valuationTime,
      note,
    },
    contract: input.contract,
    context: {
      spot: input.spot ?? null,
      futures: input.futures ?? null,
      riskFreeRate: input.riskFreeRate ?? 0.065,
      dividendYield: 0,
      valuationTime: input.valuationTime,
    },
    rows: input.legs.map((l) => ({
      right: l.right,
      strike: l.strike,
      expiry: input.expiry,
      asOf: input.valuationTime,
      bid: l.bid ?? null,
      ask: l.ask ?? null,
      last: l.last ?? null,
      iv: l.iv ?? null,
      delta: l.delta ?? null,
      gamma: l.gamma ?? null,
      theta: l.theta ?? null,
      vega: l.vega ?? null,
      openInterest: l.openInterest ?? null,
      volume: l.volume ?? null,
    })),
  });
}
