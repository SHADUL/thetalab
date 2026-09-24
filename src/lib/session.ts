/**
 * Signed session cookie for the custom login page — replaces raw HTTP
 * Basic Auth as the thing actually gating access, so the login SCREEN can
 * be a designed page instead of the un-stylable native browser prompt.
 * The underlying security property is the same or stronger: a cookie the
 * browser can't read (HttpOnly) or forge (HMAC-signed with a server-only
 * secret), checked on every single request by middleware.ts before
 * anything else runs.
 *
 * Edge-runtime-compatible: uses only Web Crypto (crypto.subtle), no
 * Node-specific crypto module, since middleware.ts runs on Vercel's Edge
 * runtime by default.
 */

const COOKIE_NAME = 'thetalab_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Builds the signed cookie VALUE (not the full Set-Cookie header) for a successful login. */
export async function createSessionToken(username: string, secret: string): Promise<string> {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_DURATION_MS });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

/** Verifies a cookie value; returns the username when valid and unexpired, null otherwise. Never throws. */
export async function verifySessionToken(token: string | undefined | null, secret: string): Promise<string | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(sigB64) as BufferSource, new TextEncoder().encode(payloadB64));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return typeof payload.u === 'string' ? payload.u : null;
  } catch {
    return null;
  }
}

export function sessionCookieName(): string {
  return COOKIE_NAME;
}

export function buildSetCookieHeader(token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_DURATION_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function buildClearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** Reads a named cookie out of a raw Cookie header string. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
