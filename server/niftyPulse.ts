/**
 * Wires the NIFTY PULSE live PAPER engine into the web process.
 *
 * OFF unless NIFTY_PULSE=on. When on, it observes the EXISTING shared Kite
 * WebSocket (server/marketStream.ts) — no new connection — and registers
 * interest in the NIFTY index plus ~40 nearby option contracts. The
 * strategy engine itself starts OFF and only paper-trades after an explicit
 * start from the dashboard. There is no order-placement code anywhere in
 * NIFTY PULSE.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { marketStream } from './marketStream.ts';
import { LivePulseService, type InstrumentPort } from '../src/nifty-pulse/live/service.ts';
import type { InstrumentRow } from '../src/nifty-pulse/live/liveChain.ts';
import { isTradingDay } from '../src/nifty-alpha-ladder/calendar/signalCalendar.ts';
import { TickRecorder, recorderOptionsFromEnv } from './niftyPulseRecorder.ts';
import { makePulseStore, type SupabasePulseStore } from './niftyPulseStore.ts';

let service: LivePulseService | null = null;
let store: SupabasePulseStore | null = null;
let disabledReason: string | null = 'NIFTY_PULSE is not enabled on this server';

export function getNiftyPulse(): { service: LivePulseService | null; store: SupabasePulseStore | null; disabledReason: string | null } {
  return { service, store, disabledReason };
}

function instrumentsPort(sb: SupabaseClient<any>): InstrumentPort {
  return {
    async nearestExpiry(todayIst, skipToday) {
      const { data, error } = await sb.from('options_instruments').select('expiry').eq('symbol', 'NIFTY')[skipToday ? 'gt' : 'gte']('expiry', todayIst).order('expiry').limit(1);
      if (error) throw new Error(`options_instruments: ${error.message}`);
      const row = (data as Array<{ expiry: string }> | null)?.[0];
      return row?.expiry ? String(row.expiry) : null;
    },
    async strikes(expiry, lo, hi) {
      const { data, error } = await sb.from('options_instruments').select('instrument_token,tradingsymbol,strike,option_right,expiry,lot_size')
        .eq('symbol', 'NIFTY').eq('exchange', 'NFO').eq('expiry', expiry).gte('strike', lo).lte('strike', hi);
      if (error) throw new Error(`options_instruments: ${error.message}`);
      return (data ?? []).map((r: any): InstrumentRow => ({
        token: Number(r.instrument_token), tradingsymbol: String(r.tradingsymbol), strike: Number(r.strike),
        right: r.option_right === 'CE' ? 'CE' : 'PE', expiry: String(r.expiry), lotSize: Number(r.lot_size) || 0,
      })).filter((r) => r.token > 0);
    },
  };
}

export async function startNiftyPulse(): Promise<void> {
  if (process.env.NIFTY_PULSE !== 'on') return;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, apiKey = process.env.KITE_API_KEY;
  if (!url || !key || !apiKey) { disabledReason = 'Supabase or Kite API key not configured'; return; }
  const sb: SupabaseClient<any> = createClient(url, key, { auth: { persistSession: false } });

  // Same single shared connection: start() is idempotent (the Naked Sell scheduler normally starts it first).
  marketStream.start(async () => {
    const { data } = await sb.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
    const t = (data as { access_token?: string } | null)?.access_token;
    return t ? { apiKey, accessToken: t } : null;
  });

  let recorder: TickRecorder | null = null;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ropts = recorderOptionsFromEnv(root);
  if (ropts) {
    recorder = new TickRecorder(ropts);
    try { await recorder.start(); } catch (e) { console.error(`[nifty-pulse] recorder failed to start: ${(e as Error).message}`); recorder = null; }
  }

  store = makePulseStore();
  service = new LivePulseService({
    stream: marketStream,
    instruments: instrumentsPort(sb),
    isTradingDay: (d) => isTradingDay(new Date(`${d}T06:00:00Z`)),
    recorder,
    store,
    log: (m) => console.error(`[nifty-pulse] ${m}`),
  });
  service.start();
  disabledReason = null;
  console.log(`[nifty-pulse] live paper service started (engine OFF; recorder ${recorder ? 'on' : 'off'})`);
}
