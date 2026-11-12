/**
 * Intraday Naked Sell — PAPER + SHADOW only. Never places a real order.
 *
 *   GET  ?resource=dashboard   settings, live trend per index, open + recent positions, stats
 *   GET  ?resource=log         recent activity
 *   POST ?resource=settings    { enabled?, paper_enabled?, shadow_enabled?, symbols?, lots?, ... }
 *   POST ?resource=close       { id }  manual close at the current quote
 *   POST ?resource=tick        cron-secret only — one engine pass (normally driven in-process
 *                              by server/nakedSellScheduler.ts every 20 s during market hours)
 *
 * One tick = (once a minute) refresh the 5-min intraday trend per index and
 * try entries, then (every tick) re-quote every open position and apply
 * SL / square-off / TP / trend-flip. Kite is used read-only: quotes,
 * 5-minute historical candles, and the basket-margin CALCULATOR for SHADOW
 * sizing realism.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_SETTINGS, intradayTrend, completedBars, sideForTrend, pickStrike, liquidityProblems, entryFill, exitFill,
  midOf, levels, checkExit, roundTripCharges, shortPnl, entryBlocker, istMinuteOf, istDateOf,
  type NakedSellSettings, type Candle, type OptionQuote, type Mode, type Right, type Trend, type ExitReason,
} from '../src/naked-sell/engine.ts';

type Req = { method?: string; query: Record<string, unknown>; body?: any; headers: Record<string, string | undefined> };
type Res = { status(code: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void };

const KITE = 'https://api.kite.trade';
const INDEX: Record<string, { quoteKey: string; optExchange: 'NFO' | 'BFO' }> = {
  NIFTY: { quoteKey: 'NSE:NIFTY 50', optExchange: 'NFO' },
  SENSEX: { quoteKey: 'BSE:SENSEX', optExchange: 'BFO' },
};
/** SHADOW's notional capital for the margin sanity check (same figure the main engine uses for SHADOW). */
const SHADOW_CAPITAL = 500_000;
const STRIKE_WINDOW_PCT = 4;

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function isMissingTable(err: any) {
  return err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message ?? ''));
}

export function makeClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(500, 'server_misconfigured', 'Supabase is not configured.');
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (input: any, init?: any) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }) },
  });
}

/* ------------------------------------------------------------------ */
/* Kite (read-only)                                                     */
/* ------------------------------------------------------------------ */

interface KiteCtx { apiKey: string; token: string }

async function kiteCtx(sb: SupabaseClient): Promise<KiteCtx | null> {
  const apiKey = process.env.KITE_API_KEY;
  const { data } = await sb.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  return apiKey && data?.access_token ? { apiKey, token: data.access_token } : null;
}

