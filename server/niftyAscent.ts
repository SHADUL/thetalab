/**
 * Wires the NIFTY ASCENT live service into the web process.
 *   NIFTY_ASCENT unset  → nothing runs.
 *   NIFTY_ASCENT=observe → observe only (engine PAUSED, cannot start).
 *   NIFTY_ASCENT=paper   → live PAPER mode (Phase 4): still starts PAUSED every
 *                          day; trades paper only after START / owner auto-start;
 *                          needs the database tables and the single-engine lease.
 *
 *  - Market data: observes ThetaLab's EXISTING shared Kite WebSocket
 *    (server/marketStream.ts) — no new connection, same Kite session.
 *  - History: one read-only GET of the previous session's NIFTY minute bars
 *    through the process-wide Kite throttle.
 *  - Instruments: read from the existing options_instruments table.
 *  - The engine is created PAUSED and cannot be started in this phase;
 *    there is no order path, no database write and no API.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { marketStream } from './marketStream.ts';
import { isTradingDay } from '../src/nifty-alpha-ladder/calendar/signalCalendar.ts';
import { LiveAscentService, type InstrumentPort } from '../src/nifty-ascent/live/service.ts';
import type { Instrument } from '../src/nifty-ascent/core/contracts.ts';
import { ObserveArchive, archiveOptionsFromEnv } from './niftyAscentArchive.ts';
import { makeAscentStore, type SupabaseAscentStore } from './niftyAscentStore.ts';
import { AscentHistory } from './niftyAscentHistory.ts';

const KITE_REST = 'https://api.kite.trade';
let service: LiveAscentService | null = null;
let archive: ObserveArchive | null = null;
let store: SupabaseAscentStore | null = null;
let history: AscentHistory | null = null;

export function getNiftyAscent(): { service: LiveAscentService | null; archive: ObserveArchive | null; store: SupabaseAscentStore | null; history: AscentHistory | null } { return { service, archive, store, history }; }

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
  const flag = process.env.NIFTY_ASCENT;
  if (flag !== 'observe' && flag !== 'paper') return;
  const mode = flag === 'paper' ? 'PAPER' as const : 'OBSERVE' as const;
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
    if (!/^\/instruments\/historical\/\d+\/(minute|day)\?/.test(path)) throw new Error('only historical minute/day reads are allowed');
    const t = await session();
    if (!t) throw new Error('no Kite session');
    const resp = await fetch(`${KITE_REST}${path}`, { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${t}` }, signal: AbortSignal.timeout(15_000) });
    const json: any = await resp.json().catch(() => null);
    if (!resp.ok || json?.status === 'error') throw new Error(`Kite historical ${resp.status}${json?.error_type ? ` ${json.error_type}` : ''}`);
    return json?.data;
  };

  // Persistent archive outside the app release folder (bind-mounted volume). Best-effort: if it is
  // not writable the service still runs and the full report remains in the container log.
  archive = new ObserveArchive(archiveOptionsFromEnv());
  if (!(await archive.start())) console.error(`[nifty-ascent] archive NOT writable (${archive.status().dir}): ${archive.lastError} — reports only in the log`);
  const a = archive;
  if (mode === 'PAPER') {
    store = makeAscentStore();
    if (!store) { console.error('[nifty-ascent] PAPER mode needs Supabase — not started'); return; }
  }
  // Backtest data (real NIFTY candles, cached on the persistent archive disk).
  history = new AscentHistory({ dir: `${archiveOptionsFromEnv().dir}/history`, fetchData, isTradingDay: (d) => isTradingDay(new Date(`${d}T06:00:00Z`)) });
  service = new LiveAscentService({
    mode, store: store ?? undefined, holder: `web-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    stream: marketStream,
    fetchData,
    instruments: instrumentPort(sb),
    isTradingDay: (d) => isTradingDay(new Date(`${d}T06:00:00Z`)),
    log: (m) => { console.log(`[nifty-ascent] ${m}`); a.event(m); },
    saveReport: (date, report) => a.report(date, report),
    recordTick: (row, exchTs) => a.tick(row, exchTs),
  });
  service.start();
  console.log(mode === 'PAPER'
    ? `[nifty-ascent] LIVE PAPER service started (engine PAUSED until START/auto-start; paper fills only — no order code) · archive ${JSON.stringify(a.status())}`
    : `[nifty-ascent] observe-only live data service started (engine PAUSED, no execution) · archive ${JSON.stringify(a.status())}`);
}
