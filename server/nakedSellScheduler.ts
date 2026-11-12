/**
 * Drives the Intraday Naked Sell engine in-process: one tick every 20 s on
 * NSE trading days between 09:15 and 15:31 IST. Ticks never overlap. No
 * external cron needed. Disable with NAKED_SELL_SCHEDULER=off.
 */
import { isTradingDay } from '../src/nifty-alpha-ladder/calendar/signalCalendar.ts';

const TICK_MS = 20_000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 31;

export function startNakedSellScheduler(): void {
  if (process.env.NAKED_SELL_SCHEDULER === 'off') return;
  let busy = false;
  let lastError = '';
  setInterval(async () => {
    const now = new Date();
    const ist = new Date(now.getTime() + 330 * 60_000);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (minute < OPEN_MIN || minute > CLOSE_MIN) return;
    if (!isTradingDay(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6)))) return;
    if (busy) return;
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
}
