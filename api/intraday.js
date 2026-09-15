/**
 * Intraday Trader's one endpoint (query-param dispatch, same reasoning as
 * swing-scanner.js: stay under Vercel Hobby's 12-function cap).
 *
 * `?resource=scan` — two stages:
 *  1. Rank the liquid universe from quote snapshots (return, VWAP position
 *     via Kite's own exchange-computed average_price, RVOL, sector, regime
 *     alignment) — cheap, one quote call for ~150 symbols.
 *  2. For the top-ranked shortlist only, fetch today's 5-min candles
 *     (Kite's historical API) to run real setup detection (ORB, VWAP
 *     Pullback, EMA Trend Continuation), the 12-point entry checklist, and
 *     the Intraday Score — expensive per-symbol, so deliberately only run
 *     on ~12 candidates, not the whole universe (spec §62's own ranking-
 *     then-setup-detection order).
 *
 * The logic below is a direct, deliberate port of the tested pure
 * functions in src/intraday/*.ts (same formulas/thresholds) — not a
 * second design. It's duplicated rather than imported because no
 * api/*.js file in this repo imports a .ts module (only plain .js), and
 * this isn't the place to introduce that as an unverified first case.
 * src/intraday/*.ts remains the source of truth verified by its 48 tests;
 * this mirrors it.
 *
 * `?resource=settings` — GET/PUT the singleton intraday_settings row.
 */
import { createClient } from '@supabase/supabase-js';

const KITE_BASE = 'https://api.kite.trade';
const MIN_PRICE = 50;
const MIN_AVG_DAILY_VALUE = 20 * 10_000_000; // 20 crore
const UNIVERSE_CAP = 150;
const RESULT_LIMIT = 25;
const SETUP_SHORTLIST = 12;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
const OR_END_MIN = 9 * 60 + 30;

