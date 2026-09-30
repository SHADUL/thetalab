/**
 * Resolves the nearest NIFTY future to subscribe the depth feed to
 * (NIFTY_NEAREST_FUTURE, this milestone's chosen provider — see
 * depthSource.ts's own header). Split into a pure parser/resolver (this
 * file, tested against a real captured instrument-dump fixture) and a
 * thin live fetch wrapper, matching this codebase's established pattern
 * elsewhere (e.g. optionsInstrumentMaster.js).
 *
 * Found missing entirely from worker/main.ts on this milestone's first
 * real Railway deployment: the worker called depthSource.connect() but
 * never resolved an instrument or called subscribe() at all — the socket
 * opened but was never told which token to stream, so it could never
 * have received a single real depth tick regardless of market hours.
 */

export interface FutureInstrumentRow {
  instrumentToken: number;
  tradingsymbol: string;
  name: string;
  expiry: string; // "YYYY-MM-DD"
  instrumentType: string;
}

/**
 * Kite's instrument dump is CSV with some fields double-quoted (e.g.
 * `"NIFTY"` for name) — a naive `split(',')` on the quoted field compares
 * `"NIFTY"` (with quotes) against `NIFTY` and never matches. This strips
 * a single layer of surrounding double-quotes per field; none of the
 * columns this resolver reads ever contain an embedded comma, so a full
 * RFC4180 parser isn't needed here.
 */
function unquote(field: string): string {
  return field.startsWith('"') && field.endsWith('"') ? field.slice(1, -1) : field;
}

/** Parses Kite's NFO instrument dump (api.kite.trade/instruments/NFO), keeping only rows this resolver could ever need — every futures contract, any underlying. */
export function parseNfoFutures(csv: string): FutureInstrumentRow[] {
  const lines = csv.split('\n');
  const header = lines[0]?.split(',') ?? [];
  const idx = {
    token: header.indexOf('instrument_token'),
    tradingsymbol: header.indexOf('tradingsymbol'),
    name: header.indexOf('name'),
    expiry: header.indexOf('expiry'),
    type: header.indexOf('instrument_type'),
  };
  const rows: FutureInstrumentRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    if (unquote(cols[idx.type] ?? '') !== 'FUT') continue;
    const instrumentToken = Number(cols[idx.token]);
    if (!Number.isFinite(instrumentToken)) continue;
    rows.push({
      instrumentToken,
      tradingsymbol: unquote(cols[idx.tradingsymbol] ?? ''),
      name: unquote(cols[idx.name] ?? ''),
      expiry: unquote(cols[idx.expiry] ?? ''),
      instrumentType: 'FUT',
    });
  }
  return rows;
}

/**
 * The nearest (soonest-expiring) future for `underlyingName`, among
 * contracts not yet expired as of `todayISO` ("YYYY-MM-DD") — an expired
 * row can still be present in the dump for a day or two after rollover,
 * so "soonest expiry" alone isn't enough; it must also not be in the past.
 * Returns null (never a guess) when no such contract exists in the dump.
 */
export function resolveNearestFuture(rows: FutureInstrumentRow[], underlyingName: string, todayISO: string): FutureInstrumentRow | null {
  const candidates = rows
    .filter((r) => r.name === underlyingName && r.expiry >= todayISO)
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  return candidates[0] ?? null;
}

/** Live fetch of Kite's full NFO instrument dump — the only network call this module makes; parsing/resolution above stay pure and independently testable. */
export async function fetchNfoInstrumentsCsv(apiKey: string, accessToken: string): Promise<string> {
  const resp = await fetch('https://api.kite.trade/instruments/NFO', {
    headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Kite instruments/NFO fetch failed: ${resp.status}`);
  return resp.text();
}
