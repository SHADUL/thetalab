/**
 * Intraday Naked Sell — PAPER + SHADOW, plus an owner-armed LIVE mode.
 *
 * LIVE sends REAL Zerodha orders (src/live-orders, server/liveOrders) and is
 * off unless the server runs with LIVE_ORDERS=on AND the owner has armed it
 * (POST /api/live-orders). LIVE has its own limits (lots, entries/day across
 * both indices, daily loss), checks Kite margin against real available funds,
 * places a broker-side stop-loss right after the entry fills, squares off by
 * 15:15, and records only real broker fills. PAPER / SHADOW are unchanged.
 *
 *   GET  ?resource=dashboard   settings, live trend per index, open + recent positions, stats
 *   GET  ?resource=log         recent activity
 *   POST ?resource=settings    { enabled?, paper_enabled?, shadow_enabled?, symbols?, lots?, ... }
 *   POST ?resource=close       { id }  manual close at the current quote
 *   POST ?resource=tick        cron-secret only — one engine pass (normally driven in-process
 *                              by server/nakedSellScheduler.ts every 20 s during market hours)
 *
 * One tick (20 s) = (once a minute) refresh the 5-min intraday trend per
 * index and try entries, then reload open positions, subscribe their
 * contracts on the live Kite WebSocket (server/marketStream.ts) and apply
 * exits. Between ticks, `runFastExitCheck` re-checks SL / TP / trend-flip /
 * square-off every second from live prices held in memory — no Kite REST
 * call and no database read per second. Kite is used read-only: quotes,
 * 5-minute historical candles, and the basket-margin CALCULATOR for SHADOW
 * sizing realism.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_SETTINGS, intradayTrend, completedBars, sideForTrend, pickStrike, liquidityProblems, entryFill, exitFill,
  midOf, levels, checkExit, confirmExit, roundTripCharges, shortPnl, entryBlocker, istMinuteOf, istDateOf,
  type NakedSellSettings, type Candle, type OptionQuote, type Mode, type Right, type Trend, type ExitReason, type PendingExit,
} from '../src/naked-sell/engine.ts';
import { marketStream, type LiveQuote } from '../server/marketStream.ts';
import { getLive, liveEnabled } from '../server/liveOrders/index.ts';
import { DONE, type LivePosition, type Quote } from '../src/live-orders/runner.ts';
import { rejectionHalt } from '../src/live-orders/control.ts';

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
/** LIVE squares off no later than 15:15 — before Zerodha's own MIS auto square-off. */
const LIVE_SQUARE_OFF_MIN = 15 * 60 + 15;
const squareOffFor = (p: { mode: string }, s: NakedSellSettings) => (p.mode === 'LIVE' ? Math.min(s.square_off_min, LIVE_SQUARE_OFF_MIN) : s.square_off_min);

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
  // 3. LIVE housekeeping: resolve real positions left half-done by a restart.
  if (getLive()) result.live = await liveHousekeeping(sb, nowMs).catch((e: any) => `error: ${e.message}`);
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
      book.trend.set(symbol, { state: trend.state, at: nowMs });
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
  const liveGate = await liveEntryGate(sb, nowMs);
  if (liveGate.ok) modes.push('LIVE');
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
    if (mode === 'LIVE') {
      // LIVE limits are across both indices; one open LIVE position per index.
      const L = liveGate.ok ? liveGate.L : null;
      if (!L) return false;
      const lastExit = L.today.filter((p: any) => p.closed_at && p.symbol === symbol).map((p: any) => Date.parse(p.closed_at)).sort((a, b) => b - a)[0];
      return entryBlocker({ ...s, lots: L.lots, max_entries_per_day: L.maxEntriesPerDay, max_daily_loss: L.maxDailyLoss }, {
        minuteIst: minute,
        isExpiryDay: expiry === today,
        hasOpenPosition: (actives ?? []).some((p: any) => p.mode === 'LIVE'),
        entriesToday: L.today.length,
        realizedToday: L.today.reduce((a: number, p: any) => a + Number(p.net_pnl ?? 0), 0),
        minutesSinceLastExit: lastExit ? (nowMs - lastExit) / 60_000 : null,
      }) === null;
    }
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
    if (mode === 'LIVE') {
      if (liveGate.ok && await openLive(sb, s, liveGate.L, { symbol, exch, expiry, pick, lotSize, spot, right, trend, trendDetail, nowMs })) opened.push('LIVE');
      continue;
    }
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

