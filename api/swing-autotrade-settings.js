/**
 * Auto-trade settings — a separate reserved fund/risk% from swing_settings
 * (manual "Add to Portfolio" adds and bot-placed trades must not compete
 * for the same money), plus the master `enabled` kill switch. GET is safe
 * to poll from the UI; PUT is the only way `enabled` ever flips, and it
 * always requires an explicit boolean from the caller — there's no path
 * that turns real order placement on as a side effect of anything else.
 */
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    res.status(500).json({ error: 'server_misconfigured', message: 'Supabase is not configured.' });
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('auto_trade_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      res.status(200).json({
        enabled: data?.enabled ?? false,
        reservedFund: data?.reserved_fund ?? 0,
        riskPct: data?.risk_pct ?? 5,
        maxPositions: data?.max_positions ?? 5,
        preset: data?.preset ?? 'balanced',
      });
      return;
    }

    if (req.method === 'PUT') {
      const { enabled, reservedFund, riskPct, maxPositions, preset } = req.body ?? {};
      if (typeof enabled !== 'boolean' || typeof reservedFund !== 'number' || typeof riskPct !== 'number'
        || typeof maxPositions !== 'number' || typeof preset !== 'string') {
        res.status(400).json({ error: 'bad_request', message: 'enabled, reservedFund, riskPct, maxPositions, preset are all required.' });
        return;
      }
      if (reservedFund < 0 || riskPct <= 0 || riskPct > 100 || maxPositions < 1 || maxPositions > 20) {
        res.status(400).json({ error: 'bad_request', message: 'Values out of range.' });
        return;
      }
      const { error } = await supabase.from('auto_trade_settings').upsert({
        id: 1, enabled, reserved_fund: reservedFund, risk_pct: riskPct, max_positions: maxPositions,
        preset, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(502).json({ error: 'supabase_error', message: err.message });
  }
}
