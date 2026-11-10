/**
 * Swing Trading (swing-india) — cash-equity swing scanner + paper tracker.
 *
 *   GET  ?resource=dashboard          open positions with live MTM + signals, portfolio, stats
 *   GET  ?resource=scan[&refresh=1]   Nifty 100 scan, top 10 BUY candidates
 *   GET  ?resource=analyze&symbol=X   single-ticker deep card
 *   GET  ?resource=log                recent run/close/compile log
 *   POST ?resource=propose  {symbol}            analyze server-side, add to proposed
 *   POST ?resource=open     {id, fillPrice?}    proposed -> open (paper fill)
 *   POST ?resource=discard  {id}
 *   POST ?resource=trail    {id, stop}          raise stop only
 *   POST ?resource=close    {id, exit, reason, postmortem?}
 *   POST ?resource=settings {capital, riskPct}
 *   POST ?resource=compile
 *
 * Paper trading only: nothing here talks to a broker's order APIs. Kite is
 * used read-only for live quotes; without a session, the last EOD close is
 * used and marked stale. Daily bars come from the NSE-bhavcopy history the
 * Swing Daily Data Refresh workflow keeps in `daily_ohlcv`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '../src/swing/scripts/dbPaging.ts';
import { adjustForSplits } from '../src/swing/indicators/splitAdjust.ts';
import type { Bar } from '../src/swing/indicators/types.ts';
import { NIFTY100 } from '../src/swing-india/universe.ts';
import {
  scanUniverse, analyzeTicker, positionStatus, closeMetrics, closedStats, compileLearnings, effectiveRules,
  HARD_RULES, SIGNAL_PRIORITY, EXIT_REASONS, DEFAULT_LEARNINGS, type Learnings, type ClosedTrade,
} from '../src/swing-india/engine.ts';

type Req = { method?: string; query: Record<string, unknown>; body?: any };
type Res = { status(code: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void };

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const bad = (msg: string) => new HttpError(400, 'bad_request', msg);

function isMissingTable(err: any) {
  return err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message ?? ''));
}

// ------------------------------------------------------------------ data

interface OhlcvRow { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }

async function loadBars(sb: SupabaseClient, symbols: string[], since: string): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += 8) batches.push(symbols.slice(i, i + 8));
  const run = async (batch: string[]) => {
    const rows = await fetchAllPages<OhlcvRow>(sb, 'daily_ohlcv', 'symbol,date,open,high,low,close,volume',
      [['symbol', true], ['date', true]], (q: any) => q.in('symbol', batch).gte('date', since));
    for (const s of batch) out.set(s, []);
    for (const r of rows) out.get(r.symbol)!.push({ t: r.date, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume) });
  };
  for (let i = 0; i < batches.length; i += 4) await Promise.all(batches.slice(i, i + 4).map(run));
  for (const [s, bars] of out) out.set(s, adjustForSplits(bars));
  return out;
}

async function kiteQuotes(sb: SupabaseClient, symbols: string[]): Promise<{ prices: Map<string, number>; connected: boolean }> {
  const prices = new Map<string, number>();
  const apiKey = process.env.KITE_API_KEY;
  const { data: session } = await sb.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!apiKey || !token || symbols.length === 0) return { prices, connected: Boolean(apiKey && token) };
  try {
    for (let i = 0; i < symbols.length; i += 200) {
      const qs = symbols.slice(i, i + 200).map((s) => `i=${encodeURIComponent(`NSE:${s}`)}`).join('&');
      const resp = await fetch(`https://api.kite.trade/quote/ltp?${qs}`, { headers: { Authorization: `token ${apiKey}:${token}`, 'X-Kite-Version': '3' }, signal: AbortSignal.timeout(6000) });
      if (!resp.ok) return { prices, connected: resp.status !== 403 && resp.status !== 401 };
      const body: any = await resp.json();
      for (const [k, q] of Object.entries<any>(body?.data ?? {})) if (q?.last_price > 0) prices.set(k.replace(/^NSE:/, ''), Number(q.last_price));
    }
    return { prices, connected: true };
  } catch {
    return { prices, connected: false };
  }
}

async function getState(sb: SupabaseClient) {
  const { data, error } = await sb.from('swing_india_state').select('*').eq('id', 1).maybeSingle();
  // Scan/analyze still work before the migration is run — defaults stand in for the state row.
  if (error && !isMissingTable(error)) throw error;
  const row = data ?? { capital: 500000, risk_pct: 1, learnings: null, learnings_md: null, changelog: [] };
  return {
    migrated: !error,
    capital: Number(row.capital), riskPct: Number(row.risk_pct),
    learnings: (row.learnings as Learnings | null) ?? DEFAULT_LEARNINGS,
    learningsMd: row.learnings_md as string | null, changelog: (row.changelog as string[]) ?? [], compiledAt: row.compiled_at ?? null,
  };
}

async function getPositions(sb: SupabaseClient) {
  const { data, error } = await sb.from('swing_india_positions').select('*').neq('status', 'DISCARDED').order('created_at', { ascending: false }).limit(500);
  if (error && !isMissingTable(error)) throw error;
  return data ?? [];
}

const log = (sb: SupabaseClient, type: string, ticker: string | null, payload: unknown) =>
  sb.from('swing_india_log').insert({ type, ticker, payload }).then(() => undefined, () => undefined);

function monthPnl(closed: any[], capital: number, today: string) {
  const month = today.slice(0, 7);
  const inr = closed.filter((c) => c.closed_at && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(c.closed_at)).startsWith(month))
    .reduce((a, c) => a + Number(c.pnl_inr ?? 0), 0);
  return { inr: Math.round(inr * 100) / 100, pct: capital > 0 ? Math.round((inr / capital) * 10000) / 100 : 0 };
}

async function universeMeta(sb: SupabaseClient, symbols: string[]) {
  const { data, error } = await sb.from('stocks').select('symbol,name,sector').in('symbol', symbols).eq('active', true);
  if (error) throw error;
  return new Map((data ?? []).map((s: any) => [s.symbol, s]));
}

// ------------------------------------------------------------------ scan (cached: EOD data moves once a day)

let scanCache: { key: string; at: number; result: any } | null = null;
const SCAN_TTL_MS = 5 * 60_000;

async function runScan(sb: SupabaseClient, refresh: boolean) {
  const st = await getState(sb);
  const key = `${istToday()}|${st.capital}|${st.riskPct}|${JSON.stringify(st.learnings)}`;
  if (!refresh && scanCache && scanCache.key === key && Date.now() - scanCache.at < SCAN_TTL_MS) return { ...scanCache.result, cached: true };

  const meta = await universeMeta(sb, NIFTY100);
  const symbols = [...meta.keys()];
  const [bars, quotes] = await Promise.all([loadBars(sb, symbols, daysAgo(460)), kiteQuotes(sb, symbols)]);
  const res = scanUniverse(symbols.map((s) => ({
    symbol: s, name: meta.get(s)?.name, sector: meta.get(s)?.sector, bars: bars.get(s) ?? [], cmp: quotes.prices.get(s) ?? null,
  })), st.capital, st.riskPct, st.learnings, 10);
  const dataAsOf = [...bars.values()].reduce((m, b) => (b.length && b[b.length - 1].t > m ? b[b.length - 1].t : m), '');
  const result = {
    at: new Date().toISOString(), dataAsOf, liveQuotes: quotes.prices.size > 0, kiteConnected: quotes.connected,
    capital: st.capital, riskPct: st.riskPct, scanned: res.scanned, candidates: res.candidates,
    filtered: res.scanned - res.candidates, picks: res.picks, rejected: res.rejected,
    learningsActive: res.rules.active && res.rules.sampleSize >= 10, sampleSize: res.rules.sampleSize,
    skipListSize: res.rules.skipList.length,
  };
  scanCache = { key, at: Date.now(), result };
  await log(sb, 'scan', null, {
    scanned: res.scanned, candidates: res.candidates, dataAsOf,
    picks: res.picks.map((p) => ({ ticker: p.symbol, score: p.score, cmp: p.cmp, entry: p.plan.entry, stop: p.plan.stop, t1: p.plan.t1, t2: p.plan.t2, qty: p.plan.qty })),
  });
  return { ...result, cached: false };
}

// ------------------------------------------------------------------ analyze

async function runAnalyze(sb: SupabaseClient, symbolRaw: string) {
  const symbol = symbolRaw.toUpperCase().trim().replace(/\.NS$/, '');
  if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) throw bad('Invalid symbol.');
  const { data: stock } = await sb.from('stocks').select('symbol,name,sector').eq('symbol', symbol).maybeSingle();
  if (!stock) throw new HttpError(404, 'unknown_symbol', `${symbol} is not in the NSE equity universe (Nifty 500). Cash equity only — F&O is not supported.`);
  const st = await getState(sb);
  const positions = await getPositions(sb);
  const open = positions.filter((p: any) => p.status === 'OPEN');
  const closed = positions.filter((p: any) => p.status === 'CLOSED');
  const today = istToday();
  const [bars, quotes] = await Promise.all([loadBars(sb, [symbol], '2020-01-01'), kiteQuotes(sb, [symbol])]);
  const a = analyzeTicker(symbol, bars.get(symbol) ?? [], quotes.prices.get(symbol) ?? null, st.capital, st.riskPct, st.learnings, {
    openCount: open.length, monthPnlPct: monthPnl(closed, st.capital, today).pct, alreadyOpen: open.some((p: any) => p.symbol === symbol),
  }, stock.sector ?? null);
  if (!a) throw new HttpError(422, 'insufficient_history', `Not enough price history for ${symbol}.`);
  const rules = effectiveRules(st.learnings);
  return {
    ...a, name: stock.name, sector: stock.sector, cmpLive: quotes.prices.has(symbol), capital: st.capital, riskPct: Math.min(st.riskPct, 1),
    learningsApplied: rules.active && rules.sampleSize >= 10, sampleSize: rules.sampleSize, horizonDays: rules.maxHoldingDays,
  };
}

// ------------------------------------------------------------------ dashboard

async function runDashboard(sb: SupabaseClient) {
  const st = await getState(sb);
  if (!st.migrated) return { needsMigration: true, message: 'Run src/swing-india/migrations/001_swing_india.sql in the Supabase SQL editor.' };
  const positions = await getPositions(sb);
  const today = istToday();
  const open = positions.filter((p: any) => p.status === 'OPEN');
  const proposed = positions.filter((p: any) => p.status === 'PROPOSED');
  const closed = positions.filter((p: any) => p.status === 'CLOSED');
  const rules = effectiveRules(st.learnings);

  const symbols = [...new Set([...open, ...proposed].map((p: any) => p.symbol))];
  const quotes = await kiteQuotes(sb, symbols);
  const missing = symbols.filter((s) => !quotes.prices.has(s));
  const lastClose = new Map<string, number>();
  if (missing.length) {
    const bars = await loadBars(sb, missing, daysAgo(14));
    for (const [s, b] of bars) if (b.length) lastClose.set(s, b[b.length - 1].c);
  }
  const cmpOf = (s: string) => quotes.prices.get(s) ?? lastClose.get(s) ?? null;

  const statuses = open.map((p: any) => {
    const cmp = cmpOf(p.symbol) ?? Number(p.entry);
    return {
      ...p, live: positionStatus({ id: p.id, symbol: p.symbol, entry: Number(p.entry), stop: Number(p.stop), t1: Number(p.t1), t2: Number(p.t2), qty: p.qty, opened_at: p.opened_at, atr: p.atr == null ? null : Number(p.atr) },
        cmp, quotes.prices.has(p.symbol), today, rules.maxHoldingDays),
    };
  }).sort((a: any, b: any) => SIGNAL_PRIORITY.indexOf(a.live.signal) - SIGNAL_PRIORITY.indexOf(b.live.signal));

  const invested = open.reduce((a: number, p: any) => a + Number(p.entry) * p.qty, 0);
  const marketValue = statuses.reduce((a: number, p: any) => a + p.live.cmp * p.qty, 0);
  const unrealized = marketValue - invested;
  const month = monthPnl(closed, st.capital, today);
  const closedTrades: ClosedTrade[] = closed.map((c: any) => ({ ...c, r_multiple: Number(c.r_multiple), pnl_inr: Number(c.pnl_inr), days_held: Number(c.days_held) }));

  const r2 = (x: number) => Math.round(x * 100) / 100;
  const warnings: string[] = [];
  if (open.length >= HARD_RULES.maxOpen) warnings.push(`All ${HARD_RULES.maxOpen} slots in use — no new entries.`);
  if (month.pct < HARD_RULES.monthHaltPct) warnings.push(`Month P&L ${month.pct}% is below −3% — new entries halted.`);
  if (!quotes.connected) warnings.push('Kite not connected — prices are last EOD close (stale).');

  return {
    today, capital: st.capital, riskPct: st.riskPct, kiteConnected: quotes.connected,
    open: statuses, proposed: proposed.map((p: any) => ({ ...p, cmp: cmpOf(p.symbol) })),
    closed: closed.slice(0, 100),
    portfolio: {
      invested: r2(invested), marketValue: r2(marketValue), unrealized: r2(unrealized),
      unrealizedPctInv: invested ? r2((unrealized / invested) * 100) : 0, unrealizedPctCap: st.capital ? r2((unrealized / st.capital) * 100) : 0,
      deployedPct: st.capital ? r2((invested / st.capital) * 100) : 0,
    },
    stats: closedStats(closedTrades), month,
    slots: { used: open.length, max: HARD_RULES.maxOpen },
    learnings: { ...rules, applied: rules.active && rules.sampleSize >= 10, markdown: st.learningsMd, compiledAt: st.compiledAt, closedCount: closed.length },
    warnings,
  };
}

// ------------------------------------------------------------------ mutations

async function positionById(sb: SupabaseClient, id: unknown) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw bad('id must be a positive integer.');
  const { data, error } = await sb.from('swing_india_positions').select('*').eq('id', n).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'not_found', 'Position not found.');
  return data;
}

async function mutate(sb: SupabaseClient, resource: string, body: any) {
  const today = istToday();
  switch (resource) {
    case 'propose': {
      const a = await runAnalyze(sb, String(body?.symbol ?? ''));
      if (a.verdict === 'SKIP') throw new HttpError(409, 'skip_verdict', `SKIP — ${a.reason}`);
      const { data: dup } = await sb.from('swing_india_positions').select('id').eq('symbol', a.symbol).in('status', ['PROPOSED', 'OPEN']).limit(1);
      if (dup?.length) throw new HttpError(409, 'duplicate', `${a.symbol} is already proposed or open.`);
      const t = a.technicals;
      const { data, error } = await sb.from('swing_india_positions').insert({
        symbol: a.symbol, sector: a.sector, status: 'PROPOSED', verdict: a.verdict, score: a.score, cmp_at_scan: a.cmp,
        entry: a.plan.entry, stop: a.plan.stop, initial_stop: a.plan.stop, t1: a.plan.t1, t2: a.plan.t2, qty: a.plan.qty, atr: t.atr14,
        setup: { rsi14: t.rsi14, adx14: t.adx14, dmaPct: t.dmaPct, macdState: t.macdState, weeklyTrend: a.weeklyTrend, fibSupport: a.fib.support, fibResistance: a.fib.resistance, dataAsOf: t.asOf },
      }).select().single();
      if (error) throw error;
      await log(sb, 'run', a.symbol, { mode: 'analyze', verdict: a.verdict, reason: a.reason, capital: a.capital, technicals: data.setup, position: a.plan });
      return { position: data };
    }
    case 'open': {
      const p = await positionById(sb, body?.id);
      if (p.status !== 'PROPOSED') throw new HttpError(409, 'bad_state', 'Only proposed positions can be opened.');
      const positions = await getPositions(sb);
      const st = await getState(sb);
      if (positions.filter((x: any) => x.status === 'OPEN').length >= HARD_RULES.maxOpen) throw new HttpError(409, 'slots_full', `Max ${HARD_RULES.maxOpen} concurrent open positions.`);
      const m = monthPnl(positions.filter((x: any) => x.status === 'CLOSED'), st.capital, today);
      if (m.pct < HARD_RULES.monthHaltPct) throw new HttpError(409, 'month_halt', `Month P&L ${m.pct}% < −3% — new entries halted.`);
      const fill = body?.fillPrice == null || body.fillPrice === '' ? Number(p.entry) : Number(body.fillPrice);
      if (!(fill > 0)) throw bad('fillPrice must be positive.');
      if (fill <= Number(p.stop)) throw bad('Fill is at or below the stop — the setup is invalid.');
      const rrT1 = (Number(p.t1) - fill) / (fill - Number(p.stop));
      if (rrT1 < HARD_RULES.minRrT1) throw new HttpError(409, 'rr_too_low', `At ₹${fill} the R:R to T1 is ${rrT1.toFixed(2)} (< 1.5). Re-analyze instead of chasing.`);
      const { data, error } = await sb.from('swing_india_positions').update({ status: 'OPEN', entry: fill, opened_at: today }).eq('id', p.id).eq('status', 'PROPOSED').select().single();
      if (error) throw error;
      await log(sb, 'open', p.symbol, { entry: fill, stop: p.stop, t1: p.t1, t2: p.t2, qty: p.qty });
      return { position: data };
    }
    case 'discard': {
      const p = await positionById(sb, body?.id);
      if (p.status !== 'PROPOSED') throw new HttpError(409, 'bad_state', 'Only proposed positions can be discarded.');
      await sb.from('swing_india_positions').update({ status: 'DISCARDED' }).eq('id', p.id);
      return { ok: true };
    }
    case 'trail': {
      const p = await positionById(sb, body?.id);
      const stop = Number(body?.stop);
      if (p.status !== 'OPEN') throw new HttpError(409, 'bad_state', 'Only open positions can be trailed.');
      if (!(stop > Number(p.stop))) throw bad('A trailing stop can only move up.');
      const { data, error } = await sb.from('swing_india_positions').update({ stop }).eq('id', p.id).select().single();
      if (error) throw error;
      await log(sb, 'trail', p.symbol, { from: p.stop, to: stop });
      return { position: data };
    }
    case 'close': {
      const p = await positionById(sb, body?.id);
      if (p.status !== 'OPEN') throw new HttpError(409, 'bad_state', 'Only open positions can be closed.');
      const exit = Number(body?.exit);
      const reason = String(body?.reason ?? '');
      if (!(exit > 0)) throw bad('exit must be a positive price.');
      if (!(EXIT_REASONS as readonly string[]).includes(reason)) throw bad(`reason must be one of ${EXIT_REASONS.join(', ')}.`);
      // R is measured against the ORIGINAL stop, so trailing never inflates the R-multiple.
      const m = closeMetrics({ entry: Number(p.entry), stop: Number(p.initial_stop ?? p.stop), qty: p.qty, opened_at: p.opened_at }, exit, today);
      const postmortem = body?.postmortem ? String(body.postmortem).slice(0, 2000) : null;
      const { data, error } = await sb.from('swing_india_positions').update({
        status: 'CLOSED', closed_at: new Date().toISOString(), exit_price: exit, exit_reason: reason,
        r_multiple: m.rMultiple, pnl_inr: m.pnlInr, days_held: m.daysHeld, outcome: m.outcome, postmortem,
      }).eq('id', p.id).eq('status', 'OPEN').select().single();
      if (error) throw error;
      await log(sb, 'close', p.symbol, { entry: p.entry, exit, stop: p.initial_stop ?? p.stop, qty: p.qty, exit_reason: reason, r_multiple: m.rMultiple, days_held: m.daysHeld, pnl_inr: m.pnlInr, outcome: m.outcome, postmortem });
      return { position: data, metrics: m };
    }
    case 'settings': {
      const capital = Number(body?.capital);
      const riskPct = Number(body?.riskPct);
      if (!(capital >= 10000 && capital <= 1e9)) throw bad('capital must be between ₹10,000 and ₹100 cr.');
      if (!(riskPct > 0 && riskPct <= HARD_RULES.maxRiskPct)) throw bad('riskPct must be > 0 and ≤ 1 (hard rule).');
      const { error } = await sb.from('swing_india_state').upsert({ id: 1, capital, risk_pct: riskPct, updated_at: new Date().toISOString() });
      if (error) throw error;
      scanCache = null;
      return { ok: true };
    }
    case 'compile': {
      const st = await getState(sb);
      const positions = await getPositions(sb);
      const closed: ClosedTrade[] = positions.filter((p: any) => p.status === 'CLOSED')
        .map((c: any) => ({ ...c, r_multiple: Number(c.r_multiple), pnl_inr: Number(c.pnl_inr), days_held: Number(c.days_held) }));
      const r = compileLearnings(closed, st.learnings, today, st.changelog);
      if (!r.ok) return { ok: false, message: r.message };
      const { error } = await sb.from('swing_india_state').update({
        learnings: r.learnings, learnings_md: r.markdown, changelog: r.changelog, compiled_at: new Date().toISOString(),
      }).eq('id', 1);
      if (error) throw error;
      scanCache = null;
      await log(sb, 'compile', null, { sample: closed.length, diff: r.diff });
      return { ok: true, diff: r.diff, markdown: r.markdown };
    }
    default:
      throw new HttpError(404, 'not_found', `Unknown resource "${resource}".`);
  }
}

// ------------------------------------------------------------------ handler

export default async function handler(req: Req, res: Res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(500).json({ error: 'server_misconfigured', message: 'Supabase is not configured.' }); return; }
  // Bounded so one stalled upstream call can't leave the page spinning forever.
  const sb = createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (input: any, init?: any) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }) },
  });
  const resource = String(req.query.resource ?? 'dashboard');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      if (resource === 'dashboard') { res.status(200).json(await runDashboard(sb)); return; }
      if (resource === 'scan') { res.status(200).json(await runScan(sb, req.query.refresh === '1')); return; }
      if (resource === 'analyze') { res.status(200).json(await runAnalyze(sb, String(req.query.symbol ?? ''))); return; }
      if (resource === 'log') {
        const { data, error } = await sb.from('swing_india_log').select('*').order('at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 50, 200));
        if (error) throw error;
        res.status(200).json({ entries: data ?? [] }); return;
      }
      throw new HttpError(404, 'not_found', `Unknown resource "${resource}".`);
    }
    if (req.method === 'POST') { res.status(200).json(await mutate(sb, resource, req.body ?? {})); return; }
    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.code, message: err.message }); return; }
    if (isMissingTable(err)) { res.status(200).json({ needsMigration: true, message: 'Run src/swing-india/migrations/001_swing_india.sql in the Supabase SQL editor.' }); return; }
    console.error('swing-india failed:', err?.message);
    res.status(502).json({ error: 'upstream_error', message: err?.message ?? 'Request failed.' });
  }
}
