/**
 * Drives the Intraday Naked Sell engine in-process on NSE trading days
 * between 09:15 and 15:31 IST. Ticks never overlap. No external cron.
 *
 *   every 20 s — full tick: trend + entries (once a minute), reload open
 *                positions, subscribe their contracts on the live stream,
 *                REST fallback exits
 *   every 1 s  — live exit check (SL / TP / trend flip / square-off) from
 *                in-memory WebSocket prices; no Kite REST, no DB read
 *
 * Also starts the shared live-price WebSocket (server/marketStream.ts).
 * Disable with NAKED_SELL_SCHEDULER=off.
 */
import { createClient } from '@supabase/supabase-js';
import { isTradingDay } from '../src/nifty-alpha-ladder/calendar/signalCalendar.ts';
import { marketStream } from './marketStream.ts';

const TICK_MS = 20_000;
const FAST_MS = 1_000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 31;

function inSession(now: Date): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minute < OPEN_MIN || minute > CLOSE_MIN) return false;
  return isTradingDay(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6)));
}

export function startNakedSellScheduler(): void {
  if (process.env.NAKED_SELL_SCHEDULER === 'off') return;

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, apiKey = process.env.KITE_API_KEY;
  if (url && key && apiKey) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    marketStream.start(async () => {
      const { data } = await sb.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
      return data?.access_token ? { apiKey, accessToken: data.access_token } : null;
    });
  }

  let busy = false;
  let lastError = '';
  setInterval(async () => {
    const now = new Date();
    if (!inSession(now) || busy) return;
    busy = true;
    try {
      const mod = await import('../api/naked-sell.ts');
      await mod.runTick(mod.makeClient(), now.getTime());
      lastError = '';
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg !== lastError) console.error(`[naked-sell] tick failed: ${msg}`);
      lastError = msg;
    } finally {
      busy = false;
    }
  }, TICK_MS).unref();

  let fastClient: any = null;
  let lastFastError = '';
  setInterval(async () => {
    const now = new Date();
    if (!inSession(now)) return;
    try {
      const mod = await import('../api/naked-sell.ts');
      fastClient ??= mod.makeClient();
      await mod.runFastExitCheck(fastClient, now.getTime());
      lastFastError = '';
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg !== lastFastError) console.error(`[naked-sell] live exit check failed: ${msg}`);
      lastFastError = msg;
    }
  }, FAST_MS).unref();
}
