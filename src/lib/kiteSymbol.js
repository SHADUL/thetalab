/**
 * Builds a Kite/NSE trading symbol for an index option, e.g. NIFTY24D0524000CE.
 *
 * UNVERIFIED against a live key — this has never actually been run against
 * Kite's API. It targets NSE's current unified weekly-style convention
 * (SYMBOL + YY + single-char month code + DD + STRIKE + CE/PE) for every
 * NFO/BFO index expiry, not the older separate "monthly" abbreviated form.
 * If a live quote comes back empty for a symbol this builds, this is the
 * first place to check — Kite's downloadable instrument master CSV is the
 * authoritative source to verify or correct it against.
 */
const MONTH_CODE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D']; // Jan..Dec

/** Also unverified — Kite's identifier for each index's own quote/candles. */
export const INDEX_INSTRUMENT = { NIFTY: 'NSE:NIFTY 50', SENSEX: 'BSE:SENSEX' };

export function kiteInstrument(symbol, expiryISO, strike, right, exchange = 'NFO') {
  const d = new Date(`${expiryISO}T00:00:00Z`);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const tradingSymbol = `${symbol}${yy}${MONTH_CODE[d.getUTCMonth()]}${dd}${strike}${right}`;
  return `${exchange}:${tradingSymbol}`;
}
