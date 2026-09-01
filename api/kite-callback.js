/**
 * Where Zerodha sends the browser back to after login, with a one-time
 * request_token in the query string. Exchanges it server-side for the
 * day's access_token (api_secret never leaves this function) and hands the
 * browser an HttpOnly cookie — so the token exists in the browser as an
 * opaque cookie a script can't read, not as something the frontend holds
 * or could leak.
 *
 * Kite's access tokens expire around 6am IST the next day, not on a fixed
 * duration from issuance. 20 hours is a deliberately conservative cover for
 * "the rest of today" without meaningfully overstaying that boundary.
 */
import { createHash } from 'node:crypto';

const TOKEN_COOKIE = 'kite_token';
const COOKIE_MAX_AGE_S = 20 * 60 * 60;

export default async function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(500).send('KITE_API_KEY / KITE_API_SECRET are not configured on the server.');
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const requestToken = url.searchParams.get('request_token');
  const status = url.searchParams.get('status');

  if (status !== 'success' || !requestToken) {
    res.writeHead(302, { Location: '/?kite=error&reason=login_failed' });
    res.end();
    return;
  }

  const checksum = createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');

  try {
    const resp = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
      body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
    });
    const body = await resp.json();

    if (!resp.ok || !body?.data?.access_token) {
      res.writeHead(302, { Location: '/?kite=error&reason=exchange_failed' });
      res.end();
      return;
    }

    const cookie = [
      `${TOKEN_COOKIE}=${body.data.access_token}`,
      'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${COOKIE_MAX_AGE_S}`,
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);
    res.writeHead(302, { Location: '/?kite=connected' });
    res.end();
  } catch {
    res.writeHead(302, { Location: '/?kite=error&reason=network' });
    res.end();
  }
}
