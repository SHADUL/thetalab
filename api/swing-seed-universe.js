/**
 * One-time (or periodic) universe seed: cross-references the Nifty 500
 * snapshot against Kite's own NSE instrument dump to resolve each symbol's
 * instrument_token (needed later for historical-candle requests), then
 * upserts the result into Supabase's `stocks` table.
 *
 * Kite's dump has no market-cap or "is this actually a liquid cash-market
 * equity" field — instrument_type/segment only get us to "this trades on
 * NSE cash market," not "this is worth scanning." The Nifty 500 membership
 * list is what supplies that (spec §4's intent), which is why this file
 * exists at all instead of just walking the Kite dump directly.
 *
 * Not wired into the UI — hit directly, from a browser with an active Kite
 * session, whenever the universe needs (re)seeding.
 */
import { createClient } from '@supabase/supabase-js';
import { NIFTY_500 } from '../src/swing/data/nifty500.js';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Kite's instrument dump is CSV, not JSON — this is deliberately a
 *  minimal, fixed-column-order parser (not a general CSV library) because
 *  the columns are Kite's own documented, stable format — with one
 *  exception: `name` is free text and occasionally contains a literal
 *  comma, which would shift every column after it under a naive forward
 *  split. `instrument_token`/`tradingsymbol` come before `name` so a
 *  forward index is safe for those; everything this function actually
 *  filters on (`instrument_type`, `segment`, `exchange`) comes after it, so
 *  those are indexed from the END of the row instead, where the offset is
 *  unaffected by however many extra commas `name` swallowed. */
function parseKiteInstrumentsCSV(text) {
  const lines = text.split('\n');
  const header = lines[0].split(',').map((c) => c.trim());
  const iToken = header.indexOf('instrument_token'), iSymbol = header.indexOf('tradingsymbol');
  const fromEnd = (name) => header.length - 1 - [...header].reverse().indexOf(name);
  const iType = fromEnd('instrument_type'), iSegment = fromEnd('segment'), iExchange = fromEnd('exchange');

  const bySymbol = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // trailing \r from CRLF line endings lands in the last column — trim
    // every cell rather than assume which one happens to be last.
    const cells = line.split(',').map((c) => c.trim());
    const back = (idx) => cells[cells.length - (header.length - idx)];
    if (back(iExchange) !== 'NSE' || back(iSegment) !== 'NSE' || back(iType) !== 'EQ') continue;
    bySymbol.set(cells[iSymbol], Number(cells[iToken]));
  }
  return bySymbol;
}

export default async function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [!apiKey && 'KITE_API_KEY', !supabaseUrl && 'SUPABASE_URL', !supabaseKey && 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(Boolean);
  if (missing.length) {
    res.status(500).json({ ok: false, error: 'server_misconfigured', message: `Missing: ${missing.join(', ')}.` });
    return;
  }

  const accessToken = parseCookies(req.headers.cookie).kite_token;
  if (!accessToken) {
    res.status(401).json({ ok: false, error: 'not_connected', message: 'Connect Kite before seeding the universe.' });
    return;
  }

  let bySymbol;
  try {
    const resp = await fetch('https://api.kite.trade/instruments/NSE', {
      headers: { Authorization: `token ${apiKey}:${accessToken}`, 'X-Kite-Version': '3' },
    });
    if (resp.status === 403 || resp.status === 401) {
      res.status(401).json({ ok: false, error: 'token_expired', message: 'Your Kite session has expired — connect again.' });
      return;
    }
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'kite_error', message: `Kite returned ${resp.status}.` });
      return;
    }
    bySymbol = parseKiteInstrumentsCSV(await resp.text());
  } catch {
    res.status(502).json({ ok: false, error: 'network', message: 'Could not reach Kite.' });
    return;
  }

  const matched = [];
  const unmatched = [];
  for (const stock of NIFTY_500) {
    const token = bySymbol.get(stock.symbol);
    if (token == null) { unmatched.push(stock.symbol); continue; }
    matched.push({
      symbol: stock.symbol, exchange: 'NSE', name: stock.name, sector: stock.sector,
      instrument_token: token, isin: stock.isin, active: true, last_synced_at: new Date().toISOString(),
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const { error } = await supabase.from('stocks').upsert(matched, { onConflict: 'symbol' });
  if (error) {
    res.status(502).json({ ok: false, error: 'supabase_error', message: error.message });
    return;
  }

  res.status(200).json({ ok: true, matched: matched.length, unmatched });
}
