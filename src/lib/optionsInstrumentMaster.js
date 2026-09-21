/**
 * Options instrument master — resolves the exact Kite tradingsymbol and
 * instrument_token for a given strike/expiry/right, synced from Kite's own
 * NFO/BFO instrument dumps (never constructed or guessed).
 *
 * Real order placement needs Kite's literal tradingsymbol. The app's
 * existing src/lib/kiteSymbol.js *builds* one heuristically for quote
 * lookups, and its own header already flags that construction as
 * "UNVERIFIED against a live key." This module is the one place an
 * order-placing engine is allowed to trust a tradingsymbol — and only
 * after finding it in Kite's own dump, never by constructing it. It does
 * not replace kiteSymbol.js's existing quote-lookup usage; it exists
 * specifically for the higher bar order placement requires.
 *
 * CSV parsing mirrors api/swing-seed-universe.js's defensive convention:
 * columns before `name` are indexed from the front of the row; columns
 * *after* `name` (expiry, strike, tick_size, lot_size, instrument_type,
 * segment, exchange) are indexed from the END of the row instead, so a
 * comma inside `name` can't shift them into the wrong column. Unlike
 * swing-seed-universe.js's equity `name` (a free-text company name that
 * genuinely can contain a comma), an index option's `name` is always a
 * short, clean underlying symbol ("NIFTY"/"BANKNIFTY"/"SENSEX") — but it
 * is still read from the end for the same reason: this parser (unlike
 * that one) filters on `name` itself, so it must resolve correctly even
 * though a corrupted `name` isn't actually expected to occur in practice.
 */

// SENSEX trades on BSE's derivatives segment (BFO); NIFTY/BANKNIFTY on NFO.
export const OPTIONS_SYMBOLS = {
  NIFTY: 'NFO',
  BANKNIFTY: 'NFO',
  SENSEX: 'BFO',
};

// Kite's real instrument dump wraps `name` in literal double quotes
// (e.g. `"NIFTY"`, confirmed against a live response) even though it never
// contains a comma for an index. A plain split+trim leaves those quote
// characters in place, so every cell is unwrapped here.
function unquote(cell) {
  return cell.length >= 2 && cell[0] === '"' && cell[cell.length - 1] === '"'
    ? cell.slice(1, -1)
    : cell;
}

/**
 * @typedef {object} OptionInstrument
 * @property {string} symbol            NIFTY | BANKNIFTY | SENSEX
 * @property {string} exchange           NFO | BFO
 * @property {string} expiry             "YYYY-MM-DD", Kite's own format
 * @property {number} strike
 * @property {'CE'|'PE'} right
 * @property {string} tradingsymbol       Kite's exact tradingsymbol
 * @property {number} instrument_token
 * @property {number|null} lot_size
 * @property {number|null} tick_size
 */

/**
 * Parses Kite's raw `/instruments/{NFO|BFO}` CSV dump, filtered to option
 * contracts (CE/PE) on the given underlying symbols.
 * @param {string} text
 * @param {string[]} [symbols]
 * @returns {OptionInstrument[]}
 */
export function parseKiteOptionsCSV(text, symbols = Object.keys(OPTIONS_SYMBOLS)) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const header = lines[0].split(',').map((c) => unquote(c.trim()));
  const iToken = header.indexOf('instrument_token');
  const iSymbol = header.indexOf('tradingsymbol');
  if (iToken === -1 || iSymbol === -1) return [];

  const fromEnd = (name) => header.length - 1 - [...header].reverse().indexOf(name);
  const iName = fromEnd('name');
  const iExpiry = fromEnd('expiry');
  const iStrike = fromEnd('strike');
  const iTick = fromEnd('tick_size');
  const iLot = fromEnd('lot_size');
  const iType = fromEnd('instrument_type');
  const iExchange = fromEnd('exchange');

  const wanted = new Set(symbols);
  /** @type {OptionInstrument[]} */
  const out = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // A trailing \r from CRLF line endings lands in the last column — trim
    // every cell rather than assume which one happens to be last.
    const cells = line.split(',').map((c) => unquote(c.trim()));
    const back = (idx) => cells[cells.length - (header.length - idx)];

    const name = back(iName);
    if (!wanted.has(name)) continue;
    const right = back(iType);
    if (right !== 'CE' && right !== 'PE') continue;
    const exchange = back(iExchange);
    if (exchange !== OPTIONS_SYMBOLS[name]) continue;

    const strike = Number(back(iStrike));
    const expiry = back(iExpiry);
    const tradingsymbol = cells[iSymbol];
    const instrumentToken = Number(cells[iToken]);
    if (!tradingsymbol || !expiry || !Number.isFinite(instrumentToken) || !Number.isFinite(strike) || strike <= 0) continue;

    const lotSizeRaw = Number(back(iLot));
    const tickSizeRaw = Number(back(iTick));

    out.push({
      symbol: name,
      exchange,
      expiry,
      strike,
      right,
      tradingsymbol,
      instrument_token: instrumentToken,
      lot_size: Number.isFinite(lotSizeRaw) && lotSizeRaw > 0 ? lotSizeRaw : null,
      tick_size: Number.isFinite(tickSizeRaw) && tickSizeRaw > 0 ? tickSizeRaw : null,
    });
  }
  return out;
}

/**
 * Drops contracts whose expiry has already passed, so the persisted table
 * doesn't grow unboundedly with dead rows. `todayISO` must be "YYYY-MM-DD"
 * — plain lexical comparison is correct for that format.
 * @param {OptionInstrument[]} instruments
 * @param {string} todayISO
 */
export function filterActiveInstruments(instruments, todayISO) {
  return instruments.filter((inst) => inst.expiry >= todayISO);
}

/** Canonical lookup key for matching a candidate leg against a synced instrument. */
export function buildInstrumentKey({ symbol, expiry, strike, right }) {
  return `${symbol}|${expiry}|${strike}|${right}`;
}

/**
 * Indexes a list of instruments by their lookup key for O(1) resolution.
 * An execution engine must treat a missing key as "refuse to trade this
 * leg" — never fall back to constructing a tradingsymbol.
 * @param {OptionInstrument[]} instruments
 * @returns {Map<string, OptionInstrument>}
 */
export function indexInstruments(instruments) {
  const map = new Map();
  for (const inst of instruments) map.set(buildInstrumentKey(inst), inst);
  return map;
}