/* In-memory book for the 1-second loop: refreshed by every 20 s tick. */
const book = {
  positions: [] as any[],
  tokenOf: new Map<number, number>(), // position id -> instrument_token
  trend: new Map<string, { state: Trend; at: number }>(),
  settings: DEFAULT_SETTINGS as NakedSellSettings,
  pending: new Map<number, PendingExit>(),
  persistedAt: new Map<number, number>(),
};

function liveToOptionQuote(lq: LiveQuote, p: any): OptionQuote {
  return { strike: Number(p.strike), right: p.option_right, tradingsymbol: p.tradingsymbol, bid: lq.bid, ask: lq.ask, last: lq.ltp, volume: lq.volume, oi: lq.oi };
}

function freshTrend(symbol: string, nowMs: number): Trend | null {
  const t = book.trend.get(symbol);
  return t && nowMs - t.at < 3 * 60_000 ? t.state : null; // ignore a stale trend
}

async function monitor(sb: SupabaseClient, s: NakedSellSettings, k: KiteCtx, nowMs: number, minute: number) {
  const { data: open, error } = await sb.from('naked_sell_positions').select('*').eq('status', 'ACTIVE');
  if (error) throw error;
  book.settings = s;
  if (!book.trend.size) {
    const { data: trends } = await sb.from('naked_sell_trend').select('symbol,state,updated_at');
    for (const t of trends ?? []) book.trend.set(t.symbol, { state: t.state as Trend, at: Date.parse(t.updated_at) });
  }
  if (!open?.length) { book.positions = []; return { open: 0 }; }

  // Resolve instrument tokens once per position and subscribe them on the live stream.
  const missing = open.filter((p: any) => !book.tokenOf.has(p.id));
  if (missing.length) {
    const { data: inst } = await sb.from('options_instruments').select('exchange,tradingsymbol,instrument_token')
      .in('tradingsymbol', [...new Set(missing.map((p: any) => p.tradingsymbol))]);
    for (const p of missing) {
      const row = (inst ?? []).find((r: any) => r.tradingsymbol === p.tradingsymbol && r.exchange === p.exchange);
      if (row) book.tokenOf.set(p.id, Number(row.instrument_token));
    }
  }
  marketStream.want(open.map((p: any) => book.tokenOf.get(p.id)).filter((t): t is number => !!t));
  book.positions = open;

  // Live price where the stream has one; Kite REST only for the rest.
  const live = new Map<number, OptionQuote>();
  for (const p of open) {
    const lq = book.tokenOf.has(p.id) ? marketStream.get(book.tokenOf.get(p.id)!) : null;
    if (lq) live.set(p.id, liveToOptionQuote(lq, p));
  }
  const keyOf = (p: any) => `${p.exchange}:${p.tradingsymbol}`;
  const needRest = open.filter((p: any) => !live.has(p.id));
  let q: Record<string, any> = {};
  if (needRest.length) {
    try { q = await quotes([...new Set(needRest.map(keyOf))], k); } catch (e: any) {
      await log(sb, `Monitor: quote fetch failed (${e.message})`, { level: 'error' });
    }
  }

  let closed = 0;
  for (const p of open) {
    if (p.mode === 'LIVE') {
      const r = await liveMonitor(sb, p, nowMs);
      if (r === 'closed') { closed++; continue; }
      if (r === 'busy') continue;
    }
    const oq = live.get(p.id) ?? (q[keyOf(p)] ? toOptionQuote(q[keyOf(p)], { strike: Number(p.strike), right: p.option_right, tradingsymbol: p.tradingsymbol }) : null);
    const price = oq ? exitFill(p.mode as Mode, oq) : null;
    const check = checkExit({ right: p.option_right, tp_price: Number(p.tp_price), sl_price: Number(p.sl_price) }, price, freshTrend(p.symbol, nowMs), minute, squareOffFor(p, s));
    // The 1-second loop owns price exits while the stream is live; this tick only
    // backs it up (stream down) and always enforces square-off / trend flip.
    const priceExit = check.reason === 'SL' || check.reason === 'TP';
    if (check.exit && (!priceExit || !live.has(p.id))) {
      // Square-off with no fresh quote: fall back to mid, then the last recorded price.
      const exitPx = price ?? (oq ? midOf(oq) : null) ?? Number(p.last_price ?? p.entry_price);
      if (await closePosition(sb, p, exitPx, check.reason!, `${check.detail}${live.has(p.id) ? '' : ' (REST quote)'}`, nowMs)) closed++;
    } else if (price != null) {
      await persistMark(sb, p, price, nowMs);
    }
  }
  return { open: open.length, closed, live: live.size, stream: marketStream.status().connected };
}

