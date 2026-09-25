/**
 * Project-wide access gate — runs on every request (the static SPA and
 * every /api/* route) before anything else, via Vercel Routing
 * Middleware. See src/lib/session.ts for the signed-cookie mechanics and
 * api/auth.ts for how the cookie gets issued.
 *
 * This app was built with no per-user concept at all: one global
 * settings row, one Kite session, one set of positions — "browser-facing,
 * no shared-secret gate" was a deliberate simplification everywhere, on
 * the assumption only the one operator would ever have the URL. Now that
 * AUTO places real orders against a real account, anyone who gets this
 * link could see the real Kite balance/positions and even change
 * settings (including flipping execution_mode to AUTO) with zero
 * authentication. This middleware is the fix.
 *
 * Fails closed: if SESSION_SECRET is missing for any reason, every
 * request is refused rather than silently allowed through.
 *
 * login/logout/me are handled inside api/options-autotrade.ts's own
 * resource dispatch, not a separate api/auth.ts file — Vercel Hobby caps
 * a deployment at 12 serverless functions, and this project was already
 * at that cap.
 */
import { verifySessionToken, readCookie, sessionCookieName } from './src/lib/session.ts';

// Node.js over the default Edge runtime, per Vercel's own recommendation —
// everything this file uses (Web Crypto's crypto.subtle, atob/btoa,
// process.env) is available on both, so there's no behavior difference.
export const config = { runtime: 'nodejs' };

const STATIC_EXTENSIONS = /\.(js|mjs|css|map|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp|avif|json|txt|webmanifest)$/i;
const AUTH_RESOURCES = new Set(['login', 'logout', 'me']);

function isPubliclyReachable(pathname: string, searchParams: URLSearchParams): boolean {
  if (pathname === '/login') return true;
  if (pathname === '/api/options-autotrade' && AUTH_RESOURCES.has(searchParams.get('resource') ?? '')) return true;
  if (pathname.startsWith('/assets/')) return true;
  if (STATIC_EXTENSIONS.test(pathname)) return true;
  return false;
}

// The paper-scan/position-monitor/vwap-scalper crons are server-triggered
// (an external scheduler, no browser involved) and authenticate with their
// own Authorization: Bearer <OPTIONS_AUTOTRADE_CRON_SECRET> header, checked
// again inside options-autotrade.ts's own dispatch. Without this carve-out
// every cron hit died here with 401 before ever reaching that check — the
// entire automated scan/monitor pipeline went silent the moment the session
// cookie gate shipped, since a cron call obviously carries no such cookie.
function isValidCronRequest(request: Request): boolean {
  const secret = process.env.OPTIONS_AUTOTRADE_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (isPubliclyReachable(url.pathname, url.searchParams)) return undefined;
  if (isValidCronRequest(request)) return undefined;

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return new Response('Server misconfigured.', { status: 500 });
  }

  const token = readCookie(request.headers.get('cookie'), sessionCookieName());
  const username = await verifySessionToken(token, secret);
  if (username) return undefined; // authenticated — let the request through

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const loginUrl = new URL('/login', url.origin);
  if (url.pathname !== '/' ) loginUrl.searchParams.set('next', url.pathname + url.search);
  return Response.redirect(loginUrl.toString(), 302);
}
