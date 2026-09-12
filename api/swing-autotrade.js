/**
 * Auto Trade tab's one endpoint — GET (positions + settings + activity
 * log), PUT (save settings, including the enabled kill switch), and POST
 * (two real broker actions: panic_halt, exit_position) folded together to
 * stay under Vercel Hobby's 12-serverless-function cap rather than
 * splitting them, which would otherwise be the more obvious shape.
 *
 * GET: currently open/recently closed bot positions (joined with today's
 * price/score, same shape as swing-watchlist.js's positions), the current
 * settings (with allocated/available derived from open positions, same
 * fund-summary pattern as swing-watchlist.js), the Kite session's age (for
 * the UI's session-validity countdown), and the recent activity log — the
 * straight audit trail of every order the bot placed, skipped, or failed,
 * so "what did the bot do" is never a guess.
 *
 * PUT: replaces the singleton settings row. `enabled` always comes from
 * the caller explicitly — there's no path that flips real order placement
 * on as a side effect of saving anything else.
 *
 * POST: manual overrides a human can reach for without waiting on the
 * next cron tick. 'panic_halt' disables the switch and cancels every open
 * position's protective order (GTT or fallback SL-M) WITHOUT selling the
 * underlying shares — it stops the bot and removes pending orders, it
 * does not force an exit. 'exit_position' is the deliberate, explicit
 * version of that for one position: cancels its protection AND places a
 * market sell to actually flatten it.
 */
import { createClient } from '@supabase/supabase-js';

const KITE_BASE = 'https://api.kite.trade';

async function kiteFetch(path, { method = 'GET', token, apiKey, body } = {}) {
  const resp = await fetch(`${KITE_BASE}${path}`, {
    method,
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${apiKey}:${token}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') {
    throw new Error(json?.message || `Kite API error (${resp.status}) on ${path}`);
  }
  return json?.data;
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
      const { data: sessionRow } = await supabase.from('kite_session').select('obtained_at').eq('id', 1).maybeSingle();

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
          updatedAt: settingsRow.updated_at,
        } : null,
        kiteSessionObtainedAt: sessionRow?.obtained_at ?? null,
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

    if (req.method === 'POST') {
      const { action, id } = req.body ?? {};
      const apiKey = process.env.KITE_API_KEY;
      const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
      const token = session?.access_token;
      if (!apiKey || !token) {
        res.status(409).json({ error: 'no_kite_session', message: 'Connect Kite before using manual overrides.' });
        return;
      }
      const log = (level, message, detail) => supabase.from('auto_trade_log').insert({ level, message, detail: detail ?? null });

      // Cancels whatever is protecting a position (a two-leg GTT, or the
      // fallback SL-M order) without touching the shares themselves.
      const cancelProtection = async (pos) => {
        if (pos.protection === 'GTT' && pos.gtt_id != null) {
          await kiteFetch(`/gtt/triggers/${pos.gtt_id}`, { method: 'DELETE', token, apiKey });
        } else if (pos.protection === 'SL_ONLY' && pos.stop_order_id) {
          await kiteFetch(`/orders/regular/${pos.stop_order_id}`, { method: 'DELETE', token, apiKey });
        }
      };

      if (action === 'panic_halt') {
        await supabase.from('auto_trade_settings').update({ enabled: false, updated_at: new Date().toISOString() }).eq('id', 1);
        const { data: openPositions } = await supabase.from('auto_trade_positions').select('*').eq('status', 'OPEN');
        let cancelled = 0;
        for (const pos of openPositions ?? []) {
          if (pos.protection === 'NONE') continue;
          try {
            await cancelProtection(pos);
            await supabase.from('auto_trade_positions').update({ protection: 'NONE' }).eq('id', pos.id);
            await log('error', `Panic halt: cancelled protection on ${pos.symbol} — position is still open and now UNPROTECTED, manage it manually.`);
            cancelled++;
          } catch (e) {
            await log('error', `Panic halt: failed to cancel protection on ${pos.symbol}`, { error: e.message });
          }
        }
        await log('error', `Panic halt triggered from the UI — auto-trade disabled, ${cancelled} position(s) had protection cancelled.`);
        res.status(200).json({ ok: true, cancelled });
        return;
      }

      if (action === 'exit_position') {
        const { data: pos } = await supabase.from('auto_trade_positions').select('*').eq('id', id).eq('status', 'OPEN').maybeSingle();
        if (!pos) { res.status(404).json({ error: 'not_found', message: 'No open position with that id.' }); return; }
        try {
          await cancelProtection(pos);
        } catch (e) {
          await log('error', `Exit ${pos.symbol}: could not cancel existing protection first, placing exit order anyway.`, { error: e.message });
        }
        let exitPrice = pos.entry_price;
        try {
          const orderRes = await kiteFetch('/orders/regular', {
            method: 'POST', token, apiKey,
            body: { tradingsymbol: pos.symbol, exchange: 'NSE', transaction_type: 'SELL', order_type: 'MARKET', quantity: String(pos.shares), product: 'CNC', validity: 'DAY' },
          });
          await new Promise((r) => setTimeout(r, 2000));
          const orderHistory = await kiteFetch(`/orders/${orderRes.order_id}`, { token, apiKey });
          const filled = (orderHistory ?? []).find((o) => o.status === 'COMPLETE');
          if (filled) exitPrice = filled.average_price;
        } catch (e) {
          await log('error', `Manual exit order failed for ${pos.symbol} — position is UNPROTECTED (its GTT/stop was already cancelled) and still open. Retry the exit or manage it directly in Kite.`, { error: e.message });
          res.status(502).json({ error: 'exit_failed', message: e.message });
          return;
        }
        await supabase.from('auto_trade_positions').update({
          status: 'CLOSED', protection: 'NONE', exit_date: new Date().toISOString().slice(0, 10), exit_price: exitPrice, exit_reason: 'MANUAL',
        }).eq('id', pos.id);
        await log('info', `Manually exited ${pos.symbol}: ${pos.shares} shares @ ₹${exitPrice}.`);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'bad_request', message: 'Unknown action.' });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(502).json({ error: 'supabase_error', message: err.message });
  }
}
