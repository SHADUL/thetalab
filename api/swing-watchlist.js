/**
 * "My Portfolio" for the Swing Scanner (spec §37/§46) — tracked positions
 * with performance measured since the moment they were added, not since
 * some other reference point. Entirely separate from the options side's
 * own Portfolio (different table, different data, different concept:
 * option legs vs equity swing positions) — they just happen to share the
 * word "portfolio" because that's what each one actually is.
 *
 * GET returns every tracked symbol joined with the latest scored date's
 * price/score. POST adds one, capturing today's price and score as the
 * entry point — that capture only ever happens once, at add time; it's
 * never overwritten by a later re-add (upsert here would silently reset
 * "since when" every time, which defeats the point of tracking since).
 * DELETE removes one.
 */
import { createClient } from '@supabase/supabase-js';

function deriveStatus({ pnlPct, target, currentPrice, stop, scoreChange }) {
  if (currentPrice != null && stop != null && currentPrice <= stop) return 'STOP_RISK';
  if (currentPrice != null && target != null && currentPrice >= target) return 'TARGET_HIT';
  if (pnlPct != null && pnlPct >= 8) return 'NEAR_TARGET';
  if (scoreChange != null && scoreChange <= -10) return 'WEAKENING';
  return 'HOLD';
}

async function latestScoredDate(supabase) {
  const { data } = await supabase.from('swing_scores').select('date')
    .eq('preset', 'balanced').order('date', { ascending: false }).limit(1).maybeSingle();
  return data?.date ?? null;
}

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
      const { data: watchRows, error: watchErr } = await supabase.from('watchlist').select('*').order('added_at', { ascending: false });
      if (watchErr) throw watchErr;
      if (!watchRows.length) { res.status(200).json({ date: null, positions: [] }); return; }

      const symbols = watchRows.map((w) => w.symbol);
      const date = await latestScoredDate(supabase);

      const [{ data: stocksData, error: stocksErr }, scoresResult, ohlcvResult] = await Promise.all([
        supabase.from('stocks').select('symbol,name,sector').in('symbol', symbols),
        date ? supabase.from('swing_scores').select('symbol,swing_score,entry_status,target,stop')
          .eq('date', date).eq('preset', 'balanced').in('symbol', symbols) : { data: [] },
        date ? supabase.from('daily_ohlcv').select('symbol,close').eq('date', date).in('symbol', symbols) : { data: [] },
      ]);
      if (stocksErr) throw stocksErr;
      if (scoresResult.error) throw scoresResult.error;
      if (ohlcvResult.error) throw ohlcvResult.error;

      const stocksBySymbol = new Map(stocksData.map((s) => [s.symbol, s]));
      const scoresBySymbol = new Map((scoresResult.data ?? []).map((s) => [s.symbol, s]));
      const closeBySymbol = new Map((ohlcvResult.data ?? []).map((r) => [r.symbol, r.close]));

      const positions = watchRows.map((w) => {
        const meta = stocksBySymbol.get(w.symbol);
        const score = scoresBySymbol.get(w.symbol);
        const currentPrice = closeBySymbol.get(w.symbol) ?? null;
        const pnlPct = w.entry_price != null && currentPrice != null ? ((currentPrice - w.entry_price) / w.entry_price) * 100 : null;
        const scoreChange = w.entry_swing_score != null && score?.swing_score != null ? score.swing_score - w.entry_swing_score : null;
        const daysHeld = w.entry_date && date
          ? Math.max(0, Math.round((new Date(date) - new Date(w.entry_date)) / 86_400_000)) : null;
        const distanceToTargetPct = score?.target != null && currentPrice != null
          ? ((score.target - currentPrice) / currentPrice) * 100 : null;

        return {
          symbol: w.symbol, name: meta?.name ?? w.symbol, sector: meta?.sector ?? null,
          entryDate: w.entry_date, entryPrice: w.entry_price, entrySwingScore: w.entry_swing_score,
          currentPrice, currentSwingScore: score?.swing_score ?? null, entryStatus: score?.entry_status ?? null,
          target: score?.target ?? null, stop: score?.stop ?? null,
          pnlPct, scoreChange, daysHeld, distanceToTargetPct,
          status: deriveStatus({ pnlPct, target: score?.target, currentPrice, stop: score?.stop, scoreChange }),
        };
      });

      res.status(200).json({ date, positions });
      return;
    }

    if (req.method === 'POST') {
      const { symbol } = req.body ?? {};
      if (!symbol) { res.status(400).json({ error: 'bad_request', message: 'symbol is required.' }); return; }

      const { data: existing } = await supabase.from('watchlist').select('symbol').eq('symbol', symbol).maybeSingle();
      if (existing) { res.status(200).json({ ok: true, alreadyTracked: true }); return; }

      const date = await latestScoredDate(supabase);
      if (!date) { res.status(409).json({ error: 'no_data', message: 'No scored data yet — run the scoring pipeline first.' }); return; }

      const [{ data: scoreRow }, { data: ohlcvRow }] = await Promise.all([
        supabase.from('swing_scores').select('swing_score').eq('symbol', symbol).eq('date', date).eq('preset', 'balanced').maybeSingle(),
        supabase.from('daily_ohlcv').select('close').eq('symbol', symbol).eq('date', date).maybeSingle(),
      ]);

      const { error } = await supabase.from('watchlist').insert({
        symbol, entry_date: date, entry_price: ohlcvRow?.close ?? null, entry_swing_score: scoreRow?.swing_score ?? null,
      });
      if (error) throw error;
      res.status(200).json({ ok: true, alreadyTracked: false });
      return;
    }

    if (req.method === 'DELETE') {
      const { symbol } = req.query;
      if (!symbol) { res.status(400).json({ error: 'bad_request', message: 'symbol is required.' }); return; }
      const { error } = await supabase.from('watchlist').delete().eq('symbol', symbol);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(502).json({ error: 'supabase_error', message: err.message });
  }
}
