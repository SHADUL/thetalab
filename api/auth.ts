/**
 * Login/logout/session-check for the custom login page. Deliberately the
 * ONLY /api/* routes middleware.ts lets through unauthenticated — every
 * other route (including every other resource in options-autotrade.ts)
 * requires the session cookie this issues. See src/lib/session.ts for the
 * signing mechanics.
 */
import { createSessionToken, buildSetCookieHeader, buildClearCookieHeader, readCookie, verifySessionToken, sessionCookieName } from '../src/lib/session.ts';

export default async function handler(req: any, res: any) {
  const resource = req.query?.resource;
  const expectedUser = process.env.SITE_BASIC_AUTH_USER;
  const expectedPass = process.env.SITE_BASIC_AUTH_PASS;
  const secret = process.env.SESSION_SECRET;

  if (!expectedUser || !expectedPass || !secret) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  if (resource === 'login') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    const { username, password } = req.body ?? {};
    if (username !== expectedUser || password !== expectedPass) {
      res.status(401).json({ ok: false, error: 'invalid_credentials' });
      return;
    }
    const token = await createSessionToken(username, secret);
    res.setHeader('Set-Cookie', buildSetCookieHeader(token));
    res.status(200).json({ ok: true });
    return;
  }

  if (resource === 'logout') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    res.setHeader('Set-Cookie', buildClearCookieHeader());
    res.status(200).json({ ok: true });
    return;
  }

  if (resource === 'me') {
    if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    const token = readCookie(req.headers?.cookie, sessionCookieName());
    const username = await verifySessionToken(token, secret);
    res.status(200).json({ authenticated: username !== null });
    return;
  }

  res.status(400).json({ error: 'bad_request', message: 'Unknown or missing ?resource=.' });
}
