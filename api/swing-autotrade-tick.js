/**
 * The auto-trader's heartbeat — called every ~5 min during market hours by
 * a GitHub Actions cron (see .github/workflows/swing-autotrade-tick.yml),
 * not Vercel's own cron, to avoid depending on plan-specific interval
 * limits. Protected by a shared secret so nothing else can trigger it.
 *
 * Kite's two-leg GTT is broker-side: once placed, Zerodha's own systems
 * execute the stop/target regardless of whether this function is running
 * at that moment. So this tick only needs to do two things: notice when a
 * GTT has fired (closing our record of that position), and — if that
 * freed a slot under max_positions — enter the next best-ranked stock not
 * already held, sized against the reserved fund/risk%, then protect it
 * with a fresh two-leg GTT.
 *
 * Safety posture: `auto_trade_settings.enabled` is a hard gate checked
 * first, every action is logged to auto_trade_log (this IS the audit
 * trail, not a summary of one), and if GTT placement fails after an entry
 * has already filled, this falls back to a plain SL-M stop order rather
 * than leaving a position with no protection at all — logged as an error
 * either way, since a stop-only or unprotected position needs a human to
 * notice. Verify the GTT/order payload shapes below against Kite Connect's
 * current docs before the very first live run; a mismatch fails loudly
 * into the log rather than silently placing something wrong.
 */
import { createClient } from '@supabase/supabase-js';

const KITE_BASE = 'https://api.kite.trade';
const MAX_ENTRY_DRIFT_PCT = 3; // skip an entry if live price has drifted this far from the scan-time reference