async function persistMark(sb: SupabaseClient, p: any, price: number, nowMs: number) {
  book.persistedAt.set(p.id, nowMs);
  await sb.from('naked_sell_positions').update({
    last_price: price, last_quoted_at: new Date(nowMs).toISOString(), unrealized_pnl: shortPnl(Number(p.entry_price), price, p.qty),
  }).eq('id', p.id).eq('status', 'ACTIVE');
}

let fastBusy = false;
/**
 * Every second: SL / TP / trend-flip / square-off from live stream prices
 * only. A position with no live price is left to the 20 s tick's REST
 * fallback. SL and TP must hold on two consecutive checks (confirmExit).
 */
export async function runFastExitCheck(sb: SupabaseClient, nowMs = Date.now()) {
  if (fastBusy || !book.positions.length || !marketStream.isHealthy()) return;
  fastBusy = true;
  try {
    const minute = istMinuteOf(nowMs);
    for (const p of [...book.positions]) {
      const token = book.tokenOf.get(p.id);
      const lq = token ? marketStream.get(token) : null;
      if (!lq) continue;
      const price = exitFill(p.mode as Mode, liveToOptionQuote(lq, p));
      const check = checkExit({ right: p.option_right, tp_price: Number(p.tp_price), sl_price: Number(p.sl_price) }, price, freshTrend(p.symbol, nowMs), minute, squareOffFor(p, book.settings));
      const { fire, pending } = confirmExit(book.pending.get(p.id), check);
      if (pending) book.pending.set(p.id, pending); else book.pending.delete(p.id);
      if (fire) {
        const exitPx = price ?? midOf(liveToOptionQuote(lq, p)) ?? Number(p.last_price ?? p.entry_price);
        if (p.mode === 'LIVE') {
          // Real exits can take seconds: never hold up the 1-second loop for the other positions.
          book.positions = book.positions.filter((x) => x.id !== p.id);
          book.pending.delete(p.id);
          void closePosition(sb, p, exitPx, check.reason!, `${check.detail} (live tick)`, nowMs).catch((e: any) => console.error(`[naked-sell] LIVE close failed: ${e?.message}`));
          continue;
        }
        const ok = await closePosition(sb, p, exitPx, check.reason!, `${check.detail} (live tick)`, nowMs);
        book.positions = book.positions.filter((x) => x.id !== p.id);
        book.pending.delete(p.id);
        if (!ok) continue;
      } else if (price != null && nowMs - (book.persistedAt.get(p.id) ?? 0) >= 10_000) {
        p.last_price = price;
        await persistMark(sb, p, price, nowMs);
      }
    }
  } finally {
    fastBusy = false;
  }
}

