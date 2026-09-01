/**
 * The "Today (Live)" fetch: every strike near the money, both sides, one
 * batched Kite call, shaped into the exact record the rest of the app
 * already expects from a bundle day (`{c,p,c0,p0,co,po}` per strike).
 *
 * There is no real open-vs-settlement distinction for a live snapshot —
 * there's only the one current price. c/c0 and p/p0 are populated with the
 * SAME live LTP deliberately, so every existing consumer (synthFuture reads
 * c/p, priceOf reads c0/p0 under "open" basis) resolves to the one real
 * number this actually has, with zero special-casing needed anywhere else
 * in the app.
 *
 * UNVERIFIED against a live key, same as kiteSymbol.js: the underlying
 * index instrument identifiers below (NSE:NIFTY 50, BSE:SENSEX) are my best
 * understanding of Kite's convention, not confirmed against a real response.
 */
import { kiteInstrument, INDEX_INSTRUMENT } from '../src/lib/kiteSymbol.js';

const MAX_STRIKES = 200;

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

function todayIST() {
  // en-CA gives YYYY-MM-DD directly, which is the date format the rest of
  // the app already uses as a chain key.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export default async function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_misconfigured', message: 'KITE_API_KEY is not set.' });
    return;
  }

  const accessToken = parseCookies(req.headers.cookie).kite_token;
  if (!accessToken) {
    res.status(401).json({ error: 'not_connected', message: 'Connect Kite before requesting a live chain.' });
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
  const expiry = url.searchParams.get('expiry');
  const strikes = (url.searchParams.get('strikes') || '')
    .split(',').map(Number).filter(Number.isFinite).slice(0, MAX_STRIKES);
  const exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';
  const indexInstrument = INDEX_INSTRUMENT[symbol];

  if (!indexInstrument || !expiry || strikes.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'Need symbol (NIFTY|SENSEX), expiry, and strikes.' });
    return;
  }

  const byInstrument = new Map(); // instrument -> {strike, right}
  for (const strike of strikes) {
    for (const right of ['CE', 'PE']) {
      byInstrument.set(kiteInstrument(symbol, expiry, strike, right, exchange), { strike, right });
    }
  }
  const instruments = [indexInstrument, ...byInstrument.keys()];

  const qs = instruments.map((i) => `i=${encodeURIComponent(i)}`).join('&');
  try {
    const resp = await fetch(`https://api.kite.trade/quote?${qs}`, {
      headers: { Authorization: `token ${apiKey}:${accessToken}`, 'X-Kite-Version': '3' },
    });
    if (resp.status === 403 || resp.status === 401) {
      res.status(401).json({ error: 'token_expired', message: 'Your Kite session has expired — connect again.' });
      return;
    }
    if (!resp.ok) {
      res.status(502).json({ error: 'kite_error', message: `Kite returned ${resp.status}.` });
      return;
    }

    const body = await resp.json();
    const data = body?.data ?? {};

    const spot = data[indexInstrument]?.last_price ?? null;
    const spotInstrumentToken = data[indexInstrument]?.instrument_token ?? null;
    const chain = {};
    for (const [instrument, { strike, right }] of byInstrument) {
      const q = data[instrument];
      if (!q || q.last_price == null) continue;
      const key = String(strike);
      if (!chain[key]) chain[key] = {};
      if (right === 'CE') { chain[key].c = q.last_price; chain[key].c0 = q.last_price; chain[key].co = q.oi ?? 0; }
      else { chain[key].p = q.last_price; chain[key].p0 = q.last_price; chain[key].po = q.oi ?? 0; }
    }

    res.status(200).json({
      date: todayIST(), spot, spotInstrumentToken, chain, fetchedAt: new Date().toISOString(),
    });
  } catch {
    res.status(502).json({ error: 'network', message: 'Could not reach Kite.' });
  }
}
