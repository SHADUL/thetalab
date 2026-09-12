/**
 * Global fund + risk settings for the Swing Scanner's position sizing
 * (spec-adjacent, not in the original 61 sections, but the same
 * transparency principle: shares are computed from these two numbers,
 * never guessed). Singleton row — this app tracks one fund, not one per
 * user, matching every other "no multi-user concept" table in this schema.
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
      const { data, error } = await supabase.from('swing_settings').select('total_fund,risk_pct').eq('id', 1).maybeSingle();
      if (error) throw error;
      res.status(200).json({ totalFund: data?.total_fund ?? 0, riskPct: data?.risk_pct ?? 5 });
      return;
    }

    if (req.method === 'PUT') {
      const { totalFund, riskPct } = req.body ?? {};
      if (typeof totalFund !== 'number' || typeof riskPct !== 'number') {
        res.status(400).json({ error: 'bad_request', message: 'totalFund and riskPct are required numbers.' });
        return;
      }
      if (totalFund < 0 || riskPct <= 0 || riskPct > 100) {
        res.status(400).json({ error: 'bad_request', message: 'totalFund must be >= 0 and riskPct must be between 0 and 100.' });
        return;
      }
      const { error } = await supabase.from('swing_settings')
        .upsert({ id: 1, total_fund: totalFund, risk_pct: riskPct, updated_at: new Date().toISOString() });
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(502).json({ error: 'supabase_error', message: err.message });
  }
}
