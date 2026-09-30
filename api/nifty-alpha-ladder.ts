/**
 * Nifty Alpha Ladder (hedged133) — isolated Vercel function, dispatched by
 * `?resource=`, same convention as api/options-autotrade.ts but a
 * completely separate file/strategy (see NIFTY_ALPHA_LADDER_SPEC_
 * RECONSTRUCTION.md and NIFTY_ALPHA_LADDER_IMPLEMENTATION_PLAN.md).
 *
 * This file owns ZERO real-order capability at any resource — Milestone 3
 * is SHADOW-only. The always-on market-stream worker (Railway) owns the
 * live depth feed, the signal/SHADOW lifecycle and the futures monitor;
 * this file is read-only reporting plus the one diagnostic probe below,
 * used once to empirically resolve A1/A7 rather than guess at Kite's
 * actual capability.
 *
 * Gated resources share the SAME shared-secret env var Options Auto-Trader
 * already uses (OPTIONS_AUTOTRADE_CRON_SECRET) — a shared piece of
 * infrastructure (an auth gate for server-triggered endpoints), not
 * strategy logic, so reusing it does not couple this strategy's business
 * logic to that one's.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function supabaseAdmin(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function kiteFetch(path: string, opts: { token: string; apiKey: string }): Promise<any> {
  const resp = await fetch(`https://api.kite.trade${path}`, {
    headers: { Authorization: `token ${opts.apiKey}:${opts.token}`, 'X-Kite-Version': '3' },
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`Kite ${path} -> HTTP ${resp.status}: ${JSON.stringify(body)}`);
  return body;
}

function unquote(cell: string): string {
  return cell.length >= 2 && cell[0] === '"' && cell[cell.length - 1] === '"' ? cell.slice(1, -1) : cell;
}

/** Parses Kite's raw NFO instruments CSV for FUT rows on a given underlying — same defensive from-the-end column convention as src/lib/optionsInstrumentMaster.js, for the same reason (a comma inside `name` must not shift later columns). */
function parseNiftyFutures(csvText: string): Array<{ tradingsymbol: string; instrument_token: number; expiry: string; lot_size: number | null }> {
  const lines = csvText.split('\n');
  if (!lines.length) return [];
  const header = lines[0].split(',').map((c) => unquote(c.trim()));
  const iToken = header.indexOf('instrument_token');
  const iSymbol = header.indexOf('tradingsymbol');
  const fromEnd = (name: string) => header.length - 1 - [...header].reverse().indexOf(name);
  const iName = fromEnd('name');
  const iExpiry = fromEnd('expiry');
  const iLot = fromEnd('lot_size');
  const iType = fromEnd('instrument_type');
  const out: Array<{ tradingsymbol: string; instrument_token: number; expiry: string; lot_size: number | null }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => unquote(c.trim()));
    const back = (idx: number) => cells[cells.length - (header.length - idx)];
    if (back(iName) !== 'NIFTY' || back(iType) !== 'FUT') continue;
    out.push({
      tradingsymbol: cells[iSymbol],
      instrument_token: Number(cells[iToken]),
      expiry: back(iExpiry),
      lot_size: Number(back(iLot)) || null,
    });
  }
  return out.sort((a, b) => Date.parse(a.expiry) - Date.parse(b.expiry));
}

/** Finds INDIA VIX's instrument_token by searching the NSE indices CSV — never hardcoded, resolved from Kite's own dump. */
function findIndiaVixToken(csvText: string): { instrument_token: number; tradingsymbol: string } | null {
  const lines = csvText.split('\n');
  if (!lines.length) return null;
  const header = lines[0].split(',').map((c) => unquote(c.trim()));
  const iToken = header.indexOf('instrument_token');
  const iSymbol = header.indexOf('tradingsymbol');
  const iName = header.indexOf('name');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => unquote(c.trim()));
    if ((cells[iName] || '').toUpperCase() === 'INDIA VIX') {
      return { instrument_token: Number(cells[iToken]), tradingsymbol: cells[iSymbol] };
    }
  }
  return null;
}

