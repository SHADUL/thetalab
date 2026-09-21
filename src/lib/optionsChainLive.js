/**
 * Pure helpers for building a live, multi-expiry option chain from Kite
 * quote responses — the input the quant engine's normalise()/enrichChain()
 * need, sourced from real bid/ask/OI/volume (not settlement-only bhavcopy
 * data), so the liquidity/spread scoring in tradeQualityScore.ts can
 * finally see real numbers instead of always falling back to its
 * OI/volume-only path.
 *
 * No network call lives here — this only selects which strikes to ask
 * for, batches instrument lists under Kite's per-call limit, and maps one
 * quote response entry into the RawOptionRow shape src/quant/data/adapter.ts
 * expects. The actual fetch() calls belong to the orchestrator that uses
 * this module.
 */

/** Kite's /quote endpoint accepts at most this many instruments per call (same limit api/kite-market-data.js's quote handler already enforces). */
export const MAX_QUOTE_INSTRUMENTS = 50;

/** Strikes on the given expiry within +/- widthPct of spot, sorted ascending. Bounds how many instruments get fetched per expiry. */
export function selectStrikesNearSpot(availableStrikes, spot, widthPct = 0.08) {
  const lo = spot * (1 - widthPct);
  const hi = spot * (1 + widthPct);
  return [...new Set(availableStrikes)].filter((k) => k >= lo && k <= hi).sort((a, b) => a - b);
}

/** Splits an array into chunks of at most `size` — generic, not options-specific. */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Maps one Kite /quote response entry into the RawOptionRow shape
 * normalise() expects. `instrumentKey` is the "EXCHANGE:TRADINGSYMBOL" key
 * Kite's response is itself indexed by (matches how api/kite-market-data.js
 * already reads this same response shape for the quote endpoint).
 */
export function kiteQuoteToOptionRow({ strike, right, expiryEpochMs, asOfEpochMs, quote }) {
  return {
    right,
    strike,
    expiry: expiryEpochMs,
    asOf: asOfEpochMs,
    bid: quote?.depth?.buy?.[0]?.price ?? null,
    ask: quote?.depth?.sell?.[0]?.price ?? null,
    last: quote?.last_price ?? null,
    settle: null, // live quotes have no settlement price — enrichChain() falls back to mid/last per its own markPricePreference
    openInterest: quote?.oi ?? null,
    oiChange: null,
    volume: quote?.volume ?? null,
  };
}

/**
 * Builds the full set of "EXCHANGE:TRADINGSYMBOL" instrument keys to quote
 * for one expiry's selected strikes, keyed so the caller can map a fetched
 * quote back to its strike/right afterward.
 * @param {Array<{strike:number, right:'CE'|'PE', tradingsymbol:string}>} instruments
 * @param {string} exchange
 * @returns {{keys: string[], byKey: Map<string, {strike:number, right:'CE'|'PE'}>}}
 */
export function buildInstrumentKeys(instruments, exchange) {
  const keys = [];
  const byKey = new Map();
  for (const inst of instruments) {
    const key = `${exchange}:${inst.tradingsymbol}`;
    keys.push(key);
    byKey.set(key, { strike: inst.strike, right: inst.right });
  }
  return { keys, byKey };
}
