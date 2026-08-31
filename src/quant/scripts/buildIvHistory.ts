/**
 * Replays every session in a near-ATM export (produced by
 * nifty-option-backtester's optdata/atm_export.py) through the quant core's
 * own Black-76 + IV solver, and writes out one ATM-IV number per session.
 *
 * This is the store Phase 3's IV rank/percentile reads. It is built entirely
 * from data the pipeline already has on disk — no new collection, no new
 * provider. The raw archive gives prices; this script is what turns "prices"
 * into "the volatility the market was pricing that day," using the exact
 * same solver the live app will use going forward, so a rank computed today
 * is comparable to the history it is ranked against.
 *
 * Usage:
 *   node --experimental-strip-types src/quant/scripts/buildIvHistory.ts \
 *     <near-atm-export.json> <output.json> [strikeStep]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalise, type RawChainPayload, type RawOptionRow } from '../data/adapter.ts';
import { enrichChain } from '../enrich.ts';
import type { ContractSpec } from '../types.ts';

interface NearAtmRow {
  right: 'CE' | 'PE';
  strike: number;
  settle: number;
  oi: number;
}
interface NearAtmSession {
  date: string;
  expiry: string;
  underlying: number;
  lot: number | null;
  rows: NearAtmRow[];
}
interface NearAtmExport {
  symbol: string;
  sessions: NearAtmSession[];
}

export interface IvHistoryPoint {
  date: string;
  expiry: string;
  dte: number;
  forward: number;
  forwardSource: 'futures' | 'parity' | 'spot-carry';
  atmStrike: number;
  /** Average of call and put IV at the ATM strike, when both are usable. */
  atmIv: number | null;
  callIv: number | null;
  putIv: number | null;
  /** True when the reported atmIv fell back to a single side. */
  singleSided: boolean;
}

const [, , inPath, outPath, strikeStepArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: buildIvHistory.ts <near-atm-export.json> <output.json> [strikeStep]');
  process.exit(1);
}

const raw: NearAtmExport = JSON.parse(readFileSync(inPath, 'utf8'));
const strikeStep = strikeStepArg ? Number(strikeStepArg) : raw.symbol === 'SENSEX' ? 100 : 50;

// Lot size and pricing basis do not affect price, IV or the forward at all —
// only margin/position sizing, which this script does not compute. A fixed
// placeholder is correct here and would be wrong to reuse for anything
// lot-size-sensitive.
const contract: ContractSpec = {
  underlyingSymbol: raw.symbol,
  lotSize: 1,
  pointValue: 1,
  strikeStep,
  currency: 'INR',
  exerciseStyle: 'european',
  pricingBasis: 'futures',
};

const points: IvHistoryPoint[] = [];
let skippedNoForward = 0;
let skippedNoAtm = 0;

for (const session of raw.sessions) {
  const valuationTime = Date.parse(`${session.date}T15:30:00+05:30`);
  const expiryTime = Date.parse(`${session.expiry}T15:30:00+05:30`);

  const rows: RawOptionRow[] = session.rows.map((r) => ({
    right: r.right,
    strike: r.strike,
    expiry: expiryTime,
    asOf: valuationTime,
    settle: r.settle,
    openInterest: r.oi,
  }));

  const payload: RawChainPayload = {
    source: { providerId: 'bhavcopy-archive', kind: 'historical', retrievedAt: Date.now() },
    contract,
    context: { valuationTime, spot: session.underlying, futures: null, riskFreeRate: 0.065 },
    rows,
  };

  const { chain } = normalise(payload);
  const enriched = enrichChain(chain);
  const slice = enriched.slices[0];
  if (!slice) {
    skippedNoForward++;
    continue;
  }
  if (slice.atmStrike === null) {
    skippedNoAtm++;
    continue;
  }

  const atCall = slice.quotes.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'CE');
  const atPut = slice.quotes.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'PE');
  const callIv = atCall?.iv ?? null;
  const putIv = atPut?.iv ?? null;

  let atmIv: number | null = null;
  let singleSided = false;
  if (callIv !== null && putIv !== null) {
    atmIv = (callIv + putIv) / 2;
  } else if (callIv !== null || putIv !== null) {
    atmIv = callIv ?? putIv;
    singleSided = true;
  }

  points.push({
    date: session.date,
    expiry: session.expiry,
    dte: Math.round(slice.timeToExpiry * 365),
    forward: slice.forward,
    forwardSource: slice.forwardSource,
    atmStrike: slice.atmStrike,
    atmIv,
    callIv,
    putIv,
    singleSided,
  });
}

writeFileSync(outPath, JSON.stringify({ symbol: raw.symbol, points }));

const solved = points.filter((p) => p.atmIv !== null).length;
console.log(JSON.stringify({
  symbol: raw.symbol,
  sessionsIn: raw.sessions.length,
  pointsOut: points.length,
  ivSolved: solved,
  ivUnsolved: points.length - solved,
  skippedNoForward,
  skippedNoAtm,
  outPath,
}, null, 2));
