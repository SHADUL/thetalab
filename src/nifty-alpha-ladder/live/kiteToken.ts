/**
 * Where the worker gets its Kite access token. Kite tokens expire daily; the
 * website's Kite login stores the fresh one in Supabase (kite_session), so
 * the worker reads it from there instead of needing it copied into its env
 * and redeployed every morning. Candidates are tried in order and accepted
 * only if Kite itself accepts them; if none is valid yet (before the
 * morning login), the worker waits rather than crashing or connecting with
 * a dead token. Infrastructure only — no strategy logic.
 */
export type TokenSource = () => Promise<string | null>;
export type TokenValidator = (token: string) => Promise<boolean>;

export async function firstValidToken(sources: TokenSource[], isValid: TokenValidator): Promise<string | null> {
  for (const source of sources) {
    let token: string | null = null;
    try { token = await source(); } catch { token = null; }
    if (token && await isValid(token).catch(() => false)) return token;
  }
  return null;
}

export async function waitForValidToken(
  sources: TokenSource[], isValid: TokenValidator,
  opts: { pollMs: number; sleep: (ms: number) => Promise<void>; onWaiting?: () => Promise<void> | void; maxAttempts?: number },
): Promise<string | null> {
  for (let attempt = 0; opts.maxAttempts === undefined || attempt < opts.maxAttempts; attempt++) {
    const token = await firstValidToken(sources, isValid);
    if (token) return token;
    if (attempt === 0) await opts.onWaiting?.();
    await opts.sleep(opts.pollMs);
  }
  return null;
}

/** Kite accepts the token iff /user/profile answers 200. */
export function kiteTokenValidator(apiKey: string, fetchFn: typeof fetch = fetch): TokenValidator {
  return async (token) => {
    const r = await fetchFn('https://api.kite.trade/user/profile', { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${token}` } });
    return r.status === 200;
  };
}