/**
 * Read-only Kite capability probe (A1/A7 empirical resolution) — NEVER
 * places, modifies or cancels anything. Used once to populate
 * NIFTY_ALPHA_LADDER_MARKET_DATA_CAPABILITY_REPORT.md with real findings
 * rather than assumptions.
 */
async function handleProbe(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, skipped: 'no_kite_session' }); return; }

  const results: Record<string, unknown> = {};

  // --- Nearest NIFTY future: resolution + depth/quote shape ---
  let nearestFuture: ReturnType<typeof parseNiftyFutures>[number] | undefined;
  try {
    const resp = await fetch('https://api.kite.trade/instruments/NFO', { headers: { Authorization: `token ${apiKey}:${token}` } });
    const csv = await resp.text();
    const futures = parseNiftyFutures(csv);
    const todayISO = new Date().toISOString().slice(0, 10);
    nearestFuture = futures.find((f) => f.expiry >= todayISO);
    results.niftyFutures = { status: resp.status, count: futures.length, nearest: nearestFuture ?? null };
  } catch (err: any) {
    results.niftyFutures = { error: err.message };
  }

  if (nearestFuture) {
    try {
      const quote = await kiteFetch(`/quote?i=${encodeURIComponent(`NFO:${nearestFuture.tradingsymbol}`)}`, { token, apiKey });
      const row = quote?.data?.[`NFO:${nearestFuture.tradingsymbol}`];
      results.futuresQuote = {
        hasDepth: Boolean(row?.depth),
        bidLevels: row?.depth?.buy?.length ?? 0,
        askLevels: row?.depth?.sell?.length ?? 0,
        sampleBidLevel: row?.depth?.buy?.[0] ?? null,
        sampleAskLevel: row?.depth?.sell?.[0] ?? null,
        hasOrderCountField: row?.depth?.buy?.[0] ? 'orders' in row.depth.buy[0] : null,
        lastPrice: row?.last_price ?? null,
        lastTradeTime: row?.last_trade_time ?? null,
      };
    } catch (err: any) {
      results.futuresQuote = { error: err.message };
    }
  }

  // --- India VIX: resolve token, then probe historical-candle granularity ---
  let vixToken: { instrument_token: number; tradingsymbol: string } | null = null;
  try {
    const resp = await fetch('https://api.kite.trade/instruments/NSE', { headers: { Authorization: `token ${apiKey}:${token}` } });
    const csv = await resp.text();
    vixToken = findIndiaVixToken(csv);
    results.vixInstrument = { status: resp.status, found: vixToken };
  } catch (err: any) {
    results.vixInstrument = { error: err.message };
  }

  if (vixToken) {
    const today = new Date();
    const from = new Date(today.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);
    for (const interval of ['15minute', 'minute', 'day']) {
      try {
        const candles = await kiteFetch(`/instruments/historical/${vixToken.instrument_token}/${interval}?from=${from}&to=${to}`, { token, apiKey });
        const rows: any[] = candles?.data?.candles ?? [];
        (results.vixHistorical ??= {} as Record<string, unknown>);
        (results.vixHistorical as Record<string, unknown>)[interval] = {
          count: rows.length,
          firstTwo: rows.slice(0, 2),
          lastTwo: rows.slice(-2),
        };
      } catch (err: any) {
        (results.vixHistorical ??= {} as Record<string, unknown>);
        (results.vixHistorical as Record<string, unknown>)[interval] = { error: err.message };
      }
    }
  }

  res.status(200).json({ ok: true, probedAt: new Date().toISOString(), results });
}

export default async function handler(req: any, res: any) {
  const resource = (req.query?.resource as string) || '';
  const supabase = supabaseAdmin();

  const secret = process.env.OPTIONS_AUTOTRADE_CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (resource === 'probe') return handleProbe(req, res, supabase);

  res.status(404).json({ error: 'unknown_resource' });
}
