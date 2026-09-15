/**
 * Intraday Trader's one endpoint (query-param dispatch, same reasoning as
 * swing-scanner.js: stay under Vercel Hobby's 12-function cap). v1 slice:
 * `?resource=scan` — live market regime + a liquid-universe ranking using
 * only quote-snapshot data (return-so-far, VWAP position via Kite's own
 * exchange-computed average_price, volume-so-far vs a time-normalized
 * expectation, sector strength). Setup/trigger detection (ORB, VWAP
 * pullback, EMA trend continuation — needs today's 5-min candle history,
 * not just a snapshot) and the entry checklist/signal engine are the next
 * pass, not yet wired into this endpoint — this response ranks candidates,
 * it does not yet confirm trade signals. Said plainly rather than
 * silently under-delivering against the spec.
 *
 * `?resource=settings` — GET/PUT the singleton intraday_settings row.
 *
 * Liquid universe reuses the Swing Scanner's own daily_ohlcv/indicators
 * (price + 20d avg volume), not a separate data pipeline — per the
 * instruction not to duplicate existing infrastructure.
 */
import { createClient } from '@supabase/supabase-js';

const KITE_BASE = 'https://api.kite.trade';
const MIN_PRICE = 50;
const MIN_AVG_DAILY_VALUE = 20 * 10_000_000; // 20 crore
const UNIVERSE_CAP = 150; // top-N by liquidity fed into the live quote fetch
const RESULT_LIMIT = 25;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