async function closePosition(sb: SupabaseClient, p: any, exitPx: number, reason: ExitReason, detail: string, nowMs: number): Promise<boolean> {
  if (p.mode === 'LIVE') return closeLive(sb, p, reason, detail, nowMs, { bid: null, ask: exitPx, ltp: exitPx });
  const gross = shortPnl(Number(p.entry_price), exitPx, p.qty);
  const charges = roundTripCharges(Number(p.entry_price), exitPx, p.qty, p.exchange);
  const net = Math.round((gross - charges) * 100) / 100;
  const { data, error } = await sb.from('naked_sell_positions').update({
    status: 'CLOSED', exit_price: exitPx, exit_reason: reason, exit_detail: detail, closed_at: new Date(nowMs).toISOString(),
    gross_pnl: gross, charges, net_pnl: net, last_price: exitPx, unrealized_pnl: null,
  }).eq('id', p.id).eq('status', 'ACTIVE').select('id');
  book.positions = book.positions.filter((x) => x.id !== p.id);
  book.pending.delete(p.id);
  if (error || !data?.length) return false;
  await log(sb, `${p.mode}: closed ${p.tradingsymbol} @ ₹${exitPx} — ${reason} (${detail}). Net ${net >= 0 ? '+' : ''}₹${net}.`,
    { mode: p.mode, symbol: p.symbol, level: net < 0 ? 'warn' : 'info', detail: { id: p.id, gross, charges, net } });
  return true;
}

/* ------------------------------------------------------------------ */
/* LIVE — real Zerodha orders (owner-armed)                             */
/* ------------------------------------------------------------------ */

interface LiveLimits { lots: number; maxEntriesPerDay: number; maxDailyLoss: number; stopBufferPct: number; today: any[] }
type LiveGate = { ok: true; L: LiveLimits } | { ok: false; why: string };
let lastLiveSkip = '';

/** May a NEW LIVE entry be considered at all right now? (Open LIVE positions are managed regardless.) */
async function liveEntryGate(sb: SupabaseClient, nowMs: number): Promise<LiveGate> {
  const live = getLive();
  if (!live || !liveEnabled()) return { ok: false, why: 'server switch LIVE_ORDERS is off' };
  const c = live.cached('NAKED_SELL');
  if (!c.armed) return { ok: false, why: 'not armed' };
  const why = await (async () => {
    // Any real position in an unresolved state blocks new real entries until it is resolved.
    const act = await live.store.active('NAKED_SELL');
    const stuck = act.find((x) => x.status !== 'OPEN');
    if (stuck) return `live position ${stuck.tradingsymbol} is ${stuck.status} — resolve it first`;
    return rejectionHalt(await live.store.forDate('NAKED_SELL', istDateOf(nowMs)), c.armedAt);
  })().catch((e: any) => `live store unavailable (${e.message})`);
  if (why) { if (why !== lastLiveSkip) await log(sb, `LIVE: no new entries — ${why}`, { mode: 'LIVE', level: 'warn' }); lastLiveSkip = why; return { ok: false, why }; }
  const { data: today, error } = await sb.from('naked_sell_positions').select('symbol,status,closed_at,net_pnl').eq('mode', 'LIVE').gte('opened_at', istDayStartUtc(nowMs));
  if (error) return { ok: false, why: `cannot read LIVE positions (${error.message}) — migration applied?` };
  const st = c.settings;
  return { ok: true, L: { lots: Number(st.lots), maxEntriesPerDay: Number(st.maxEntriesPerDay), maxDailyLoss: Number(st.maxDailyLoss), stopBufferPct: Number(st.stopBufferPct), today: today ?? [] } };
}