function isMarketOpenIST(now = new Date()) {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

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
  const secret = process.env.AUTOTRADE_CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.KITE_API_KEY;
  if (!url || !key || !apiKey) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const log = (level, message, detail) => supabase.from('auto_trade_log').insert({ level, message, detail: detail ?? null });

  if (!isMarketOpenIST()) { res.status(200).json({ ok: true, skipped: 'outside_market_hours' }); return; }

  const { data: settings } = await supabase.from('auto_trade_settings').select('*').eq('id', 1).maybeSingle();
  if (!settings?.enabled) { res.status(200).json({ ok: true, skipped: 'disabled' }); return; }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) {
    await log('error', 'Auto-trade is enabled but there is no Kite session — log in before market open for the bot to act today.');
    res.status(200).json({ ok: true, skipped: 'no_kite_session' });
    return;
  }

  try {
    // 1. Reconcile open positions against their protective orders.
    let gttsBySymbol = new Map();
    try {
      const gtts = await kiteFetch('/gtt/triggers', { token, apiKey });
      gttsBySymbol = new Map((gtts ?? []).map((g) => [g.id, g]));
    } catch (e) {
      await log('error', 'Could not fetch GTT list from Kite this tick — skipping exit reconciliation.', { error: e.message });
    }

    const { data: openPositions } = await supabase.from('auto_trade_positions').select('*').eq('status', 'OPEN');
    for (const pos of openPositions ?? []) {
      if (pos.protection === 'GTT' && pos.gtt_id != null) {
        const gtt = gttsBySymbol.get(pos.gtt_id);
        if (!gtt || gtt.status === 'active') continue; // still live, or list fetch failed — leave it for next tick
        await supabase.from('auto_trade_positions').update({
          status: 'CLOSED', exit_date: new Date().toISOString().slice(0, 10), exit_reason: `GTT_${gtt.status.toUpperCase()}`,
        }).eq('id', pos.id);
        await log('info', `Position closed: ${pos.symbol} (GTT ${gtt.status})`, { gttId: pos.gtt_id });
      } else if (pos.protection === 'SL_ONLY' && pos.stop_order_id) {
        try {
          const orderHistory = await kiteFetch(`/orders/${pos.stop_order_id}`, { token, apiKey });
          const filled = (orderHistory ?? []).find((o) => o.status === 'COMPLETE');
          if (filled) {
            await supabase.from('auto_trade_positions').update({
              status: 'CLOSED', exit_date: new Date().toISOString().slice(0, 10),
              exit_price: filled.average_price, exit_reason: 'STOP',
            }).eq('id', pos.id);
            await log('info', `Position closed: ${pos.symbol} (fallback stop filled @ ₹${filled.average_price})`);
          }
        } catch (e) {
          await log('error', `Could not check fallback stop order for ${pos.symbol}`, { error: e.message });
        }
      } else if (pos.protection === 'NONE') {
        await log('error', `${pos.symbol} has NO protective order (GTT and fallback both failed at entry) — needs manual attention.`);
      }
    }

    // 2. How many slots are free after reconciliation?
    const { data: stillOpen } = await supabase.from('auto_trade_positions').select('symbol,shares,entry_price').eq('status', 'OPEN');
    const openSymbols = new Set((stillOpen ?? []).map((p) => p.symbol));
    const allocated = (stillOpen ?? []).reduce((sum, p) => sum + p.shares * p.entry_price, 0);
    let availableFund = settings.reserved_fund - allocated;
    const freeSlots = settings.max_positions - openSymbols.size;
    if (freeSlots <= 0) { res.status(200).json({ ok: true, openPositions: openSymbols.size, placed: 0 }); return; }

    // 3. Rank today's candidates, excluding what's already held.
    const { data: latestDateRow } = await supabase.from('swing_scores').select('date')
      .eq('preset', settings.preset).order('date', { ascending: false }).limit(1).maybeSingle();
    const date = latestDateRow?.date;
    if (!date) { res.status(200).json({ ok: true, skipped: 'no_scores' }); return; }

    const { data: candidates } = await supabase.from('swing_scores')
      .select('symbol,swing_score,entry,stop,target,entry_status')
      .eq('date', date).eq('preset', settings.preset)
      .not('entry', 'is', null).not('stop', 'is', null)
      .order('swing_score', { ascending: false }).limit(50);

    const ranked = (candidates ?? []).filter((c) => !openSymbols.has(c.symbol) && c.entry_status !== 'AVOID' && c.entry > c.stop);

    let placed = 0;
    for (const cand of ranked) {
      if (placed >= freeSlots) break;

      // Guard against a stale reference price — a live LTP check before risking real money.
      let livePrice = cand.entry;
      try {
        const quote = await kiteFetch(`/quote?i=${encodeURIComponent(`NSE:${cand.symbol}`)}`, { token, apiKey });
        livePrice = quote?.[`NSE:${cand.symbol}`]?.last_price ?? cand.entry;
      } catch (e) {
        await log('error', `Could not fetch live quote for ${cand.symbol} — skipping this tick.`, { error: e.message });
        continue;
      }
      const drift = Math.abs(livePrice - cand.entry) / cand.entry * 100;
      if (drift > MAX_ENTRY_DRIFT_PCT) {
        await log('info', `Skipped ${cand.symbol}: live price ₹${livePrice} has drifted ${drift.toFixed(1)}% from scan reference ₹${cand.entry}.`);
        continue;
      }

      const riskAmount = (settings.reserved_fund * settings.risk_pct) / 100;
      const slPoints = cand.entry - cand.stop;
      const sharesByRisk = Math.floor(riskAmount / slPoints);
      const sharesByFund = Math.floor(Math.max(0, availableFund) / livePrice);
      const shares = Math.max(0, Math.min(sharesByRisk, sharesByFund));
      if (shares <= 0) continue;

      let orderId;
      try {
        const orderRes = await kiteFetch('/orders/regular', {
          method: 'POST', token, apiKey,
          body: { tradingsymbol: cand.symbol, exchange: 'NSE', transaction_type: 'BUY', order_type: 'MARKET', quantity: String(shares), product: 'CNC', validity: 'DAY' },
        });
        orderId = orderRes.order_id;
      } catch (e) {
        await log('error', `Entry order failed for ${cand.symbol}`, { error: e.message });
        continue;
      }

      let fillPrice = livePrice;
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const orderHistory = await kiteFetch(`/orders/${orderId}`, { token, apiKey });
        const filled = (orderHistory ?? []).find((o) => o.status === 'COMPLETE');
        if (filled) fillPrice = filled.average_price;
      } catch (e) {
        await log('error', `Could not confirm fill price for ${cand.symbol} order ${orderId} — using live quote as estimate.`, { error: e.message });
      }

      const stopDistance = cand.entry - cand.stop;
      const finalStop = Math.round((fillPrice - stopDistance) * 100) / 100;
      const finalTarget = Math.round(fillPrice * 1.10 * 100) / 100;

      let gttId = null;
      let stopOrderId = null;
      let protection = 'NONE';
      try {
        const gttRes = await kiteFetch('/gtt/triggers', {
          method: 'POST', token, apiKey,
          body: {
            type: 'two-leg',
            condition: JSON.stringify({ exchange: 'NSE', tradingsymbol: cand.symbol, trigger_values: [finalStop, finalTarget], last_price: fillPrice }),
            orders: JSON.stringify([
              { exchange: 'NSE', tradingsymbol: cand.symbol, transaction_type: 'SELL', quantity: shares, order_type: 'LIMIT', product: 'CNC', price: finalStop },
              { exchange: 'NSE', tradingsymbol: cand.symbol, transaction_type: 'SELL', quantity: shares, order_type: 'LIMIT', product: 'CNC', price: finalTarget },
            ]),
          },
        });
        gttId = gttRes.trigger_id;
        protection = 'GTT';
      } catch (e1) {
        await log('error', `GTT placement failed for ${cand.symbol}, trying a fallback stop-only order.`, { error: e1.message });
        try {
          const slOrder = await kiteFetch('/orders/regular', {
            method: 'POST', token, apiKey,
            body: { tradingsymbol: cand.symbol, exchange: 'NSE', transaction_type: 'SELL', order_type: 'SL-M', trigger_price: String(finalStop), quantity: String(shares), product: 'CNC', validity: 'DAY' },
          });
          stopOrderId = slOrder.order_id;
          protection = 'SL_ONLY';
          await log('error', `${cand.symbol}: placed fallback stop-only order (${stopOrderId}) — NO target order was placed, this position needs manual target management.`);
        } catch (e2) {
          await log('error', `CRITICAL: ${cand.symbol} has NO stop-loss protection — both GTT and fallback SL-M failed. Manual intervention required now.`, { error: e2.message });
        }
      }

      await supabase.from('auto_trade_positions').insert({
        symbol: cand.symbol, status: 'OPEN', entry_order_id: orderId, gtt_id: gttId, stop_order_id: stopOrderId, protection,
        entry_date: date, entry_price: fillPrice, entry_swing_score: cand.swing_score,
        shares, stop: finalStop, target: finalTarget,
      });
      await log('info', `Entered ${cand.symbol}: ${shares} shares @ ₹${fillPrice}, stop ₹${finalStop}, target ₹${finalTarget} (${protection}).`, { orderId, gttId, stopOrderId });

      availableFund -= shares * fillPrice;
      placed++;
    }

    res.status(200).json({ ok: true, placed });
  } catch (err) {
    await log('error', 'Tick failed unexpectedly.', { error: err.message });
    res.status(502).json({ error: 'tick_failed', message: err.message });
  }
}
