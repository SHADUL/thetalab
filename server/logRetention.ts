/**
 * Nightly log pruning so the Supabase free tier (0.5 GB) doesn't fill up
 * again. Once per day after 15:45 IST, deletes options_autotrade_log rows
 * older than 30 days (owner decision 2026-11-12). Positions, legs and trade
 * results live in other tables and are never touched.
 *
 * Deletes in id-bounded batches so no single statement hits Supabase's
 * statement timeout on a large backlog. Disable with LOG_RETENTION=off.
 */
import { createClient } from '@supabase/supabase-js';

export const RETENTION: Array<{ table: string; days: number }> = [
  { table: 'options_autotrade_log', days: 30 },
];
const RUN_AFTER_MIN = 15 * 60 + 45;
const BATCH = 10_000;

export async function pruneOnce(sb: ReturnType<typeof createClient>, nowMs = Date.now()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, days } of RETENTION) {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    let deleted = 0;
    for (let guard = 0; guard < 500; guard++) {
      const { data: first, error: e1 } = await sb.from(table).select('id').lt('created_at', cutoff).order('id', { ascending: true }).limit(1);
      if (e1) throw new Error(`${table}: ${e1.message}`);
      if (!first?.length) break;
      const lo = Number((first[0] as { id: number }).id);
      const { count, error: e2 } = await sb.from(table).delete({ count: 'exact' })
        .gte('id', lo).lt('id', lo + BATCH).lt('created_at', cutoff);
      if (e2) throw new Error(`${table}: ${e2.message}`);
      deleted += count ?? 0;
    }
    out[table] = deleted;
  }
  return out;
}

export function startLogRetention(): void {
  if (process.env.LOG_RETENTION === 'off') return;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  let lastRunDay = '';
  let running = false;
  setInterval(async () => {
    const ist = new Date(Date.now() + 330 * 60_000);
    const day = ist.toISOString().slice(0, 10);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (minute < RUN_AFTER_MIN || day === lastRunDay || running) return;
    running = true;
    try {
      const sb = createClient(url, key, { auth: { persistSession: false } });
      const res = await pruneOnce(sb);
      lastRunDay = day;
      console.log(`[log-retention] pruned ${JSON.stringify(res)}`);
    } catch (e: any) {
      console.error(`[log-retention] failed: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  }, 5 * 60_000).unref();
}