async function kite(path: string, k: KiteCtx, init?: { method: string; body: string }): Promise<any> {
  const resp = await fetch(`${KITE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'X-Kite-Version': '3', Authorization: `token ${k.apiKey}:${k.token}`, ...(init ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body,
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') throw new Error(json?.message || `Kite ${resp.status} on ${path.split('?')[0]}`);
  return json?.data;
}

async function quotes(keys: string[], k: KiteCtx): Promise<Record<string, any>> {
  if (!keys.length) return {};
  const out: Record<string, any> = {};
  for (let i = 0; i < keys.length; i += 250) {
    Object.assign(out, await kite(`/quote?${keys.slice(i, i + 250).map((x) => `i=${encodeURIComponent(x)}`).join('&')}`, k));
  }
  return out;
}

function toOptionQuote(q: any, meta: { strike: number; right: Right; tradingsymbol: string }): OptionQuote {
  const b = q?.depth?.buy?.[0]?.price, a = q?.depth?.sell?.[0]?.price;
  return {
    ...meta,
    bid: b > 0 ? Number(b) : null,
    ask: a > 0 ? Number(a) : null,
    last: q?.last_price > 0 ? Number(q.last_price) : null,
    volume: q?.volume != null ? Number(q.volume) : null,
    oi: q?.oi != null ? Number(q.oi) : null,
  };
}

const kiteTs = (s: string) => s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

async function fiveMinuteBars(instrumentToken: number, nowMs: number, k: KiteCtx): Promise<Candle[]> {
  const day = istDateOf(nowMs);
  const nowIst = new Date(nowMs + 330 * 60_000).toISOString().slice(11, 19);
  const data = await kite(`/instruments/historical/${instrumentToken}/5minute?from=${day}+09:15:00&to=${day}+${nowIst}`, k);
  return (data?.candles ?? [])
    .filter((c: any) => Array.isArray(c) && c.length >= 5)
    .map((c: any) => ({ t: new Date(kiteTs(String(c[0]))).toISOString(), o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
}

/* ------------------------------------------------------------------ */
/* State helpers                                                        */
/* ------------------------------------------------------------------ */

async function loadSettings(sb: SupabaseClient): Promise<NakedSellSettings> {
  const { data, error } = await sb.from('naked_sell_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  const merged: any = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (data?.[k] != null) merged[k] = typeof (DEFAULT_SETTINGS as any)[k] === 'number' ? Number(data[k]) : data[k];
  return merged;
}

async function log(sb: SupabaseClient, message: string, extra: { level?: string; mode?: string; symbol?: string; detail?: unknown } = {}) {
  await sb.from('naked_sell_log').insert({ level: extra.level ?? 'info', mode: extra.mode ?? null, symbol: extra.symbol ?? null, message, detail: extra.detail ?? null });
}

const istDayStartUtc = (nowMs: number) => new Date(Date.parse(`${istDateOf(nowMs)}T00:00:00+05:30`)).toISOString();

/* ------------------------------------------------------------------ */
/* Tick                                                                 */
/* ------------------------------------------------------------------ */

let lastScanAt = 0;

export async function runTick(sb: SupabaseClient, nowMs = Date.now(), opts: { forceScan?: boolean } = {}) {
  const s = await loadSettings(sb);
  const k = await kiteCtx(sb);
  if (!k) return { ok: true, skipped: 'no_kite_session' };
  const minute = istMinuteOf(nowMs);
  const result: Record<string, unknown> = {};

  // 1. Trend + entries — once a minute (5-min bars only change every 5 min, but
  //    a once-a-minute check catches each close promptly).
  if (opts.forceScan || nowMs - lastScanAt >= 55_000) {
    lastScanAt = nowMs;
    result.scan = await scan(sb, s, k, nowMs, minute);
  }
  // 2. Exits — every tick.
  result.monitor = await monitor(sb, s, k, nowMs, minute);
  return { ok: true, ...result };
}

async function scan(sb: SupabaseClient, s: NakedSellSettings, k: KiteCtx, nowMs: number, minute: number) {
  const symbols = s.symbols.filter((x) => INDEX[x]);
  if (!symbols.length) return { skipped: 'no_symbols' };
  const idx = await quotes(symbols.map((x) => INDEX[x].quoteKey), k);
  const out: Record<string, unknown> = {};

  for (const symbol of symbols) {
    try {
      const iq = idx[INDEX[symbol].quoteKey];
      const spot = Number(iq?.last_price);
      if (!(spot > 0) || !iq?.instrument_token) { out[symbol] = 'no_index_quote'; continue; }
      const bars = completedBars(await fiveMinuteBars(Number(iq.instrument_token), nowMs, k), nowMs);
      const trend = intradayTrend(bars);

      const { data: prev } = await sb.from('naked_sell_trend').select('state').eq('symbol', symbol).maybeSingle();
      await sb.from('naked_sell_trend').upsert({ symbol, state: trend.state, detail: trend, spot, updated_at: new Date(nowMs).toISOString() });
      if (prev?.state !== trend.state) await log(sb, `${symbol} intraday trend → ${trend.state} (${trend.reason})`, { symbol, detail: trend });

      out[symbol] = await tryEntries(sb, s, k, symbol, spot, trend.state, trend, nowMs, minute);
    } catch (e: any) {
      out[symbol] = `error: ${e.message}`;
      await log(sb, `${symbol} scan failed: ${e.message}`, { level: 'error', symbol });
    }
  }
  return out;
}

async function tryEntries(sb: SupabaseClient, s: NakedSellSettings, k: KiteCtx, symbol: string, spot: number, trend: Trend, trendDetail: unknown, nowMs: number, minute: number) {
  if (!s.enabled) return 'disabled';
  const right = sideForTrend(trend);
  if (!right) return 'no_trend';
  const modes = ([['PAPER', s.paper_enabled], ['SHADOW', s.shadow_enabled]] as const).filter(([, on]) => on).map(([m]) => m as Mode);
  if (!modes.length) return 'no_modes';

  // Expiry: nearest weekly; on its own expiry day, roll to the next one unless allowed.
  const today = istDateOf(nowMs);
  // Two single-row lookups: one expiry has hundreds of strike rows, so a
  // limited multi-row read can contain only today's expiry and never the next.
  const nextExpiry = async (op: 'gte' | 'gt') => {
    const { data } = await sb.from('options_instruments').select('expiry').eq('symbol', symbol)[op]('expiry', today).order('expiry').limit(1);
    return data?.[0]?.expiry ? String(data[0].expiry) : undefined;
  };
  let expiry = await nextExpiry('gte');
  if (expiry === today && !s.allow_expiry_day) expiry = await nextExpiry('gt');
  if (!expiry) return 'no_expiry';

  // Gate per mode first so we only quote strikes when some mode can enter.
  const since = istDayStartUtc(nowMs);
  const { data: todays } = await sb.from('naked_sell_positions').select('mode,status,closed_at,net_pnl').eq('symbol', symbol).gte('opened_at', since);
  const { data: actives } = await sb.from('naked_sell_positions').select('mode').eq('symbol', symbol).eq('status', 'ACTIVE');
  const openModes = modes.filter((mode) => {
    const mine = (todays ?? []).filter((p: any) => p.mode === mode);
    const lastExit = mine.filter((p: any) => p.closed_at).map((p: any) => Date.parse(p.closed_at)).sort((a, b) => b - a)[0];
    const block = entryBlocker(s, {
      minuteIst: minute,
      isExpiryDay: expiry === today,
      hasOpenPosition: (actives ?? []).some((p: any) => p.mode === mode),
      entriesToday: mine.length,
      realizedToday: mine.reduce((a: number, p: any) => a + Number(p.net_pnl ?? 0), 0),
      minutesSinceLastExit: lastExit ? (nowMs - lastExit) / 60_000 : null,
    });
    return block === null;
  });
  if (!openModes.length) return 'gated';

  const lo = spot * (1 - STRIKE_WINDOW_PCT / 100), hi = spot * (1 + STRIKE_WINDOW_PCT / 100);
  const { data: rows } = await sb.from('options_instruments').select('strike,option_right,tradingsymbol,lot_size,exchange')
    .eq('symbol', symbol).eq('expiry', expiry).eq('option_right', right).gte('strike', lo).lte('strike', hi);
  if (!rows?.length) return 'no_strikes';
  const exch = INDEX[symbol].optExchange;
  const qmap = await quotes(rows.map((r: any) => `${exch}:${r.tradingsymbol}`), k);
  const optQuotes = rows.map((r: any) => toOptionQuote(qmap[`${exch}:${r.tradingsymbol}`], { strike: Number(r.strike), right, tradingsymbol: r.tradingsymbol }));
  const pick = pickStrike(optQuotes, right, spot, expiry, nowMs, s.target_delta);
  if (!pick) { await log(sb, `${symbol}: ${trend} but no ${right} strike had a usable price`, { symbol }); return 'no_pick'; }
  const row: any = rows.find((r: any) => r.tradingsymbol === pick.quote.tradingsymbol);
  const lotSize = Number(row.lot_size);
  if (!(lotSize > 0)) return 'no_lot_size';
  const qty = lotSize * s.lots;

  const opened: string[] = [];
  for (const mode of openModes) {
    if (mode === 'SHADOW') {
      const liq = liquidityProblems(pick.quote, s.max_spread_pct, s.min_volume);
      if (liq) { await log(sb, `SHADOW: ${symbol} ${pick.quote.tradingsymbol} too illiquid (${liq.join('; ')}) — skipping.`, { mode, symbol }); continue; }
    }
    const price = entryFill(mode, pick.quote);
    if (price == null) { await log(sb, `${mode}: ${symbol} ${pick.quote.tradingsymbol} has no fillable price — skipping.`, { mode, symbol }); continue; }

    let margin: number | null = null;
    if (mode === 'SHADOW') {
      try {
        const m = await kite('/margins/basket?consider_positions=false', k, { method: 'POST', body: JSON.stringify([{
          exchange: exch, tradingsymbol: pick.quote.tradingsymbol, transaction_type: 'SELL', variety: 'regular',
          product: 'MIS', order_type: 'LIMIT', quantity: qty, price,
        }]) });
        margin = Number(m?.initial?.total ?? m?.final?.total);
      } catch (e: any) {
        await log(sb, `SHADOW: could not get margin for ${pick.quote.tradingsymbol} (${e.message}) — skipping.`, { level: 'error', mode, symbol });
        continue;
      }
      if (!(margin > 0) || margin > SHADOW_CAPITAL) {
        await log(sb, `SHADOW: ${symbol} margin ₹${Math.round(margin ?? 0)} exceeds ₹${SHADOW_CAPITAL} capital — skipping.`, { mode, symbol });
        continue;
      }
    }

    const { tp, sl } = levels(price, s.tp_pct, s.sl_pct);
    const { error } = await sb.from('naked_sell_positions').insert({
      mode, symbol, exchange: exch, expiry, strike: pick.quote.strike, option_right: right, tradingsymbol: pick.quote.tradingsymbol,
      lot_size: lotSize, lots: s.lots, qty, entry_price: price, entry_spot: spot, entry_iv: pick.iv, entry_delta: pick.delta,
      entry_trend: trendDetail, tp_price: tp, sl_price: sl, margin_required: margin,
      last_price: price, last_quoted_at: new Date(nowMs).toISOString(), unrealized_pnl: 0,
    });
    if (error) {
      // 23505 = the one-ACTIVE-per-mode-symbol unique index caught a race; harmless.
      if (error.code !== '23505') await log(sb, `${mode}: insert failed for ${symbol}: ${error.message}`, { level: 'error', mode, symbol });
      continue;
    }
    opened.push(mode);
    await log(sb, `${mode}: SOLD ${s.lots} lot ${pick.quote.tradingsymbol} @ ₹${price} (${trend} → sell ${right}, Δ${pick.delta}). TP ₹${tp} · SL ₹${sl}.`,
      { mode, symbol, detail: { strike: pick.quote.strike, expiry, iv: pick.iv, delta: pick.delta, spot, margin } });
  }
  return opened.length ? `opened ${opened.join('+')}` : 'skipped';
}

async function monitor(sb: SupabaseClient, s: NakedSellSettings, k: KiteCtx, nowMs: number, minute: number) {
  const { data: open, error } = await sb.from('naked_sell_positions').select('*').eq('status', 'ACTIVE');
  if (error) throw error;
  if (!open?.length) return { open: 0 };
  const keyOf = (p: any) => `${p.exchange}:${p.tradingsymbol}`;
  let q: Record<string, any> = {};
  try { q = await quotes([...new Set(open.map(keyOf))], k); } catch (e: any) {
    await log(sb, `Monitor: quote fetch failed (${e.message})`, { level: 'error' });
  }
  const { data: trends } = await sb.from('naked_sell_trend').select('symbol,state,updated_at');
  const trendOf = new Map<string, Trend>();
  for (const t of trends ?? []) if (nowMs - Date.parse(t.updated_at) < 3 * 60_000) trendOf.set(t.symbol, t.state as Trend); // ignore stale trend

  let closed = 0;
  for (const p of open) {
    const oq = q[keyOf(p)] ? toOptionQuote(q[keyOf(p)], { strike: Number(p.strike), right: p.option_right, tradingsymbol: p.tradingsymbol }) : null;
    const price = oq ? exitFill(p.mode as Mode, oq) : null;
    const check = checkExit({ right: p.option_right, tp_price: Number(p.tp_price), sl_price: Number(p.sl_price) }, price, trendOf.get(p.symbol) ?? null, minute, s.square_off_min);
    if (check.exit) {
      // Square-off with no fresh quote: fall back to mid, then the last recorded price.
      const exitPx = price ?? (oq ? midOf(oq) : null) ?? Number(p.last_price ?? p.entry_price);
      if (await closePosition(sb, p, exitPx, check.reason!, check.detail, nowMs)) closed++;
    } else if (price != null) {
      await sb.from('naked_sell_positions').update({
        last_price: price, last_quoted_at: new Date(nowMs).toISOString(), unrealized_pnl: shortPnl(Number(p.entry_price), price, p.qty),
      }).eq('id', p.id).eq('status', 'ACTIVE');
    }
  }
  return { open: open.length, closed };
}

async function closePosition(sb: SupabaseClient, p: any, exitPx: number, reason: ExitReason, detail: string, nowMs: number): Promise<boolean> {
  const gross = shortPnl(Number(p.entry_price), exitPx, p.qty);
  const charges = roundTripCharges(Number(p.entry_price), exitPx, p.qty, p.exchange);
  const net = Math.round((gross - charges) * 100) / 100;
  const { data, error } = await sb.from('naked_sell_positions').update({
    status: 'CLOSED', exit_price: exitPx, exit_reason: reason, exit_detail: detail, closed_at: new Date(nowMs).toISOString(),
    gross_pnl: gross, charges, net_pnl: net, last_price: exitPx, unrealized_pnl: null,
  }).eq('id', p.id).eq('status', 'ACTIVE').select('id');
  if (error || !data?.length) return false;
  await log(sb, `${p.mode}: closed ${p.tradingsymbol} @ ₹${exitPx} — ${reason} (${detail}). Net ${net >= 0 ? '+' : ''}₹${net}.`,
    { mode: p.mode, symbol: p.symbol, level: net < 0 ? 'warn' : 'info', detail: { id: p.id, gross, charges, net } });
  return true;
}

/* ------------------------------------------------------------------ */
/* Browser-facing                                                       */
/* ------------------------------------------------------------------ */

async function dashboard(sb: SupabaseClient) {
  const nowMs = Date.now();
  const [settings, trends, active, recent] = await Promise.all([
    loadSettings(sb),
    sb.from('naked_sell_trend').select('*'),
    sb.from('naked_sell_positions').select('*').eq('status', 'ACTIVE').order('opened_at', { ascending: false }),
    sb.from('naked_sell_positions').select('*').eq('status', 'CLOSED').order('closed_at', { ascending: false }).limit(200),
  ]);
  for (const r of [trends, active, recent]) if (r.error) throw r.error;
  const since = istDayStartUtc(nowMs);
  const stats = (['PAPER', 'SHADOW'] as const).map((mode) => {
    const rows = (recent.data ?? []).filter((p: any) => p.mode === mode);
    const today = rows.filter((p: any) => p.closed_at >= since);
    const wins = rows.filter((p: any) => Number(p.net_pnl) > 0).length;
    const sum = (a: any[]) => Math.round(a.reduce((t, p) => t + Number(p.net_pnl ?? 0), 0));
    const open = (active.data ?? []).filter((p: any) => p.mode === mode);
    return {
      mode, trades: rows.length, winRate: rows.length ? Math.round((wins / rows.length) * 1000) / 10 : null,
      netPnl: sum(rows), todayPnl: sum(today), todayTrades: today.length,
      openPnl: Math.round(open.reduce((t: number, p: any) => t + Number(p.unrealized_pnl ?? 0), 0)),
      byReason: Object.fromEntries(['TP', 'SL', 'TREND_FLIP', 'SQUARE_OFF', 'MANUAL'].map((r) => [r, rows.filter((p: any) => p.exit_reason === r).length])),
    };
  });
  return { settings, trends: trends.data ?? [], active: active.data ?? [], recent: (recent.data ?? []).slice(0, 50), stats, serverTime: new Date(nowMs).toISOString() };
}

const EDITABLE: Record<string, (v: any) => unknown> = {
  enabled: (v) => Boolean(v), paper_enabled: (v) => Boolean(v), shadow_enabled: (v) => Boolean(v),
  symbols: (v) => { const a = (Array.isArray(v) ? v : []).filter((x: string) => INDEX[x]); if (!a.length) throw new HttpError(400, 'bad_request', 'Pick at least one index.'); return a; },
  lots: (v) => { const n = Math.round(Number(v)); if (!(n >= 1 && n <= 10)) throw new HttpError(400, 'bad_request', 'Lots must be 1–10.'); return n; },
  tp_pct: (v) => { const n = Number(v); if (!(n > 0 && n < 100)) throw new HttpError(400, 'bad_request', 'Take-profit must be 1–99%.'); return n; },
  sl_pct: (v) => { const n = Number(v); if (!(n > 0 && n <= 200)) throw new HttpError(400, 'bad_request', 'Stop-loss must be 1–200%.'); return n; },
  max_daily_loss: (v) => { const n = Number(v); if (!(n > 0)) throw new HttpError(400, 'bad_request', 'Daily loss limit must be positive.'); return n; },
  max_entries_per_day: (v) => { const n = Math.round(Number(v)); if (!(n >= 1 && n <= 10)) throw new HttpError(400, 'bad_request', 'Entries per day must be 1–10.'); return n; },
  allow_expiry_day: (v) => Boolean(v),
};

async function mutate(sb: SupabaseClient, resource: string, body: any) {
  if (resource === 'settings') {
    const patch: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(EDITABLE)) if (body[key] !== undefined) patch[key] = parse(body[key]);
    if (!Object.keys(patch).length) throw new HttpError(400, 'bad_request', 'Nothing to update.');
    const { error } = await sb.from('naked_sell_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    await log(sb, `Settings updated: ${Object.entries(patch).map(([k2, v]) => `${k2}=${JSON.stringify(v)}`).join(', ')}`);
    return { ok: true, settings: await loadSettings(sb) };
  }
  if (resource === 'close') {
    const id = Number(body.id);
    const { data: p } = await sb.from('naked_sell_positions').select('*').eq('id', id).eq('status', 'ACTIVE').maybeSingle();
    if (!p) throw new HttpError(404, 'not_found', 'No open position with that id.');
    const k = await kiteCtx(sb);
    let px: number | null = null;
    if (k) {
      const q = await quotes([`${p.exchange}:${p.tradingsymbol}`], k).catch(() => ({}) as Record<string, any>);
      const raw = q[`${p.exchange}:${p.tradingsymbol}`];
      if (raw) px = exitFill(p.mode, toOptionQuote(raw, { strike: Number(p.strike), right: p.option_right, tradingsymbol: p.tradingsymbol }));
    }
    px ??= Number(p.last_price ?? p.entry_price);
    await closePosition(sb, p, px, 'MANUAL', 'closed from dashboard', Date.now());
    return { ok: true };
  }
  throw new HttpError(404, 'not_found', `Unknown resource "${resource}".`);
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  const resource = String(req.query.resource ?? 'dashboard');
  try {
    const sb = makeClient();
    if (req.method === 'GET') {
      if (resource === 'dashboard') { res.status(200).json(await dashboard(sb)); return; }
      if (resource === 'log') {
        const { data, error } = await sb.from('naked_sell_log').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 60, 300));
        if (error) throw error;
        res.status(200).json({ entries: data ?? [] }); return;
      }
      throw new HttpError(404, 'not_found', `Unknown resource "${resource}".`);
    }
    if (req.method === 'POST') {
      if (resource === 'tick') {
        const secret = process.env.OPTIONS_AUTOTRADE_CRON_SECRET;
        if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'unauthorized', 'unauthorized');
        res.status(200).json(await runTick(sb, Date.now(), { forceScan: true })); return;
      }
      res.status(200).json(await mutate(sb, resource, req.body ?? {})); return;
    }
    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.code, message: err.message }); return; }
    if (isMissingTable(err)) { res.status(200).json({ needsMigration: true, message: 'Run src/naked-sell/migrations/001_naked_sell.sql in the Supabase SQL editor.' }); return; }
    console.error('naked-sell failed:', err?.message);
    res.status(502).json({ error: 'upstream_error', message: err?.message ?? 'Request failed.' });
  }
}