function nowMinutesIST() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
function sessionFractionElapsed(nowMin) {
  return Math.max(0, Math.min(1, (nowMin - MARKET_OPEN_MIN) / (MARKET_CLOSE_MIN - MARKET_OPEN_MIN)));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function kiteQuote(instruments, { token, apiKey }) {
  const qs = instruments.map((i) => `i=${encodeURIComponent(i)}`).join('&');
  const resp = await fetch(`${KITE_BASE}/quote?${qs}`, { headers: { Authorization: `token ${apiKey}:${token}`, 'X-Kite-Version': '3' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') throw new Error(json?.message || `Kite quote error (${resp.status})`);
  return json?.data ?? {};
}

function regimeFromIndices(nifty, bankNifty, pctStocksAboveVwap) {
  const niftyReturnPct = nifty ? ((nifty.last_price - nifty.ohlc.close) / nifty.ohlc.close) * 100 : 0;
  const bankNiftyReturnPct = bankNifty ? ((bankNifty.last_price - bankNifty.ohlc.close) / bankNifty.ohlc.close) * 100 : 0;
  const niftyAboveVwap = nifty ? nifty.last_price > nifty.average_price : false;
  const bankNiftyAboveVwap = bankNifty ? bankNifty.last_price > bankNifty.average_price : false;

  let score = 0;
  score += clamp(niftyReturnPct * 20, -40, 40);
  score += niftyAboveVwap ? 15 : -15;
  score += bankNiftyAboveVwap ? 10 : -10;
  score += clamp(bankNiftyReturnPct * 10, -15, 15);
  if (pctStocksAboveVwap != null) score += clamp((pctStocksAboveVwap - 50) * 0.4, -20, 20);

  let regime;
  if (score >= 40) regime = 'STRONG_BULLISH';
  else if (score >= 15) regime = 'BULLISH';
  else if (score > -15) regime = 'NEUTRAL';
  else if (score > -40) regime = 'BEARISH';
  else regime = 'STRONG_BEARISH';

  return { regime, score: Math.round(score), niftyReturnPct, bankNiftyReturnPct, niftyAboveVwap, bankNiftyAboveVwap };
}

function rvolScoreFor(rvol) {
  if (rvol == null) return 40;
  if (rvol < 0.75) return 20;
  if (rvol < 1.0) return 45;
  if (rvol < 1.5) return 65;
  if (rvol < 2.0) return 85;
  return 95;
}
function vwapPositionScore(lastPrice, avgPrice) {
  if (!avgPrice) return 50;
  const pct = ((lastPrice - avgPrice) / avgPrice) * 100;
  return Math.round(clamp(50 + pct * 15, 0, 100));
}
function relativeStrengthScoreFor(stockReturnPct, indexReturnPct) {
  const rs = clamp(stockReturnPct - indexReturnPct, -10, 10);
  return clamp(Math.round(50 + rs * 5), 0, 100);
}

async function handleScan(supabase, req, res) {
  const apiKey = process.env.KITE_API_KEY;
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!apiKey || !token) {
    res.status(200).json({ error: 'no_kite_session', message: 'Connect Kite before scanning.' });
    return;
  }

  try {
    const { data: latestDateRow } = await supabase.from('daily_ohlcv').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    const date = latestDateRow?.date;
    if (!date) { res.status(200).json({ error: 'no_data', message: 'No daily_ohlcv data yet.' }); return; }

    const [{ data: ohlcvRows }, { data: indicatorRows }, { data: stocksRows }] = await Promise.all([
      supabase.from('daily_ohlcv').select('symbol,close').eq('date', date),
      supabase.from('indicators').select('symbol,vol_avg20').eq('date', date),
      supabase.from('stocks').select('symbol,name,sector').eq('active', true),
    ]);
    const closeBySymbol = new Map((ohlcvRows ?? []).map((r) => [r.symbol, r.close]));
    const volAvgBySymbol = new Map((indicatorRows ?? []).map((r) => [r.symbol, r.vol_avg20]));
    const metaBySymbol = new Map((stocksRows ?? []).map((r) => [r.symbol, r]));

    const universe = [];
    for (const [symbol, meta] of metaBySymbol) {
      const close = closeBySymbol.get(symbol);
      const volAvg20 = volAvgBySymbol.get(symbol);
      if (close == null || volAvg20 == null || close < MIN_PRICE) continue;
      const avgDailyValue = close * volAvg20;
      if (avgDailyValue < MIN_AVG_DAILY_VALUE) continue;
      universe.push({ symbol, name: meta.name, sector: meta.sector, prevClose: close, avgDailyValue, volAvg20 });
    }
    universe.sort((a, b) => b.avgDailyValue - a.avgDailyValue);
    const capped = universe.slice(0, UNIVERSE_CAP);

    const [niftyData, ...batches] = await Promise.all([
      kiteQuote(['NSE:NIFTY 50', 'NSE:NIFTY BANK'], { token, apiKey }),
      ...chunk(capped, 200).map((c) => kiteQuote(c.map((s) => `NSE:${s.symbol}`), { token, apiKey })),
    ]);
    const quoteBySymbol = Object.assign({}, ...batches);

    const nifty = niftyData['NSE:NIFTY 50'];
    const bankNifty = niftyData['NSE:NIFTY BANK'];

    const enriched = capped.map((u) => {
      const q = quoteBySymbol[`NSE:${u.symbol}`];
      if (!q || !q.ohlc?.close) return null;
      const returnPct = ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100;
      const aboveVwap = q.average_price ? q.last_price > q.average_price : null;
      const nowMin = nowMinutesIST();
      const expectedVol = u.volAvg20 * sessionFractionElapsed(nowMin);
      const rvol = expectedVol > 0 ? q.volume / expectedVol : null;
      return { ...u, lastPrice: q.last_price, returnPct, aboveVwap, averagePrice: q.average_price ?? null, volume: q.volume ?? 0, rvol };
    }).filter(Boolean);

    const pctStocksAboveVwap = enriched.length ? (enriched.filter((e) => e.aboveVwap).length / enriched.length) * 100 : null;
    const regimeInfo = regimeFromIndices(nifty, bankNifty, pctStocksAboveVwap);

    // Sector strength — cross-sectional, same ranking-against-each-other approach as the rest of this app.
    const bySector = new Map();
    for (const e of enriched) {
      if (!e.sector) continue;
      const list = bySector.get(e.sector) ?? [];
      list.push(e);
      bySector.set(e.sector, list);
    }
    const sectorComposite = new Map();
    for (const [sector, members] of bySector) {
      if (members.length < 3) continue;
      const avgReturn = members.reduce((s, m) => s + m.returnPct, 0) / members.length;
      const pctAbove = (members.filter((m) => m.aboveVwap).length / members.length) * 100;
      sectorComposite.set(sector, avgReturn * 0.7 + (pctAbove - 50) * 0.3);
    }
    const compositeVals = [...sectorComposite.values()];
    const lo = compositeVals.length ? Math.min(...compositeVals) : null;
    const hi = compositeVals.length ? Math.max(...compositeVals) : null;
    const sectorScore = new Map();
    for (const [sector, comp] of sectorComposite) {
      sectorScore.set(sector, hi === lo ? 50 : Math.round(((comp - lo) / (hi - lo)) * 100));
    }

    const ranked = enriched.map((e) => {
      const direction = e.returnPct >= 0 ? 'LONG' : 'SHORT';
      const factors = {
        relativeStrength: relativeStrengthScoreFor(e.returnPct, regimeInfo.niftyReturnPct),
        volume: rvolScoreFor(e.rvol),
        vwapPosition: vwapPositionScore(e.lastPrice, e.averagePrice),
        regimeAlignment: direction === 'LONG'
          ? { STRONG_BULLISH: 100, BULLISH: 75, NEUTRAL: 50, BEARISH: 25, STRONG_BEARISH: 0 }[regimeInfo.regime]
          : 100 - { STRONG_BULLISH: 100, BULLISH: 75, NEUTRAL: 50, BEARISH: 25, STRONG_BEARISH: 0 }[regimeInfo.regime],
        sectorStrength: e.sector ? (sectorScore.get(e.sector) ?? 50) : 50,
      };
      const score = Math.round(
        factors.relativeStrength * 0.30 + factors.volume * 0.25 + factors.vwapPosition * 0.20
        + factors.regimeAlignment * 0.15 + factors.sectorStrength * 0.10,
      );
      return { ...e, direction, factors, score };
    }).sort((a, b) => b.score - a.score).slice(0, RESULT_LIMIT);

    res.status(200).json({
      asOf: new Date().toISOString(),
      regime: regimeInfo,
      universeSize: capped.length,
      candidates: ranked.map((r) => ({
        symbol: r.symbol, name: r.name, sector: r.sector, direction: r.direction,
        price: r.lastPrice, returnPct: r.returnPct, aboveVwap: r.aboveVwap, rvol: r.rvol,
        score: r.score, factors: r.factors,
        note: 'Ranking only — setup/trigger detection not yet wired into this endpoint.',
      })),
    });
  } catch (err) {
    res.status(502).json({ error: 'kite_error', message: err.message });
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function handleSettings(supabase, req, res) {
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('intraday_settings').select('*').eq('id', 1).maybeSingle();
    if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
    res.status(200).json(data ?? null);
    return;
  }
  if (req.method === 'PUT') {
    const body = req.body ?? {};
    const { error } = await supabase.from('intraday_settings').upsert({ id: 1, ...body, updated_at: new Date().toISOString() });
    if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: 'method_not_allowed' });
}

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(500).json({ error: 'server_misconfigured' }); return; }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const resource = String(req.query.resource || 'scan').toLowerCase();
  if (resource === 'scan') { await handleScan(supabase, req, res); return; }
  if (resource === 'settings') { await handleSettings(supabase, req, res); return; }
  res.status(400).json({ error: 'bad_request', message: `Unknown resource "${resource}".` });
}
