/**
 * Project-wide access gate — HTTP Basic Auth in front of EVERY request
 * (the static SPA and every /api/* route), via Vercel Edge Middleware.
 *
 * This app was built with no per-user concept at all: one global
 * settings row, one Kite session, one set of positions — "browser-facing,
 * no shared-secret gate" was a deliberate simplification everywhere,
 * on the assumption only the one operator would ever have the URL. Now
 * that AUTO places real orders against a real account, anyone who gets
 * this link can see the real Kite balance/positions and even change
 * settings (including flipping execution_mode to AUTO) with zero
 * authentication. This middleware is the fix: nothing in the app is
 * reachable at all without the credentials below.
 *
 * SITE_BASIC_AUTH_USER / SITE_BASIC_AUTH_PASS must be set as Vercel
 * environment variables — there is no fallback/bypass if they're
 * missing, the whole site 401s instead (fail closed, not open).
 */

// No matcher — Routing Middleware runs on every request by default, which
// is exactly what a project-wide gate needs. A matcher pattern here would
// be one more place to get subtly wrong and accidentally leave a path
// unprotected.

function unauthorized(): Response {
  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="thetalab", charset="UTF-8"' },
  });
}

export default function middleware(request: Request): Response | undefined {
  const expectedUser = process.env.SITE_BASIC_AUTH_USER;
  const expectedPass = process.env.SITE_BASIC_AUTH_PASS;
  if (!expectedUser || !expectedPass) return unauthorized();

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Basic ')) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(authHeader.slice(6));
  } catch {
    return unauthorized();
  }
  const separatorIdx = decoded.indexOf(':');
  if (separatorIdx === -1) return unauthorized();
  const user = decoded.slice(0, separatorIdx);
  const pass = decoded.slice(separatorIdx + 1);

  if (user !== expectedUser || pass !== expectedPass) return unauthorized();

  return undefined; // authenticated — let the request through
}
