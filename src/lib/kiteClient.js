/**
 * Thin client for the two Kite serverless routes (api/kite-login.js,
 * api/kite-quote.js). No credentials live here or anywhere else in the
 * frontend — the access token is an HttpOnly cookie this code can trigger
 * being set (by navigating to /api/kite-login) but can never read.
 *
 * Because the token is HttpOnly, the frontend can't directly ask "are we
 * connected" — it infers a best guess from the last successful connect
 * (recorded in localStorage after the callback redirect) and corrects
 * itself the moment a real request comes back 401.
 */
const CONNECTED_AT_KEY = 'kiteConnectedAt';
const ASSUMED_VALID_MS = 20 * 60 * 60 * 1000; // matches the callback's cookie Max-Age

export function kiteLoginUrl() {
  return '/api/kite-login';
}

/** Reads and clears the ?kite=connected|error redirect params, if present. */
export function consumeKiteRedirectResult() {
  const url = new URL(window.location.href);
  const kite = url.searchParams.get('kite');
  if (!kite) return null;

  const reason = url.searchParams.get('reason');
  url.searchParams.delete('kite');
  url.searchParams.delete('reason');
  window.history.replaceState({}, '', url.toString());

  if (kite === 'connected') {
    localStorage.setItem(CONNECTED_AT_KEY, String(Date.now()));
    return { connected: true };
  }
  return { connected: false, reason: reason ?? 'unknown' };
}

export function assumedKiteConnected() {
  const at = Number(localStorage.getItem(CONNECTED_AT_KEY));
  return Number.isFinite(at) && Date.now() - at < ASSUMED_VALID_MS;
}

export function forgetKiteConnection() {
  localStorage.removeItem(CONNECTED_AT_KEY);
}

/**
 * @param {string[]} instruments  e.g. ["NFO:NIFTY24D0524000CE"]
 * @returns {Promise<{quotes: Record<string, object>, asOf: string}>}
 */
export async function fetchLiveQuotes(instruments) {
  const qs = instruments.map((i) => `i=${encodeURIComponent(i)}`).join('&');
  const resp = await fetch(`/api/kite-quote?${qs}`);
  const body = await resp.json();
  if (!resp.ok) {
    if (body?.error === 'not_connected' || body?.error === 'token_expired') forgetKiteConnection();
    throw new Error(body?.message || `Live quote request failed (${resp.status})`);
  }
  return body;
}

/**
 * The full-chain fetch behind "Today (Live)".
 * @param {string} symbol   "NIFTY" | "SENSEX"
 * @param {string} expiry   "YYYY-MM-DD"
 * @param {number[]} strikes
 * @returns {Promise<{date: string, spot: number|null, chain: object, fetchedAt: string}>}
 */
export async function fetchLiveChain(symbol, expiry, strikes) {
  const qs = new URLSearchParams({ symbol, expiry, strikes: strikes.join(',') });
  const resp = await fetch(`/api/kite-chain?${qs}`);
  const body = await resp.json();
  if (!resp.ok) {
    if (body?.error === 'not_connected' || body?.error === 'token_expired') forgetKiteConnection();
    throw new Error(body?.message || `Live chain request failed (${resp.status})`);
  }
  return body;
}