async function openLive(sb: SupabaseClient, s: NakedSellSettings, L: LiveLimits, a: { symbol: string; exch: 'NFO' | 'BFO'; expiry: string; pick: NonNullable<ReturnType<typeof pickStrike>>; lotSize: number; spot: number; right: Right; trend: Trend; trendDetail: unknown; nowMs: number }): Promise<boolean> {
  const live = getLive()!;
  const q = a.pick.quote, mode = 'LIVE';
  const liq = liquidityProblems(q, s.max_spread_pct, s.min_volume);
  if (liq) { await log(sb, `LIVE: ${a.symbol} ${q.tradingsymbol} too illiquid (${liq.join('; ')}) — skipping.`, { mode, symbol: a.symbol }); return false; }
  if (!(q.bid != null && q.bid > 0)) { await log(sb, `LIVE: ${q.tradingsymbol} has no bid — skipping.`, { mode, symbol: a.symbol }); return false; }
  const qty = a.lotSize * L.lots;
  let margin: number | null = null, cash: number | null = null;
  try { [margin, cash] = await Promise.all([live.broker.orderMargin({ exchange: a.exch, tradingsymbol: q.tradingsymbol, side: 'SELL', qty, price: q.bid }), live.broker.availableCash()]); }
  catch (e: any) { await log(sb, `LIVE: margin/funds check failed (${e.message}) — skipping.`, { level: 'error', mode, symbol: a.symbol }); return false; }
  if (margin == null || cash == null) { await log(sb, 'LIVE: could not read the margin requirement or available funds — skipping.', { level: 'error', mode, symbol: a.symbol }); return false; }
  if (margin > cash) { await log(sb, `LIVE: ${q.tradingsymbol} needs margin ₹${Math.round(margin)} but only ₹${Math.round(cash)} is available — skipping.`, { mode, symbol: a.symbol }); return false; }

  const runner = live.runner('NAKED_SELL');
  const date = istDateOf(a.nowMs);
  const lp = await runner.open({ date, exchange: a.exch, tradingsymbol: q.tradingsymbol, lotSize: a.lotSize, side: 'SELL', qty, quote: { bid: q.bid, ask: q.ask, ltp: q.last }, ref: { symbol: a.symbol, strike: q.strike, expiry: a.expiry } });
  if (lp.status !== 'OPEN') { await log(sb, `LIVE: ${q.tradingsymbol} entry not filled — ${lp.log[lp.log.length - 1]?.msg ?? lp.status}.`, { level: 'warn', mode, symbol: a.symbol, detail: { id: lp.id } }); return false; }

  const price = lp.entryPrice!;
  const { tp, sl } = levels(price, s.tp_pct, s.sl_pct);
  const { data: row, error } = await sb.from('naked_sell_positions').insert({
    mode, symbol: a.symbol, exchange: a.exch, expiry: a.expiry, strike: q.strike, option_right: a.right, tradingsymbol: q.tradingsymbol,
    lot_size: a.lotSize, lots: lp.qty / a.lotSize, qty: lp.qty, entry_price: price, entry_spot: a.spot, entry_iv: a.pick.iv, entry_delta: a.pick.delta,
    entry_trend: a.trendDetail, tp_price: tp, sl_price: sl, margin_required: margin, live_position_id: lp.id,
    last_price: price, last_quoted_at: new Date(a.nowMs).toISOString(), unrealized_pnl: 0,
  }).select('id').single();
  if (error || !row) {
    // Never leave a real position without its strategy record: close it now.
    await log(sb, `LIVE: RISK could not record ${q.tradingsymbol} (${error?.message ?? 'no row'}) — closing the real position immediately.`, { level: 'error', mode, symbol: a.symbol });
    const c = await runner.close(lp, 'could not record the LIVE position', () => live.broker.quote(a.exch, q.tradingsymbol));
    await log(sb, `LIVE: emergency close of ${q.tradingsymbol}: ${c.status}${c.status === 'CLOSED' ? ` @ ₹${c.exitPrice}, net ₹${c.net}` : ' — CHECK ZERODHA NOW'}.`, { level: 'error', mode, symbol: a.symbol, detail: { id: lp.id } });
    return false;
  }
  lp.ref = { ...lp.ref, nakedSellId: row.id };
  const guarded = await runner.protect(lp, sl * (1 + L.stopBufferPct / 100));
  await log(sb, `LIVE: SOLD ${lp.qty} ${q.tradingsymbol} @ ₹${price} (real fill; ${a.trend} → sell ${a.right}, Δ${a.pick.delta}). TP ₹${tp} · SL ₹${sl} · broker stop ${guarded.stop?.orderId ? `trigger ₹${guarded.stop.trigger}` : 'NOT PLACED'}.`,
    { mode, symbol: a.symbol, level: guarded.stop?.orderId ? 'info' : 'error', detail: { id: row.id, live: lp.id, margin, cash } });
  return true;
}

