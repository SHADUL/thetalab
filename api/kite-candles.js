/**
 * Historical/intraday candles for one instrument. Kite's historical API is
 * addressed by numeric instrument_token, not the EXCHANGE:TRADINGSYMBOL
 * string the quote/chain routes use — the frontend gets the token from a
 * live quote response (kite-chain.js already captures it) and passes it
 * straight through here.
 *
 * Kite has no native 4-hour interval — it stops at 60minute. "4hour" here
 * is server-side aggregation: fetch 60minute candles and bucket every 4 of
 * them into one. Worth knowing going in: NIFTY's session is ~6h15m long, so
 * a 4-hour candle produces at most 1-2 bars a day — thin by construction,
 * not a bug in the aggregation.
 */
const KITE_INTERVAL = {
  minute: 'minute', '5minute': '5minute', '15minute': '15minute',
  '60minute': '60minute', '4hour': '60minute', day: 'day',
};
const BUCKET = { '4hour': 4 };

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

function aggregate(candles, bucket) {
  if (bucket <= 1) return candles;
  const out = [];
  for (let i = 0; i < candles.length; i += bucket) {
    const chunk = candles.slice(i, i + bucket);
    if (chunk.length === 0) continue;
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((c) => c.h)),
      l: Math.min(...chunk.map((c) => c.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((s, c) => s + (c.v ?? 0), 0),
    });
  }
  return out;
}

export default async function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_misconfigured', message: 'KITE_API_KEY is not set.' });
    return;
  }

  const accessToken = parseCookies(req.headers.cookie).kite_token;
  if (!accessToken) {
    res.status(401).json({ error: 'not_connected', message: 'Connect Kite before requesting candles.' });
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const clientInterval = url.searchParams.get('interval');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const kiteInterval = KITE_INTERVAL[clientInterval];

  if (!token || !kiteInterval || !from || !to) {
    res.status(400).json({
      error: 'bad_request',
      message: 'Need token, interval (one of minute/5minute/15minute/60minute/4hour/day), from, to.',
    });
    return;
  }

  try {
    const resp = await fetch(
      `https://api.kite.trade/instruments/historical/${token}/${kiteInterval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { Authorization: `token ${apiKey}:${accessToken}`, 'X-Kite-Version': '3' } },
    );
    if (resp.status === 403 || resp.status === 401) {
      res.status(401).json({ error: 'token_expired', message: 'Your Kite session has expired — connect again.' });
      return;
    }
    if (!resp.ok) {
      res.status(502).json({ error: 'kite_error', message: `Kite returned ${resp.status}.` });
      return;
    }

    const body = await resp.json();
    const raw = (body?.data?.candles ?? []).map((c) => ({
      t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
    }));
    const candles = aggregate(raw, BUCKET[clientInterval] ?? 1);

    res.status(200).json({ interval: clientInterval, candles });
  } catch {
    res.status(502).json({ error: 'network', message: 'Could not reach Kite.' });
  }
}
