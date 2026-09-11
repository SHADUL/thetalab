/**
 * Connectivity check for the Swing Scanner's Supabase project — confirms
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set and the schema in
 * src/swing/schema.sql actually applied, without ever putting the
 * service_role key anywhere near the browser. Not wired into the UI;
 * hit directly while standing the data layer up.
 */
import { createClient } from '@supabase/supabase-js';

const TABLES = [
  'stocks', 'daily_ohlcv', 'weekly_ohlcv', 'indicators', 'swing_scores',
  'sector_strength', 'market_regime', 'watchlist', 'alert_rules', 'alert_events',
];

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    res.status(500).json({
      ok: false, error: 'server_misconfigured',
      message: `Missing env var(s): ${[!url && 'SUPABASE_URL', !key && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', ')}.`,
    });
    return;
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const results = {};
  for (const table of TABLES) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    results[table] = error ? { ok: false, error: error.message } : { ok: true, rowCount: count };
  }

  const allOk = Object.values(results).every((r) => r.ok);
  res.status(allOk ? 200 : 502).json({ ok: allOk, tables: results });
}
