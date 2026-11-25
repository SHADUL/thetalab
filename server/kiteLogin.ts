/**
 * Is the Kite login valid right now? One read-only GET /user/profile at most
 * once a minute (only while someone is looking at the site). Used for the
 * site-wide "Kite is not logged in" banner from 08:30 on trading days.
 * The token is never returned or logged.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isTradingDay } from '../src/nifty-alpha-ladder/calendar/signalCalendar.ts';

export interface KiteLoginView { ok: boolean | null; checkedAt: number | null; obtainedAt: string | null; alert: boolean; message: string | null }

const CHECK_EVERY_MS = 60_000;
const ALERT_FROM = 8 * 60 + 30, ALERT_TO = 15 * 60 + 30;
let sb: SupabaseClient<any> | null = null;
let last: { ok: boolean | null; at: number; obtainedAt: string | null } = { ok: null, at: 0, obtainedAt: null };
let busy: Promise<void> | null = null;

async function check() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, apiKey = process.env.KITE_API_KEY;
  if (!url || !key || !apiKey) { last = { ok: null, at: Date.now(), obtainedAt: null }; return; }
  sb ??= createClient(url, key, { auth: { persistSession: false } });
  const { data } = await sb.from('kite_session').select('access_token,obtained_at').eq('id', 1).maybeSingle();
  const row = data as { access_token?: string; obtained_at?: string } | null;
  if (!row?.access_token) { last = { ok: false, at: Date.now(), obtainedAt: null }; return; }
  const r = await fetch('https://api.kite.trade/user/profile', { headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${row.access_token}` }, signal: AbortSignal.timeout(8_000) });
  // 403 = token expired / logged out. Anything else (network, 5xx) is "unknown", not an alert.
  last = { ok: r.ok ? true : r.status === 403 ? false : last.ok, at: Date.now(), obtainedAt: row.obtained_at ?? null };
}

export function alertMessage(minuteIst: number): string {
  if (minuteIst < 9 * 60 + 14) return 'Kite is not logged in. Log in before 08:45 so NIFTY ASCENT can load yesterday\'s prices and the live price feed can start.';
  if (minuteIst <= 9 * 60 + 45) return 'Kite is not logged in. Log in now: NIFTY ASCENT can still rebuild today\'s session if you log in before 09:46. Live prices and Naked Sell are stopped until you do.';
  return 'Kite is not logged in. No live prices, entries or exits can happen until you log in (NIFTY ASCENT can no longer trade today).';
}

export async function kiteLoginStatus(nowMs = Date.now()): Promise<KiteLoginView> {
  if (nowMs - last.at >= CHECK_EVERY_MS) {
    busy ??= check().catch(() => { last = { ...last, at: Date.now() }; }).finally(() => { busy = null; });
    if (last.at === 0) await busy; // first call: wait for a real answer
  }
  const ist = new Date(nowMs + 330 * 60_000);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const tradingDay = isTradingDay(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6)));
  const alert = last.ok === false && tradingDay && minute >= ALERT_FROM && minute <= ALERT_TO;
  return { ok: last.ok, checkedAt: last.at || null, obtainedAt: last.obtainedAt, alert, message: alert ? alertMessage(minute) : null };
}
