/**
 * Bridges the app's existing bundle chain shape — `{ [strike]: {c,p,co,po} }`
 * for the current session — into the quant engine's OptionChain, and runs it
 * through enrichChain. This is the only place the two systems touch: nothing
 * else in src/quant needs to know the bundle's shape, and nothing else in the
 * app needs to know the engine's.
 */
import { normalise, enrichChain } from "../quant/index.ts";

/**
 * @param {object} params
 * @param {Record<string, {c?:number, p?:number, co?:number, po?:number}>} params.chain
 * @param {number} params.spot
 * @param {string} params.expiry  "YYYY-MM-DD"
 * @param {string} params.today   "YYYY-MM-DD"
 * @param {number} params.lotQty
 * @param {number} params.step    strike step (50 for NIFTY, 100 for SENSEX)
 * @param {string} params.symbol
 * @param {"open"|"close"} params.priceBasis  must match the app's own selected
 *   basis (App.jsx's priceOf): a leg's entryPrice is read straight off this
 *   engine's output, and the app compares that entryPrice against priceOf()
 *   on every later render. Pricing off a different field than priceOf() uses
 *   makes a freshly-loaded position show P&L before a single day has passed.
 */
export function buildEnrichedSlice({ chain, spot, expiry, today, lotQty, step, symbol, priceBasis = "open" }) {
  if (!chain || !spot || !expiry || !today) return null;

  const cField = priceBasis === "open" ? "c0" : "c";
  const pField = priceBasis === "open" ? "p0" : "p";

  const rows = [];
  for (const [strikeStr, entry] of Object.entries(chain)) {
    const strike = Number(strikeStr);
    if (!entry) continue;
    const c = entry[cField];
    const p = entry[pField];
    if (c != null) rows.push({ right: "CE", strike, settle: c, openInterest: entry.co ?? null });
    if (p != null) rows.push({ right: "PE", strike, settle: p, openInterest: entry.po ?? null });
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