/** Fresh stream quote for a LIVE row (REST is the runner's own fallback). */
function streamQuote(p: any): Quote | null {
  const t = book.tokenOf.get(p.id);
  const lq = t ? marketStream.get(t) : null;
  return lq && Date.now() - lq.receivedAt <= 5_000 ? { bid: lq.bid, ask: lq.ask, ltp: lq.ltp } : null;
}

/** Write the real result onto the naked_sell_positions row. */
async function finishLiveRow(sb: SupabaseClient, p: any, lp: LivePosition, reason: ExitReason, detail: string, nowMs: number): Promise<boolean> {
  const { data, error } = await sb.from('naked_sell_positions').update({
    status: 'CLOSED', exit_price: lp.exitPrice, exit_reason: reason, exit_detail: `${detail} (real fill${lp.closedBy === 'BROKER_STOP' ? ', broker stop' : ''})`,
    closed_at: new Date(lp.exitAt ?? nowMs).toISOString(), gross_pnl: lp.gross, charges: lp.charges, net_pnl: lp.net, last_price: lp.exitPrice, unrealized_pnl: null,
  }).eq('id', p.id).eq('status', 'ACTIVE').select('id');
  book.positions = book.positions.filter((x) => x.id !== p.id);
  book.pending.delete(p.id);
  if (error || !data?.length) { if (error) await log(sb, `LIVE: closed ${p.tradingsymbol} at the broker but could not update its row: ${error.message}`, { level: 'error', mode: 'LIVE', symbol: p.symbol }); return false; }
  const net = Number(lp.net);
  await log(sb, `LIVE: closed ${p.tradingsymbol} @ ₹${lp.exitPrice} — ${reason} (${detail}). Net ${net >= 0 ? '+' : ''}₹${net} (real fills).`, { mode: 'LIVE', symbol: p.symbol, level: net < 0 ? 'warn' : 'info', detail: { id: p.id, live: lp.id, gross: lp.gross, charges: lp.charges, net } });
  return true;
}

async function closeLive(sb: SupabaseClient, p: any, reason: ExitReason, detail: string, nowMs: number, hint?: Quote): Promise<boolean> {
  const live = getLive();
  if (!live || !p.live_position_id) { await log(sb, `LIVE: RISK cannot close ${p.tradingsymbol} — live order service unavailable. Close it in Zerodha.`, { level: 'error', mode: 'LIVE', symbol: p.symbol }); return false; }
  const runner = live.runner('NAKED_SELL');
  if (runner.isBusy(p.live_position_id)) return false;
  const lp = await live.store.get(p.live_position_id);
  if (!lp) { await log(sb, `LIVE: RISK no order record ${p.live_position_id} for ${p.tradingsymbol} — close it in Zerodha.`, { level: 'error', mode: 'LIVE', symbol: p.symbol }); return false; }
  if (lp.status === 'CLOSED') return finishLiveRow(sb, p, lp, reason, detail, nowMs);
  // Price source: live stream → fresh REST quote → the price the caller just used to decide the exit.
  const out = await runner.close(lp, `${reason}: ${detail}`, async () => streamQuote(p) ?? (await live.broker.quote(lp.exchange, lp.tradingsymbol).catch(() => null)) ?? hint ?? null);
  if (out.status === 'CLOSED') return finishLiveRow(sb, p, out, out.closedBy === 'BROKER_STOP' ? 'SL' : reason, detail, nowMs);
  await log(sb, `LIVE: RISK exit of ${p.tradingsymbol} incomplete (${out.status}) — retrying every tick. ${out.log[out.log.length - 1]?.msg ?? ''}`, { level: 'error', mode: 'LIVE', symbol: p.symbol, detail: { live: lp.id } });
  return false;
}

