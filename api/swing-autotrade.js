/**
 * Auto Trade tab's one endpoint — GET (positions + settings + activity
 * log) and PUT (save settings, including the enabled kill switch) folded
 * together to stay under Vercel Hobby's 12-serverless-function cap rather
 * than splitting them, which would otherwise be the more obvious shape.
 *
 * GET: currently open/recently closed bot positions (joined with today's
 * price/score, same shape as swing-watchlist.js's positions), the current
 * settings (with allocated/available derived from open positions, same
 * fund-summary pattern as swing-watchlist.js), and the recent activity
 * log — the straight audit trail of every order the bot placed, skipped,
 * or failed, so "what did the bot do" is never a guess.
 *
 * PUT: replaces the singleton settings row. `enabled` always comes from
 * the caller explicitly — there's no path that flips real order placement
 * on as a side effect of saving anything else.
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
      const { data: posRows, error: posErr } = await supabase.from('auto_trade_positions')
        .select('*').order('created_at', { ascending: false }).limit(100);
      if (posErr) throw posErr;

      const symbols = [...new Set(posRows.map((p) => p.symbol))];
      const openSymbols = posRows.filter((p) => p.status === 'OPEN').map((p) => p.symbol);

      const [{ data: stocksData }, { data: scoresData }, { data: ohlcvData }, { data: settingsRow }] = await Promise.all([
        symbols.length ? supabase.from('stocks').select('symbol,name,sector').in('symbol', symbols) : Promise.resolve({ data: [] }),
        openSymbols.length ? supabase.from('swing_scores').select('symbol,swing_score,date')
          .in('symbol', openSymbols).order('date', { ascending: false }) : Promise.resolve({ data: [] }),
        openSymbols.length ? supabase.from('daily_ohlcv').select('symbol,close,date')
          .in('symbol', openSymbols).order('date', { ascending: false }) : Promise.resolve({ data: [] }),
        supabase.from('auto_trade_settings').select('*').eq('id', 1).maybeSingle(),
      ]);

      const stocksBySymbol = new Map((stocksData ?? []).map((s) => [s.symbol, s]));
      const latestScoreBySymbol = new Map();
      for (const row of scoresData ?? []) if (!latestScoreBySymbol.has(row.symbol)) latestScoreBySymbol.set(row.symbol, row.swing_score);
      const latestCloseBySymbol = new Map();
      for (const row of ohlcvData ?? []) if (!latestCloseBySymbol.has(row.symbol)) latestCloseBySymbol.set(row.symbol, row.close);

      const positions = posRows.map((p) => {
        const meta = stocksBySymbol.get(p.symbol);
        const currentPrice = p.status === 'OPEN' ? (latestCloseBySymbol.get(p.symbol) ?? null) : p.exit_price;
        const currentSwingScore = p.status === 'OPEN' ? (latestScoreBySymbol.get(p.symbol) ?? null) : null;
        const pnlPct = currentPrice != null ? ((currentPrice - p.entry_price) / p.entry_price) * 100 : null;
        const pnlAmount = currentPrice != null ? (currentPrice - p.entry_price) * p.shares : null;
        return {
          id: p.id, symbol: p.symbol, name: meta?.name ?? p.symbol, sector: meta?.sector ?? null,
          status: p.status, protection: p.protection,
          entryDate: p.entry_date, entryPrice: p.entry_price, entrySwingScore: p.entry_swing_score,
          shares: p.shares, stop: p.stop, target: p.target,
          currentPrice, currentSwingScore, pnlPct, pnlAmount,
          exitDate: p.exit_date, exitPrice: p.exit_price, exitReason: p.exit_reason,
        };
      });

      const allocated = positions.filter((p) => p.status === 'OPEN')
        .reduce((sum, p) => sum + p.shares * p.entryPrice, 0);

      const { data: logRows, error: logErr } = await supabase.from('auto_trade_log')
        .select('*').order('at', { ascending: false }).limit(100);
      if (logErr) throw logErr;

      res.status(200).json({
        positions,
        settings: settingsRow ? {
          enabled: settingsRow.enabled, reservedFund: settingsRow.reserved_fund, riskPct: settingsRow.risk_pct,
          maxPositions: settingsRow.max_positions, preset: settingsRow.preset,
          allocated, available: settingsRow.reserved_fund - allocated,
        } : null,
        log: logRows,
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
