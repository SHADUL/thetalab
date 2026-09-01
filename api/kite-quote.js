/**
 * Live quote lookup for whatever strikes the frontend is currently showing.
 * api_key/access_token never reach the browser — the access_token lives
 * only in the HttpOnly cookie kite-callback.js set, read back here and
 * used server-side for the one Kite API call this makes.
 */
const MAX_INSTRUMENTS = 50;
const INSTRUMENT_RE = /^(NFO|BFO):[A-Z0-9]+$/;

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

export default async function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_misconfigured', message: 'KITE_API_KEY is not set.' });
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const accessToken = cookies.kite_token;
  if (!accessToken) {
    res.status(401).json({ error: 'not_connected', message: 'Connect Kite before requesting a live quote.' });
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const instruments = url.searchParams.getAll('i').filter((i) => INSTRUMENT_RE.test(i));
  if (instruments.length === 0) {
    res.status(400).json({ error: 'no_instruments', message: 'Pass at least one ?i=EXCHANGE:TRADINGSYMBOL.' });
    return;
  }
  if (instruments.length > MAX_INSTRUMENTS) {
    res.status(400).json({ error: 'too_many_instruments', message: `Max ${MAX_INSTRUMENTS} per request.` });
    return;
  }

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
    const quotes = {};
    for (const [key, q] of Object.entries(body?.data ?? {})) {
      quotes[key] = {
        lastPrice: q.last_price ?? null,
        bid: q.depth?.buy?.[0]?.price ?? null,
        ask: q.depth?.sell?.[0]?.price ?? null,
        volume: q.volume ?? null,
        oi: q.oi ?? null,
        timestamp: q.timestamp ?? null,
      };
    }
    res.status(200).json({ quotes, asOf: new Date().toISOString() });
  } catch {
    res.status(502).json({ error: 'network', message: 'Could not reach Kite.' });
  }
}
