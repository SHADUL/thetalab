/**
 * Bridges the app's existing bundle chain shape — `{ [strike]: {c,p,co,po} }`
 * for the current session — into the quant engine's OptionChain, and runs it
 * through enrichChain. This is the only place the two systems touch: nothing
 * else in src/quant needs to know the bundle's shape, and nothing else in the
 * app needs to know the engine's.
 */
import { normalise, enrichChain } from "../quant/index.ts";

/**
 * Always prices off settlement (`c`/`p`), regardless of the app's selected
 * priceBasis. Settlement is the one price NSE computes for every contract
 * and keeps arbitrage-consistent across strikes; a session-open print is a
 * single morning trade with no such guarantee — it can be missing on
 * illiquid strikes, or violate monotonicity between adjacent strikes
 * outright (a put priced lower than the strike below it), which corrupts
 * parity, IV and every Greek downstream for anyone who prices off it
 * directly. Use `entryPriceOf` below to get the basis-appropriate price for
 * whichever specific strikes end up selected.
 *
 * @param {object} params
 * @param {Record<string, {c?:number, p?:number, co?:number, po?:number}>} params.chain
 * @param {number} params.spot
 * @param {string} params.expiry  "YYYY-MM-DD"
 * @param {string} params.today   "YYYY-MM-DD"
 * @param {number} params.lotQty
 * @param {number} params.step    strike step (50 for NIFTY, 100 for SENSEX)
 * @param {string} params.symbol
 */
export function buildEnrichedSlice({ chain, spot, expiry, today, lotQty, step, symbol }) {
  if (!chain || !spot || !expiry || !today) return null;

  const rows = [];
  for (const [strikeStr, entry] of Object.entries(chain)) {
    const strike = Number(strikeStr);
    if (!entry) continue;
    if (entry.c != null) rows.push({ right: "CE", strike, settle: entry.c, openInterest: entry.co ?? null });
    if (entry.p != null) rows.push({ right: "PE", strike, settle: entry.p, openInterest: entry.po ?? null });
  }
  if (rows.length === 0) return null;

  // 15:30 IST close, matching the convention used everywhere else this
  // engine turns a date string into a valuation instant (buildIvHistory.ts).
  const valuationTime = Date.parse(`${today}T15:30:00+05:30`);
  const expiryTime = Date.parse(`${expiry}T15:30:00+05:30`);

  const payload = {
    source: { providerId: "thetalab-bundle", kind: "eod", retrievedAt: Date.now() },
    contract: {
      underlyingSymbol: symbol,
      lotSize: Number(lotQty) > 0 ? Number(lotQty) : 1,
      pointValue: 1,
      strikeStep: step,
      currency: "INR",
      exerciseStyle: "european",
      pricingBasis: "futures",
    },
    context: { valuationTime, spot, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows: rows.map((r) => ({ ...r, expiry: expiryTime, asOf: valuationTime })),
  };

  const { chain: normalised } = normalise(payload);
  const enriched = enrichChain(normalised);
  return { slice: enriched.slices[0] ?? null, chainIssues: enriched.issues };
}

/**
 * The price the app's own priceOf() (App.jsx) would return for this exact
 * strike right now — c0/p0 under "open" basis, c/p under "close". This is
 * what a strategy's legs must be priced at when loaded, since it's what
 * their live P&L gets compared against on every later render; it is
 * deliberately NOT what buildEnrichedSlice uses for analysis (see above).
 *
 * @param {Record<string, {c?:number, p?:number}>} chain
 * @param {"open"|"close"} priceBasis
 * @returns {(strike: number, right: "CE"|"PE") => number | null}
 */
export function entryPriceOf(chain, priceBasis) {
  const cField = priceBasis === "open" ? "c0" : "c";
  const pField = priceBasis === "open" ? "p0" : "p";
  return (strike, right) => {
    const entry = chain?.[strike];
    if (!entry) return null;
    const v = right === "CE" ? entry[cField] : entry[pField];
    return v == null ? null : v;
  };
}
