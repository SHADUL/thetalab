/**
 * Real, live Kite Connect access — the only module in the archive/backfill
 * pipeline that talks to the actual Kite API. Kept separate from
 * historicalBars.ts (which stays fetcher-agnostic and fully unit-testable)
 * so the archive-backed backfill can inject this for real runs and a fake
 * KiteFetcher for tests.
 */
export interface KiteCredentials {
  apiKey: string;
  accessToken: string;
}

/** A raw KiteFetcher (../data/historicalBars.ts's expected shape) for the historical-candles endpoint — preserves the real HTTP status so fetchHistoricalChunk can classify TRANSIENT vs PERMANENT correctly, unlike this file's own kiteFetch helper (api/options-autotrade.ts) which throws away the status on error. */
export function createLiveKiteFetcher(creds: KiteCredentials): (url: string) => Promise<{ status: number; body: string }> {
  return async (url: string) => {
    const resp = await fetch(url, {
      headers: { Authorization: `token ${creds.apiKey}:${creds.accessToken}`, 'X-Kite-Version': '3' },
    });
    const body = await resp.text();
    return { status: resp.status, body };
  };
}

/** A cheap, read-only, side-effect-free call — the required "verify the Kite session before starting" check (never assume a token obtained yesterday is still valid; Kite tokens expire daily). */
export async function checkKiteSessionValid(creds: KiteCredentials): Promise<{ valid: boolean; message: string }> {
  try {
    const resp = await fetch('https://api.kite.trade/user/profile', {
      headers: { Authorization: `token ${creds.apiKey}:${creds.accessToken}`, 'X-Kite-Version': '3' },
    });
    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, message: `Kite session invalid/expired (HTTP ${resp.status})` };
    }
    if (!resp.ok) {
      return { valid: false, message: `Kite session check failed with unexpected HTTP ${resp.status}` };
    }
    const body = await resp.json().catch(() => null);
    if (body?.status !== 'success') {
      return { valid: false, message: `Kite session check returned an unexpected body: ${JSON.stringify(body).slice(0, 200)}` };
    }
    return { valid: true, message: 'Kite session valid' };
  } catch (err: any) {
    return { valid: false, message: `Kite session check network error: ${err.message}` };
  }
}
