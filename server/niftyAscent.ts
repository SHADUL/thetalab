/**
 * Wires NIFTY ASCENT's Phase 3 OBSERVE-ONLY live service into the web
 * process. Does nothing unless NIFTY_ASCENT=observe.
 *
 *  - Market data: observes ThetaLab's EXISTING shared Kite WebSocket
 *    (server/marketStream.ts) — no new connection, same Kite session.
 *  - History: one read-only GET of the previous session's NIFTY minute bars
 *    through the process-wide Kite throttle.
 *  - Instruments: read from the existing options_instruments table.
 *  - The engine is created PAUSED and cannot be started in this phase;
 *    there is no order path, no database write and no API.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { marketStream } from './marketStream.ts';
import { isTradingDay } from '../src/nifty-alpha-ladder/calendar/signalCalendar.ts';
import { LiveAscentService, type InstrumentPort } from '../src/nifty-ascent/live/service.ts';
import type { Instrument } from '../src/nifty-ascent/core/contracts.ts';

const KITE_REST = 'https://api.kite.trade';
let service: LiveAscentService | null = null;

export function getNiftyAscent(): LiveAscentService | null { return service; }

function instrumentPort(sb: SupabaseClient<any>): InstrumentPort {
  return {
    async nearestExpiries(today, n) {
      const out: string[] = [];
      let from = today, op: 'gte' | 'gt' = 'gte';
      // One row per lookup: a multi-row read of a single expiry can hold hundreds of strikes.
      for (let i = 0; i < n; i++) {
        const { data, error } = await sb.from('options_instruments').select('expiry').eq('symbol', 'NIFTY').eq('exchange', 'NFO')[op]('expiry', from).order('expiry').limit(1);
        if (error) throw new Error(`options_instruments: ${error.message}`);
        const e = (data as Array<{ expiry: string }> | null)?.[0]?.expiry;
        if (!e) break;
        out.push(String(e)); from = String(e); op = 'gt';
      }
      return out;
    },
    async strikes(expiry, lo, hi) {
      const { data, error } = await sb.from('options_instruments').select('instrument_token,tradingsymbol,strike,option_right,expiry,lot_size')
        .eq('symbol', 'NIFTY').eq('exchange', 'NFO').eq('expiry', expiry).gte('strike', lo).lte('strike', hi).limit(5000);
      if (error) throw new Error(`options_instruments: ${error.message}`);
      return (data ?? []).map((r: any): Instrument => ({
        token: Number(r.instrument_token), tradingsymbol: String(r.tradingsymbol), strike: Number(r.strike),
        right: r.option_right === 'CE' ? 'CE' : r.option_right === 'PE' ? 'PE' : (String(r.option_right) as any),
        expiry: String(r.expiry), lotSize: Number(r.lot_size),
      }));
    },
  };
}

export async function startNiftyAscent(): Promise<void> {
  if (process.env.NIFTY_ASCENT !== 'observe') return;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, apiKey = process.env.KITE_API_KEY;
  if (!url || !key || !apiKey) { console.error('[nifty-ascent] not started: Supabase or Kite API key not configured'); return; }
  const sb: SupabaseClient<any> = createClient(url, key, { auth: { persistSession: false } });
  const session = async () => {
    const { data } = await sb.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
    return (data as { access_token?: string } | null)?.access_token ?? null;
  };
  // Same single shared connection; start() is idempotent.
  marketStream.start(async () => { const t = await session(); return t ? { apiKey, accessToken: t } : null; });

  const fetchData = async (path: string) => {
    if (!/^\/instruments\/historical\/\d+\/minute\?/.test(path)) throw new Error('only historical minute reads are allowed');
    const t = await session();
    if (!t) throw new Error('no Kite session');
    const resp = await fetch(`${KITE_REST}${path}`, { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${t}` }, signal: AbortSignal.timeout(15_000) });
    const json: any = await resp.json().catch(() => null);
    if (!resp.ok || json?.status === 'error') throw new Error(`Kite historical ${resp.status}${json?.error_type ? ` ${json.error_type}` : ''}`);
    return json?.data;
  };

  service = new LiveAscentService({
    stream: marketStream,
    fetchData,
    instruments: instrumentPort(sb),
    isTradingDay: (d) => isTradingDay(new Date(`${d}T06:00:00Z`)),
    log: (m) => console.log(`[nifty-ascent] ${m}`),
    // The full report is also logged; this file copy is a convenience (container disk, lost on redeploy).
    saveReport: (date, report) => {
      const dir = process.env.NIFTY_ASCENT_OBSERVE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'nifty-ascent-observe');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(report, null, 2));
    },
  });
  service.start();
  console.log('[nifty-ascent] observe-only live data service started (engine PAUSED, no execution)');
}