/** Per tick for each ACTIVE LIVE row: did the broker stop fill? Is a close half-done? */
async function liveMonitor(sb: SupabaseClient, p: any, nowMs: number): Promise<'closed' | 'busy' | 'none'> {
  const live = getLive();
  if (!live || !p.live_position_id) return 'none';
  const runner = live.runner('NAKED_SELL');
  if (runner.isBusy(p.live_position_id)) return 'busy';
  let lp = await live.store.get(p.live_position_id).catch(() => null);
  if (!lp) return 'none';
  if (lp.status === 'OPEN') lp = await runner.syncStop(lp);
  if (lp.status === 'CLOSED') return (await finishLiveRow(sb, p, lp, 'SL', lp.closedBy === 'BROKER_STOP' ? 'broker stop-loss filled at Zerodha' : 'closed', nowMs)) ? 'closed' : 'busy';
  if (lp.status === 'CLOSING' || lp.status === 'CLOSE_FAILED') {
    const reason = (['TP', 'SL', 'TREND_FLIP', 'SQUARE_OFF', 'MANUAL'].find((r) => (lp!.exitReason ?? '').startsWith(r)) ?? 'MANUAL') as ExitReason;
    return (await closeLive(sb, p, reason, 'retrying an unfinished real exit', nowMs)) ? 'closed' : 'busy';
  }
  return 'none';
}

/** Real positions with no ACTIVE strategy row (crash between fill and record): resolve or close them. */
async function liveHousekeeping(sb: SupabaseClient, nowMs: number) {
  const live = getLive()!;
  const runner = live.runner('NAKED_SELL');
  const act = await live.store.active('NAKED_SELL');
  let fixed = 0;
  for (let lp of act) {
    if (runner.isBusy(lp.id)) continue;
    if (lp.status === 'OPENING' && nowMs - lp.createdAt > 60_000) lp = await runner.recover(lp);
    if (DONE.has(lp.status) || lp.status === 'OPENING') continue;
    const { data: row } = await sb.from('naked_sell_positions').select('id,status').eq('live_position_id', lp.id).maybeSingle();
    if (row?.status === 'ACTIVE') continue; // the monitor manages it
    await log(sb, `LIVE: RISK real position ${lp.tradingsymbol} (${lp.status}) has no active strategy record — closing it.`, { level: 'error', mode: 'LIVE' });
    const out = await runner.close(lp, 'no active strategy record (restart recovery)', () => live.broker.quote(lp.exchange, lp.tradingsymbol));
    await log(sb, `LIVE: recovery close of ${lp.tradingsymbol}: ${out.status}${out.status === 'CLOSED' ? ` @ ₹${out.exitPrice}, net ₹${out.net}` : ' — CHECK ZERODHA NOW'}.`, { level: out.status === 'CLOSED' ? 'warn' : 'error', mode: 'LIVE' });
    fixed++;
  }
  return { active: act.length, fixed };
}

/** Owner FLATTEN LIVE: close every open LIVE position at the broker now. */
export async function flattenLive(sb: SupabaseClient): Promise<string> {
  const { data: open, error } = await sb.from('naked_sell_positions').select('*').eq('status', 'ACTIVE').eq('mode', 'LIVE');
  if (error) throw error;
  const res: string[] = [];
  for (const p of open ?? []) res.push(`${p.tradingsymbol}: ${(await closeLive(sb, p, 'MANUAL', 'owner FLATTEN LIVE', Date.now())) ? 'closed' : 'NOT closed — retrying, check Zerodha'}`);
  return res.length ? res.join('; ') : 'no open LIVE positions';
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
  const stats = (['PAPER', 'SHADOW', 'LIVE'] as const).map((mode) => {
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
  // Overlay the live price on open positions (the DB mark is persisted only every ~10 s).
  const activeLive = (active.data ?? []).map((p: any) => {
    const token = book.tokenOf.get(p.id);
    const lq = token ? marketStream.get(token) : null;
    const px = lq ? exitFill(p.mode as Mode, liveToOptionQuote(lq, p)) : null;
    return px == null ? { ...p, live: false } : { ...p, live: true, last_price: px, last_quoted_at: new Date(lq!.receivedAt).toISOString(), unrealized_pnl: shortPnl(Number(p.entry_price), px, p.qty) };
  });
  return { settings, trends: trends.data ?? [], active: activeLive, recent: (recent.data ?? []).slice(0, 50), stats, stream: marketStream.status(), serverTime: new Date(nowMs).toISOString() };
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