const DEFAULT_SETTINGS = { min_score: 70, min_risk_reward: 1.5, min_rvol: 1.0, max_extension_atr: 2.5 };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function nowMinutesIST() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
function istMinutesOfDay(epochMs) {
  const ist = new Date(new Date(epochMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
function sessionFractionElapsed(nowMin) {
  return clamp((nowMin - MARKET_OPEN_MIN) / (MARKET_CLOSE_MIN - MARKET_OPEN_MIN), 0, 1);
}

async function kiteFetch(path, { token, apiKey }) {
  const resp = await fetch(`${KITE_BASE}${path}`, { headers: { Authorization: `token ${apiKey}:${token}`, 'X-Kite-Version': '3' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') throw new Error(json?.message || `Kite API error (${resp.status}) on ${path}`);
  return json?.data;
}
async function kiteQuote(instruments, ctx) {
  const qs = instruments.map((i) => `i=${encodeURIComponent(i)}`).join('&');
  return (await kiteFetch(`/quote?${qs}`, ctx)) ?? {};
}
async function kiteHistorical(token, interval, from, to, ctx) {
  const data = await kiteFetch(`/instruments/historical/${token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, ctx);
  return (data?.candles ?? []).map((c) => ({ t: new Date(c[0]).getTime(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- pure math (ported from src/intraday/*.ts — see file header) ----

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function trueRange(bars) {
  return bars.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
}
function atr(bars, period) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
  return out;
}
function computeSessionVWAP(bars) {
  let cumPV = 0, cumV = 0;
  return bars.map((b) => { const tp = (b.h + b.l + b.c) / 3; cumPV += tp * b.v; cumV += b.v; return cumV > 0 ? cumPV / cumV : b.c; });
}
function computeOpeningRange(bars) {
  const orBars = bars.filter((b) => istMinutesOfDay(b.t) >= MARKET_OPEN_MIN && istMinutesOfDay(b.t) < OR_END_MIN);
  if (orBars.length === 0) return null;
  return { high: Math.max(...orBars.map((b) => b.h)), low: Math.min(...orBars.map((b) => b.l)) };
}
function detectORB(bars, or, direction) {
  const last = bars[bars.length - 1];
  if (!last || !or) return { fired: false, quality: 0 };
  const level = direction === 'LONG' ? or.high : or.low;
  const fired = direction === 'LONG' ? last.c > level : last.c < level;
  if (!fired) return { fired: false, quality: 0 };
  const distPct = Math.abs((last.c - level) / level) * 100;
  const range = last.h - last.l;
  const closingStrength = range === 0 ? 0.5 : direction === 'LONG' ? (last.c - last.l) / range : (last.h - last.c) / range;
  return { fired: true, quality: Math.round(clamp(50 + distPct * 20 + closingStrength * 30, 0, 100)) };
}
function detectVwapPullback(bars, vwapSeries, direction) {
  if (bars.length < 8) return { fired: false, quality: 0 };
  const recent = bars.slice(-8), recentVwap = vwapSeries.slice(-8), sign = direction === 'LONG' ? 1 : -1;
  const dist = recent.map((b, i) => ((b.c - recentVwap[i]) / recentVwap[i]) * 100 * sign);
  const earlyPeak = Math.max(...dist.slice(0, 4));
  const wasExtended = earlyPeak > 0.3;
  const pulledBack = dist[dist.length - 2] < earlyPeak * 0.6;
  const stillAligned = dist[dist.length - 1] > -0.05;
  const last = recent[recent.length - 1];
  const resumed = direction === 'LONG' ? last.c > last.o : last.c < last.o;
  const fired = wasExtended && pulledBack && stillAligned && resumed;
  return { fired, quality: fired ? 80 : 0 };
}
function detectEmaTrendContinuation(bars, ema9, ema20, direction) {
  const i = bars.length - 1;
  const e9 = ema9[i], e20 = ema20[i];
  if (e9 == null || e20 == null) return { fired: false, quality: 0 };
  const stacked = direction === 'LONG' ? e9 > e20 : e9 < e20;
  const priceAligned = direction === 'LONG' ? bars[i].c > e9 : bars[i].c < e9;
  if (!stacked || !priceAligned) return { fired: false, quality: 0 };
  const recent = bars.slice(-5);
  let structureOk = true;
  for (let k = 1; k < recent.length; k++) {
    if (direction === 'LONG' ? recent[k].h < recent[k - 1].l : recent[k].l > recent[k - 1].h) { structureOk = false; break; }
  }
  if (!structureOk) return { fired: false, quality: 0 };
  const nearEma = Math.abs((bars[i].c - e9) / e9) * 100 < 0.5;
  return { fired: true, quality: Math.round(60 + (nearEma ? 30 : 0) + 10) };
}
function classifyVwapRelationship(price, vwapSeries) {
  const vwap = vwapSeries[vwapSeries.length - 1];
  const prior = vwapSeries[Math.max(0, vwapSeries.length - 6)];
  const rising = vwap > prior;
  const distPct = ((price - vwap) / vwap) * 100;
  if (Math.abs(distPct) < 0.05) return 'AT_VWAP';
  return price > vwap ? (rising ? 'ABOVE_RISING' : 'ABOVE_FALLING') : (rising ? 'BELOW_FALLING' : 'BELOW_RISING');
}
function momentumAccelerationScore(bars, direction) {
  const n = bars.length;
  if (n < 7) return 50;
  const recentRoc = ((bars[n - 1].c - bars[n - 4].c) / bars[n - 4].c) * 100;
  const priorRoc = ((bars[n - 4].c - bars[n - 7].c) / bars[n - 7].c) * 100;
  const signed = direction === 'LONG' ? recentRoc : -recentRoc;
  const signedPrior = direction === 'LONG' ? priorRoc : -priorRoc;
  const base = clamp(50 + signed * 15, 0, 100);
  return Math.round(clamp(signed > signedPrior ? base + 10 : base - 10, 0, 100));
}
function computeExtension(price, vwap, ema9, atr14) {
  if (!atr14 || atr14 <= 0) return { extended: false };
  const distVwapAtr = Math.abs(price - vwap) / atr14;
  const distEma9Atr = Math.abs(price - ema9) / atr14;
  return { extended: distVwapAtr > 2.5 || distEma9Atr > 2.5 };
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
  if (score >= 40) regime = 'STRONG_BULLISH'; else if (score >= 15) regime = 'BULLISH';
  else if (score > -15) regime = 'NEUTRAL'; else if (score > -40) regime = 'BEARISH'; else regime = 'STRONG_BEARISH';
  return { regime, score: Math.round(score), niftyReturnPct, bankNiftyReturnPct, niftyAboveVwap, bankNiftyAboveVwap };
}
const REGIME_BULLISHNESS = { STRONG_BULLISH: 100, BULLISH: 75, NEUTRAL: 50, BEARISH: 25, STRONG_BEARISH: 0 };
function regimeAlignmentScore(regime, direction) {
  const s = REGIME_BULLISHNESS[regime];
  return direction === 'LONG' ? s : 100 - s;
}
function rvolScoreFor(rvol) {
  if (rvol == null) return 40;
  if (rvol < 0.75) return 20; if (rvol < 1.0) return 45; if (rvol < 1.5) return 65; if (rvol < 2.0) return 85; return 95;
}
function vwapPositionScore(lastPrice, avgPrice) {
  if (!avgPrice) return 50;
  return Math.round(clamp(50 + ((lastPrice - avgPrice) / avgPrice) * 100 * 15, 0, 100));
}
function relativeStrengthScoreFor(stockReturnPct, indexReturnPct) {
  const rs = clamp(stockReturnPct - indexReturnPct, -10, 10);
  return clamp(Math.round(50 + rs * 5), 0, 100);
}

const CHECKLIST_LABEL = {
  regimeSupportive: 'Market regime supportive', sectorSupportive: 'Sector supportive',
  relativeStrengthStrong: 'Strong relative strength', vwapAligned: 'Price aligned with VWAP',
  trendAligned: 'Intraday trend aligned (EMA9/20)', validSetup: 'Valid setup structure',
  rvolConfirms: 'Relative volume confirms', stopLogical: 'Stop placed at a logical structural level',
  rrAcceptable: 'Risk/reward acceptable', notExtended: 'Not excessively extended',
};

function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

async function handleScan(supabase, req, res) {
  const apiKey = process.env.KITE_API_KEY;
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!apiKey || !token) { res.status(200).json({ error: 'no_kite_session', message: 'Connect Kite before scanning.' }); return; }
  const ctx = { token, apiKey };

  let settings = DEFAULT_SETTINGS;
  try {
    const { data } = await supabase.from('intraday_settings').select('*').eq('id', 1).maybeSingle();
    if (data) settings = data;
  } catch { /* migration not run yet — use defaults */ }

  try {
    const { data: latestDateRow } = await supabase.from('daily_ohlcv').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    const date = latestDateRow?.date;
    if (!date) { res.status(200).json({ error: 'no_data', message: 'No daily_ohlcv data yet.' }); return; }

    const [{ data: ohlcvRows }, { data: indicatorRows }, { data: stocksRows }] = await Promise.all([
      supabase.from('daily_ohlcv').select('symbol,close').eq('date', date),
      supabase.from('indicators').select('symbol,vol_avg20').eq('date', date),
      supabase.from('stocks').select('symbol,name,sector,instrument_token').eq('active', true),
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
      universe.push({ symbol, name: meta.name, sector: meta.sector, instrumentToken: meta.instrument_token, avgDailyValue, volAvg20 });
    }
    universe.sort((a, b) => b.avgDailyValue - a.avgDailyValue);
    const capped = universe.slice(0, UNIVERSE_CAP);

    const [niftyData, ...batches] = await Promise.all([
      kiteQuote(['NSE:NIFTY 50', 'NSE:NIFTY BANK'], ctx),
      ...chunk(capped, 200).map((c) => kiteQuote(c.map((s) => `NSE:${s.symbol}`), ctx)),
    ]);
    const quoteBySymbol = Object.assign({}, ...batches);
    const nifty = niftyData['NSE:NIFTY 50'];
    const bankNifty = niftyData['NSE:NIFTY BANK'];

    const nowMin = nowMinutesIST();
    const enriched = capped.map((u) => {
      const q = quoteBySymbol[`NSE:${u.symbol}`];
      if (!q || !q.ohlc?.close) return null;
      const returnPct = ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100;
      const aboveVwap = q.average_price ? q.last_price > q.average_price : null;
      const expectedVol = u.volAvg20 * sessionFractionElapsed(nowMin);
      const rvol = expectedVol > 0 ? q.volume / expectedVol : null;
      return { ...u, lastPrice: q.last_price, returnPct, aboveVwap, averagePrice: q.average_price ?? null, volume: q.volume ?? 0, rvol };
    }).filter(Boolean);

    const pctStocksAboveVwap = enriched.length ? (enriched.filter((e) => e.aboveVwap).length / enriched.length) * 100 : null;
    const regimeInfo = regimeFromIndices(nifty, bankNifty, pctStocksAboveVwap);

    const bySector = new Map();
    for (const e of enriched) { if (!e.sector) continue; const l = bySector.get(e.sector) ?? []; l.push(e); bySector.set(e.sector, l); }
    const sectorComposite = new Map();
    for (const [sector, members] of bySector) {
      if (members.length < 3) continue;
      const avgReturn = members.reduce((s, m) => s + m.returnPct, 0) / members.length;
      const pctAbove = (members.filter((m) => m.aboveVwap).length / members.length) * 100;
      sectorComposite.set(sector, avgReturn * 0.7 + (pctAbove - 50) * 0.3);
    }
    const compositeVals = [...sectorComposite.values()];
    const lo = compositeVals.length ? Math.min(...compositeVals) : null, hi = compositeVals.length ? Math.max(...compositeVals) : null;
    const sectorScoreMap = new Map();
    for (const [sector, comp] of sectorComposite) sectorScoreMap.set(sector, hi === lo ? 50 : Math.round(((comp - lo) / (hi - lo)) * 100));

    const ranked = enriched.map((e) => {
      const direction = e.returnPct >= 0 ? 'LONG' : 'SHORT';
      const factors = {
        relativeStrength: relativeStrengthScoreFor(e.returnPct, regimeInfo.niftyReturnPct),
        volume: rvolScoreFor(e.rvol),
        vwapPosition: vwapPositionScore(e.lastPrice, e.averagePrice),
        regimeAlignment: regimeAlignmentScore(regimeInfo.regime, direction),
        sectorStrength: e.sector ? (sectorScoreMap.get(e.sector) ?? 50) : 50,
      };
      const rankScore = Math.round(factors.relativeStrength * 0.30 + factors.volume * 0.25 + factors.vwapPosition * 0.20 + factors.regimeAlignment * 0.15 + factors.sectorStrength * 0.10);
      return { ...e, direction, rankFactors: factors, rankScore };
    }).sort((a, b) => b.rankScore - a.rankScore);

    // ---- Stage 2: setup/signal detection on the shortlist ----
    const shortlist = ranked.slice(0, SETUP_SHORTLIST).filter((c) => c.instrumentToken);
    const today = new Date().toISOString().slice(0, 10);
    const from = `${today} 09:15:00`;
    const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const to = `${today} ${String(nowIst.getHours()).padStart(2, '0')}:${String(nowIst.getMinutes()).padStart(2, '0')}:00`;

    const withSignals = [];
    for (const cand of shortlist) {
      let bars = [];
      try {
        bars = await kiteHistorical(cand.instrumentToken, '5minute', from, to, ctx);
      } catch (e) {
        withSignals.push({ ...cand, signal: { status: 'WATCH', note: `Could not fetch candles: ${e.message}` } });
        continue;
      }
      await sleep(120); // stay well under Kite's historical-API rate limit across the shortlist

      if (bars.length < 4) { withSignals.push({ ...cand, signal: { status: 'WATCH', note: 'Not enough of today\'s bars yet.' } }); continue; }

      const closes = bars.map((b) => b.c);
      const ema9 = ema(closes, 9), ema20 = ema(closes, 20), atr14 = atr(bars, Math.min(14, bars.length - 1 || 1));
      const vwapSeries = computeSessionVWAP(bars);
      const or = computeOpeningRange(bars);
      const last = bars[bars.length - 1];
      const direction = cand.direction;

      const orSig = or ? detectORB(bars, or, direction) : { fired: false, quality: 0 };
      const vwapSig = detectVwapPullback(bars, vwapSeries, direction);
      const emaSig = detectEmaTrendContinuation(bars, ema9, ema20, direction);
      const setups = [
        { type: 'ORB', ...orSig }, { type: 'VWAP_PULLBACK', ...vwapSig }, { type: 'EMA_TREND_CONTINUATION', ...emaSig },
      ].filter((s) => s.fired).sort((a, b) => b.quality - a.quality);
      const bestSetup = setups[0] ?? null;

      const momentumScore = momentumAccelerationScore(bars, direction);
      const vwapRel = classifyVwapRelationship(last.c, vwapSeries);
      const vwapAligned = direction === 'LONG' ? (vwapRel === 'ABOVE_RISING' || vwapRel === 'ABOVE_FALLING') : (vwapRel === 'BELOW_RISING' || vwapRel === 'BELOW_FALLING');
      const trendAligned = ema9[ema9.length - 1] != null && ema20[ema20.length - 1] != null
        && (direction === 'LONG' ? ema9[ema9.length - 1] > ema20[ema20.length - 1] : ema9[ema9.length - 1] < ema20[ema20.length - 1]);
      const currentAtr = atr14[atr14.length - 1];
      const extension = computeExtension(last.c, vwapSeries[vwapSeries.length - 1], ema9[ema9.length - 1] ?? last.c, currentAtr);

      let stop = null;
      if (bestSetup?.type === 'ORB' && or) stop = direction === 'LONG' ? or.low : or.high;
      else if (currentAtr) stop = direction === 'LONG' ? vwapSeries[vwapSeries.length - 1] - 0.5 * currentAtr : vwapSeries[vwapSeries.length - 1] + 0.5 * currentAtr;
      const entry = last.c;
      const riskPerShare = stop != null ? Math.abs(entry - stop) : null;
      const structuralTarget = currentAtr ? (direction === 'LONG' ? entry + 2 * currentAtr : entry - 2 * currentAtr) : null;
      const riskReward = riskPerShare && structuralTarget ? Math.abs(structuralTarget - entry) / riskPerShare : null;
      const target1 = riskPerShare != null ? (direction === 'LONG' ? entry + riskPerShare : entry - riskPerShare) : null;
      const target2 = riskPerShare != null ? (direction === 'LONG' ? entry + 2 * riskPerShare : entry - 2 * riskPerShare) : null;

      const checklist = {
        regimeSupportive: regimeAlignmentScore(regimeInfo.regime, direction) >= 50,
        sectorSupportive: cand.rankFactors.sectorStrength >= 50,
        relativeStrengthStrong: cand.rankFactors.relativeStrength >= 65,
        vwapAligned,
        trendAligned,
        validSetup: !!bestSetup,
        rvolConfirms: cand.rvol != null && cand.rvol >= (settings.min_rvol ?? 1.0),
        stopLogical: riskPerShare != null && riskPerShare > 0,
        rrAcceptable: riskReward != null && riskReward >= (settings.min_risk_reward ?? 1.5),
        notExtended: !extension.extended,
      };
      const allPass = Object.values(checklist).every(Boolean);
      const finalScore = Math.round(
        cand.rankFactors.relativeStrength * 0.20 + momentumScore * 0.15 + cand.rankFactors.volume * 0.15
        + (bestSetup?.quality ?? 0) * 0.15 + cand.rankFactors.vwapPosition * 0.10
        + cand.rankFactors.regimeAlignment * 0.10 + cand.rankFactors.sectorStrength * 0.10 + 100 * 0.05,
      );
      const confidence = finalScore >= 90 ? 'A_PLUS' : finalScore >= 80 ? 'A' : finalScore >= 70 ? 'B' : finalScore >= 60 ? 'WATCH' : 'IGNORE';
      const status = allPass ? 'SIGNAL_CONFIRMED' : bestSetup ? 'FORMING' : 'WATCH';
      const confirmations = Object.keys(checklist).filter((k) => checklist[k]).map((k) => CHECKLIST_LABEL[k]);
      const failures = Object.keys(checklist).filter((k) => !checklist[k]).map((k) => CHECKLIST_LABEL[k]);

      const signal = {
        status, score: finalScore, confidence, setupType: bestSetup?.type ?? null,
        entry, stop, target1, target2, riskReward, confirmations, failures,
      };
      withSignals.push({ ...cand, signal });

      if (status === 'SIGNAL_CONFIRMED') {
        try {
          await supabase.from('intraday_signals').insert({
            symbol: cand.symbol, sector: cand.sector, direction, status, score: finalScore, confidence,
            setup_type: bestSetup?.type ?? null, entry, stop, target1, target2, risk_reward: riskReward,
            market_regime: regimeInfo.regime, signal_components: { rankFactors: cand.rankFactors, checklist, momentumScore },
          });
        } catch { /* migration not run yet — signal still returned live, just not journaled */ }
      }
    }

    const withSignalsBySymbol = new Map(withSignals.map((c) => [c.symbol, c]));
    const finalList = ranked.slice(0, RESULT_LIMIT).map((c) => {
      const withSig = withSignalsBySymbol.get(c.symbol);
      return {
        symbol: c.symbol, name: c.name, sector: c.sector, direction: c.direction,
        price: c.lastPrice, returnPct: c.returnPct, aboveVwap: c.aboveVwap, rvol: c.rvol,
        rankScore: c.rankScore, rankFactors: c.rankFactors,
        signal: withSig?.signal ?? null,
      };
    });

    res.status(200).json({ asOf: new Date().toISOString(), regime: regimeInfo, universeSize: capped.length, candidates: finalList });
  } catch (err) {
    res.status(502).json({ error: 'kite_error', message: err.message });
  }
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
