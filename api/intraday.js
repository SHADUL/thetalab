/**
 * Intraday Trader's one endpoint (query-param dispatch, same reasoning as
 * swing-scanner.js: stay under Vercel Hobby's 12-function cap).
 *
 * `?resource=scan` — two stages:
 *  1. Rank the liquid universe from quote snapshots (return, VWAP position
 *     via Kite's own exchange-computed average_price, RVOL, sector, regime
 *     alignment) — cheap, one quote call for ~150 symbols.
 *  2. For the top-ranked shortlist only, fetch today's 5-min candles
 *     (Kite's historical API) to run real setup detection — all 5 initial
 *     ensemble setups (ORB, VWAP Pullback, EMA Trend Continuation,
 *     Breakout, Breakout Retest) — the 12-point entry checklist, and the
 *     Intraday Score — expensive per-symbol, so deliberately only run on
 *     ~12 candidates, not the whole universe (spec §62's own ranking-
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
 *
 * `?resource=positions` — GET open + recently-closed intraday_positions.
 *
 * `?resource=kill-switch` — POST: disable the engine and immediately
 * square off every OPEN position at market, regardless of stop/target
 * (see handleKillSwitch). A manual override distinct from the Exit
 * Engine's automatic EOD square-off.
 *
 * Execution Engine (paper mode) — when intraday_settings.enabled is true
 * and execution_mode is 'PAPER', a SIGNAL_CONFIRMED candidate is checked
 * against the Risk Engine's daily limits and open-position caps
 * (max_open_positions, max_positions_per_sector, one position per
 * symbol), sized via computePositionSize, and opened as a paper fill at
 * the signal's entry price — all inside the same scan tick, no separate
 * cron. ALERT/SEMI_AUTO/AUTO execution modes are not implemented; only
 * PAPER auto-opens a position.
 *
 * Position Management + Exit Engine (see managePositions) — runs every
 * scan tick against every OPEN position regardless of whether new-entry
 * execution is currently enabled, in priority order: EOD square-off,
 * target2 (full exit), stop (initial risk, or a breakeven "TRAIL" once
 * price has reached target1 and the stop was walked up/down to entry),
 * momentum failure (VWAP/EMA-based setups only, before target1 has
 * proven the trade). Closing a position updates intraday_daily_stats
 * (wins/losses/gross_pnl/consecutive_losses) and re-checks the daily
 * lock so a bad day actually stops new entries mid-session.
 */
import { createClient } from '@supabase/supabase-js';

const KITE_BASE = 'https://api.kite.trade';
export const MIN_PRICE = 50;
export const MIN_AVG_DAILY_VALUE = 20 * 10_000_000; // 20 crore
const UNIVERSE_CAP = 150;
const RESULT_LIMIT = 25;
const SETUP_SHORTLIST = 12;
export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;
export const OR_END_MIN = 9 * 60 + 30;

export const DEFAULT_SETTINGS = {
  min_score: 70, min_risk_reward: 1.5, min_rvol: 1.0, max_extension_atr: 2.5,
  enabled: false, execution_mode: 'PAPER', capital: 0, risk_pct_per_trade: 0.5,
  max_capital_pct_per_trade: 20, max_daily_loss_pct: 2, max_trades_per_day: 5,
  max_consecutive_losses: 3, max_open_positions: 3, max_positions_per_sector: 1,
  square_off_time: '15:15',
};

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function nowMinutesIST() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
export function istMinutesOfDay(epochMs) {
  const ist = new Date(new Date(epochMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
export function sessionFractionElapsed(nowMin) {
  return clamp((nowMin - MARKET_OPEN_MIN) / (MARKET_CLOSE_MIN - MARKET_OPEN_MIN), 0, 1);
}

export async function kiteFetch(path, { token, apiKey }) {
  const resp = await fetch(`${KITE_BASE}${path}`, { headers: { Authorization: `token ${apiKey}:${token}`, 'X-Kite-Version': '3' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') throw new Error(json?.message || `Kite API error (${resp.status}) on ${path}`);
  return json?.data;
}
export async function kiteQuote(instruments, ctx) {
  const qs = instruments.map((i) => `i=${encodeURIComponent(i)}`).join('&');
  return (await kiteFetch(`/quote?${qs}`, ctx)) ?? {};
}
export async function kiteHistorical(token, interval, from, to, ctx) {
  const data = await kiteFetch(`/instruments/historical/${token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, ctx);
  return (data?.candles ?? []).map((c) => ({ t: new Date(c[0]).getTime(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
}
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- pure math (ported from src/intraday/*.ts — see file header) ----

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
export function trueRange(bars) {
  return bars.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
}
export function atr(bars, period) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
  return out;
}
export function computeSessionVWAP(bars) {
  let cumPV = 0, cumV = 0;
  return bars.map((b) => { const tp = (b.h + b.l + b.c) / 3; cumPV += tp * b.v; cumV += b.v; return cumV > 0 ? cumPV / cumV : b.c; });
}
export function computeOpeningRange(bars) {
  const orBars = bars.filter((b) => istMinutesOfDay(b.t) >= MARKET_OPEN_MIN && istMinutesOfDay(b.t) < OR_END_MIN);
  if (orBars.length === 0) return null;
  return { high: Math.max(...orBars.map((b) => b.h)), low: Math.min(...orBars.map((b) => b.l)) };
}
export function detectORB(bars, or, direction) {
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
export function detectVwapPullback(bars, vwapSeries, direction) {
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
export function detectEmaTrendContinuation(bars, ema9, ema20, direction) {
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
const CONSOLIDATION_LOOKBACK = 12;
const MIN_BASE_BARS = 6;
const MAX_BASE_WIDTH_PCT = 1.2;
const RETEST_WINDOW = 6;

export function detectConsolidationRange(bars, lookback = CONSOLIDATION_LOOKBACK) {
  if (bars.length < MIN_BASE_BARS) return null;
  const baseBars = bars.slice(-lookback);
  if (baseBars.length < MIN_BASE_BARS) return null;
  const high = Math.max(...baseBars.map((b) => b.h));
  const low = Math.min(...baseBars.map((b) => b.l));
  const mid = (high + low) / 2;
  const widthPct = mid > 0 ? ((high - low) / mid) * 100 : 0;
  if (widthPct > MAX_BASE_WIDTH_PCT) return null;
  return { high, low, width: high - low };
}
export function detectBreakout(bars, direction, lookback = CONSOLIDATION_LOOKBACK) {
  if (bars.length < lookback + 1) return { fired: false, quality: 0 };
  const base = detectConsolidationRange(bars.slice(0, -1), lookback);
  if (!base) return { fired: false, quality: 0 };
  const last = bars[bars.length - 1];
  const level = direction === 'LONG' ? base.high : base.low;
  const fired = direction === 'LONG' ? last.c > level : last.c < level;
  if (!fired) return { fired: false, quality: 0 };
  const baseBars = bars.slice(-lookback - 1, -1);
  const avgBaseVol = baseBars.reduce((s, b) => s + b.v, 0) / baseBars.length;
  const volExpansion = avgBaseVol > 0 ? last.v / avgBaseVol : 1;
  const breakoutDistancePct = Math.abs((last.c - level) / level) * 100;
  const range = last.h - last.l;
  const closingStrength = range === 0 ? 0.5 : direction === 'LONG' ? (last.c - last.l) / range : (last.h - last.c) / range;
  return { fired: true, quality: Math.round(clamp(40 + breakoutDistancePct * 15 + closingStrength * 25 + Math.min(volExpansion, 3) * 10, 0, 100)) };
}
export function detectBreakoutRetest(bars, direction, lookback = CONSOLIDATION_LOOKBACK) {
  const n = bars.length;
  if (n < lookback + RETEST_WINDOW + 1) return { fired: false, quality: 0 };
  const base = detectConsolidationRange(bars.slice(0, n - RETEST_WINDOW), lookback);
  if (!base) return { fired: false, quality: 0 };
  const level = direction === 'LONG' ? base.high : base.low;
  const retestWindow = bars.slice(n - RETEST_WINDOW);
  const breakoutBarIdx = retestWindow.findIndex((b) => (direction === 'LONG' ? b.c > level : b.c < level));
  if (breakoutBarIdx === -1 || breakoutBarIdx >= retestWindow.length - 1) return { fired: false, quality: 0 };
  const afterBreakout = retestWindow.slice(breakoutBarIdx + 1);
  const pulledToLevel = afterBreakout.some((b) => (direction === 'LONG' ? b.l <= level * 1.002 : b.h >= level * 0.998));
  const last = afterBreakout[afterBreakout.length - 1];
  const heldLevel = direction === 'LONG' ? last.l >= level * 0.997 : last.h <= level * 1.003;
  const resumed = direction === 'LONG' ? last.c > last.o && last.c > level : last.c < last.o && last.c < level;
  if (!(pulledToLevel && heldLevel && resumed)) return { fired: false, quality: 0 };
  const breakoutBarVol = retestWindow[breakoutBarIdx].v;
  const retestBars = afterBreakout.slice(0, -1);
  const retestVol = retestBars.length ? retestBars.reduce((s, b) => s + b.v, 0) / retestBars.length : breakoutBarVol;
  const volDeclinedOnRetest = breakoutBarVol > 0 && retestVol < breakoutBarVol;
  return { fired: true, quality: Math.round(75 + (volDeclinedOnRetest ? 15 : 0) + 10) };
}
export function classifyVwapRelationship(price, vwapSeries) {
  const vwap = vwapSeries[vwapSeries.length - 1];
  const prior = vwapSeries[Math.max(0, vwapSeries.length - 6)];
  const rising = vwap > prior;
  const distPct = ((price - vwap) / vwap) * 100;
  if (Math.abs(distPct) < 0.05) return 'AT_VWAP';
  return price > vwap ? (rising ? 'ABOVE_RISING' : 'ABOVE_FALLING') : (rising ? 'BELOW_FALLING' : 'BELOW_RISING');
}
export function momentumAccelerationScore(bars, direction) {
  const n = bars.length;
  if (n < 7) return 50;
  const recentRoc = ((bars[n - 1].c - bars[n - 4].c) / bars[n - 4].c) * 100;
  const priorRoc = ((bars[n - 4].c - bars[n - 7].c) / bars[n - 7].c) * 100;
  const signed = direction === 'LONG' ? recentRoc : -recentRoc;
  const signedPrior = direction === 'LONG' ? priorRoc : -priorRoc;
  const base = clamp(50 + signed * 15, 0, 100);
  return Math.round(clamp(signed > signedPrior ? base + 10 : base - 10, 0, 100));
}
export function computeExtension(price, vwap, ema9, atr14, maxExtensionAtr = 2.5) {
  if (!atr14 || atr14 <= 0) return { extended: false };
  const distVwapAtr = Math.abs(price - vwap) / atr14;
  const distEma9Atr = Math.abs(price - ema9) / atr14;
  return { extended: distVwapAtr > maxExtensionAtr || distEma9Atr > maxExtensionAtr };
}

export function regimeFromIndices(nifty, bankNifty, pctStocksAboveVwap) {
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
export function regimeAlignmentScore(regime, direction) {
  const s = REGIME_BULLISHNESS[regime];
  return direction === 'LONG' ? s : 100 - s;
}
export function rvolScoreFor(rvol) {
  if (rvol == null) return 40;
  if (rvol < 0.75) return 20; if (rvol < 1.0) return 45; if (rvol < 1.5) return 65; if (rvol < 2.0) return 85; return 95;
}
export function vwapPositionScore(lastPrice, avgPrice) {
  if (!avgPrice) return 50;
  return Math.round(clamp(50 + ((lastPrice - avgPrice) / avgPrice) * 100 * 15, 0, 100));
}
export function relativeStrengthScoreFor(stockReturnPct, indexReturnPct) {
  const rs = clamp(stockReturnPct - indexReturnPct, -10, 10);
  return clamp(Math.round(50 + rs * 5), 0, 100);
}

const MIN_SECTOR_MEMBERS = 3;

/**
 * Cross-sectional sector strength — ranked against every other sector
 * present right now (in the given `entries`), not a fixed bar. `entries`
 * needs only `{ sector, returnPct, aboveVwap }` per stock; a sector with
 * fewer than MIN_SECTOR_MEMBERS members isn't ranked (too few members to
 * mean anything) and its stocks fall back to a neutral 50 score.
 */
export function computeSectorScores(entries) {
  const bySector = new Map();
  for (const e of entries) { if (!e.sector) continue; const l = bySector.get(e.sector) ?? []; l.push(e); bySector.set(e.sector, l); }
  const composite = new Map();
  for (const [sector, members] of bySector) {
    if (members.length < MIN_SECTOR_MEMBERS) continue;
    const avgReturn = members.reduce((s, m) => s + m.returnPct, 0) / members.length;
    const pctAbove = (members.filter((m) => m.aboveVwap).length / members.length) * 100;
    composite.set(sector, avgReturn * 0.7 + (pctAbove - 50) * 0.3);
  }
  const compositeVals = [...composite.values()];
  const lo = compositeVals.length ? Math.min(...compositeVals) : null;
  const hi = compositeVals.length ? Math.max(...compositeVals) : null;
  const scoreMap = new Map();
  for (const [sector, comp] of composite) scoreMap.set(sector, hi === lo ? 50 : Math.round(((comp - lo) / (hi - lo)) * 100));
  return scoreMap;
}
export function sectorScoreFor(sector, scoreMap) {
  if (!sector) return 50;
  return scoreMap.get(sector) ?? 50;
}

export const CHECKLIST_LABEL = {
  regimeSupportive: 'Market regime supportive', sectorSupportive: 'Sector supportive',
  relativeStrengthStrong: 'Strong relative strength', vwapAligned: 'Price aligned with VWAP',
  trendAligned: 'Intraday trend aligned (EMA9/20)', validSetup: 'Valid setup structure',
  rvolConfirms: 'Relative volume confirms', stopLogical: 'Stop placed at a logical structural level',
  rrAcceptable: 'Risk/reward acceptable', notExtended: 'Not excessively extended',
};

export function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

/**
 * Evaluates one candidate's setup/signal/trade-plan given its point-in-
 * time bar history — the SINGLE function both the live scan (on today's
 * bars-so-far) and the backtest engine (on a historical bars[0..i]
 * slice) call, so the two can never evaluate a signal differently.
 * `rankFactors`/`rvol` are the ranking-pass outputs the caller already
 * computed (relativeStrength, volume, vwapPosition, regimeAlignment,
 * sectorStrength); this function only adds the setup-detection/
 * checklist/trade-plan layer on top.
 */
export function evaluateIntradaySignal({ bars, direction, regimeInfo, rankFactors, rvol, settings }) {
  const closes = bars.map((b) => b.c);
  const ema9 = ema(closes, 9), ema20 = ema(closes, 20), atr14 = atr(bars, Math.min(14, bars.length - 1 || 1));
  const vwapSeries = computeSessionVWAP(bars);
  const or = computeOpeningRange(bars);
  const last = bars[bars.length - 1];

  const orSig = or ? detectORB(bars, or, direction) : { fired: false, quality: 0 };
  const vwapSig = detectVwapPullback(bars, vwapSeries, direction);
  const emaSig = detectEmaTrendContinuation(bars, ema9, ema20, direction);
  const breakoutSig = detectBreakout(bars, direction);
  const retestSig = detectBreakoutRetest(bars, direction);
  const setups = [
    { type: 'ORB', ...orSig }, { type: 'VWAP_PULLBACK', ...vwapSig }, { type: 'EMA_TREND_CONTINUATION', ...emaSig },
    { type: 'BREAKOUT', ...breakoutSig }, { type: 'BREAKOUT_RETEST', ...retestSig },
  ].filter((s) => s.fired).sort((a, b) => b.quality - a.quality);
  const bestSetup = setups[0] ?? null;

  const momentumScore = momentumAccelerationScore(bars, direction);
  const vwapRel = classifyVwapRelationship(last.c, vwapSeries);
  const vwapAligned = direction === 'LONG' ? (vwapRel === 'ABOVE_RISING' || vwapRel === 'ABOVE_FALLING') : (vwapRel === 'BELOW_RISING' || vwapRel === 'BELOW_FALLING');
  const trendAligned = ema9[ema9.length - 1] != null && ema20[ema20.length - 1] != null
    && (direction === 'LONG' ? ema9[ema9.length - 1] > ema20[ema20.length - 1] : ema9[ema9.length - 1] < ema20[ema20.length - 1]);
  const currentAtr = atr14[atr14.length - 1];
  const extension = computeExtension(last.c, vwapSeries[vwapSeries.length - 1], ema9[ema9.length - 1] ?? last.c, currentAtr, settings.max_extension_atr ?? 2.5);

  const baseRange = detectConsolidationRange(bars.slice(0, -1));
  let stop = null;
  if (bestSetup?.type === 'ORB' && or) stop = direction === 'LONG' ? or.low : or.high;
  else if ((bestSetup?.type === 'BREAKOUT' || bestSetup?.type === 'BREAKOUT_RETEST') && baseRange) stop = direction === 'LONG' ? baseRange.low : baseRange.high;
  else if (currentAtr) stop = direction === 'LONG' ? vwapSeries[vwapSeries.length - 1] - 0.5 * currentAtr : vwapSeries[vwapSeries.length - 1] + 0.5 * currentAtr;
  const entry = last.c;
  const riskPerShare = stop != null ? Math.abs(entry - stop) : null;
  const structuralTarget = currentAtr ? (direction === 'LONG' ? entry + 2 * currentAtr : entry - 2 * currentAtr) : null;
  const riskReward = riskPerShare && structuralTarget ? Math.abs(structuralTarget - entry) / riskPerShare : null;
  const target1 = riskPerShare != null ? (direction === 'LONG' ? entry + riskPerShare : entry - riskPerShare) : null;
  const target2 = riskPerShare != null ? (direction === 'LONG' ? entry + 2 * riskPerShare : entry - 2 * riskPerShare) : null;

  const checklist = {
    regimeSupportive: regimeAlignmentScore(regimeInfo.regime, direction) >= 50,
    sectorSupportive: rankFactors.sectorStrength >= 50,
    relativeStrengthStrong: rankFactors.relativeStrength >= 65,
    vwapAligned,
    trendAligned,
    validSetup: !!bestSetup,
    rvolConfirms: rvol != null && rvol >= (settings.min_rvol ?? 1.0),
    stopLogical: riskPerShare != null && riskPerShare > 0,
    rrAcceptable: riskReward != null && riskReward >= (settings.min_risk_reward ?? 1.5),
    notExtended: !extension.extended,
  };
  const allPass = Object.values(checklist).every(Boolean);
  const finalScore = Math.round(
    rankFactors.relativeStrength * 0.20 + momentumScore * 0.15 + rankFactors.volume * 0.15
    + (bestSetup?.quality ?? 0) * 0.15 + rankFactors.vwapPosition * 0.10
    + rankFactors.regimeAlignment * 0.10 + rankFactors.sectorStrength * 0.10 + 100 * 0.05,
  );
  const confidence = finalScore >= 90 ? 'A_PLUS' : finalScore >= 80 ? 'A' : finalScore >= 70 ? 'B' : finalScore >= 60 ? 'WATCH' : 'IGNORE';
  const status = allPass && finalScore >= (settings.min_score ?? 70) ? 'SIGNAL_CONFIRMED' : bestSetup ? 'FORMING' : 'WATCH';
  const confirmations = Object.keys(checklist).filter((k) => checklist[k]).map((k) => CHECKLIST_LABEL[k]);
  const failures = Object.keys(checklist).filter((k) => !checklist[k]).map((k) => CHECKLIST_LABEL[k]);

  return {
    status, score: finalScore, confidence, setupType: bestSetup?.type ?? null,
    entry, stop, target1, target2, riskReward, confirmations, failures,
  };
}

// ---- Execution Engine (paper mode) — ported from src/intraday/risk.ts ----

export function computePositionSize({ capital, riskPct, entry, stop, maxCapitalAllocationPct }) {
  const riskAmount = capital * (riskPct / 100);
  const riskPerShare = Math.abs(entry - stop);
  if (riskPerShare <= 0 || entry <= 0) return { shares: 0, riskAmount, capitalUsed: 0, limitedBy: 'NEITHER' };
  const sharesByRisk = Math.floor(riskAmount / riskPerShare);
  const maxCapital = capital * (maxCapitalAllocationPct / 100);
  const sharesByCapital = Math.floor(maxCapital / entry);
  const shares = Math.max(0, Math.min(sharesByRisk, sharesByCapital));
  const limitedBy = sharesByRisk === sharesByCapital ? 'NEITHER' : shares === sharesByRisk ? 'RISK' : 'CAPITAL';
  return { shares, riskAmount, capitalUsed: shares * entry, limitedBy };
}
export function checkDailyRiskLimits({ dailyPnl, capital, maxDailyLossPct, tradesToday, maxTrades, consecutiveLosses, maxConsecutiveLosses }) {
  const maxLossAmount = capital * (maxDailyLossPct / 100);
  if (dailyPnl <= -maxLossAmount) return { locked: true, reason: 'MAX_DAILY_LOSS' };
  if (tradesToday >= maxTrades) return { locked: true, reason: 'MAX_TRADES' };
  if (consecutiveLosses >= maxConsecutiveLosses) return { locked: true, reason: 'MAX_CONSECUTIVE_LOSSES' };
  return { locked: false, reason: null };
}

/**
 * Opens a paper position for a SIGNAL_CONFIRMED candidate, gated by the
 * Risk Engine's daily limits and open-position caps. Mutates nothing —
 * returns whether it opened one so the caller can update its in-memory
 * openPositions/dailyStats view for the rest of this scan pass (so a
 * second confirmed signal in the same tick sees the first one's effect
 * without a redundant DB round-trip).
 */
async function tryOpenPaperPosition(supabase, settings, ctx) {
  const { symbol, sector, direction, signal, signalId, regime, today, openPositions, dailyStats } = ctx;

  const limits = checkDailyRiskLimits({
    dailyPnl: dailyStats?.gross_pnl ?? 0,
    capital: settings.capital,
    maxDailyLossPct: settings.max_daily_loss_pct,
    tradesToday: dailyStats?.trades_taken ?? 0,
    maxTrades: settings.max_trades_per_day,
    consecutiveLosses: dailyStats?.consecutive_losses ?? 0,
    maxConsecutiveLosses: settings.max_consecutive_losses,
  });
  if (limits.locked || dailyStats?.locked) return false;

  if (openPositions.length >= settings.max_open_positions) return false;
  if (openPositions.some((p) => p.symbol === symbol)) return false;
  if (sector && openPositions.filter((p) => p.sector === sector).length >= settings.max_positions_per_sector) return false;

  if (signal.entry == null || signal.stop == null) return false;
  const sizing = computePositionSize({
    capital: settings.capital, riskPct: settings.risk_pct_per_trade,
    entry: signal.entry, stop: signal.stop, maxCapitalAllocationPct: settings.max_capital_pct_per_trade,
  });
  if (!sizing.shares || sizing.shares <= 0) return false;

  try {
    // supabase-js does NOT throw on a query/write error (missing table, RLS
    // denial, constraint violation) — it resolves with { data: null, error }.
    // Both the insert and the upsert's `error` must be checked explicitly;
    // relying on try/catch alone would silently report success on a no-op.
    const { error: insertError } = await supabase.from('intraday_positions').insert({
      signal_id: signalId, symbol, sector, direction, status: 'OPEN', mode: 'PAPER',
      entry_price: signal.entry, shares: sizing.shares, stop: signal.stop, target1: signal.target1, target2: signal.target2,
      score_at_entry: signal.score, setup_type: signal.setupType, market_regime_at_entry: regime,
    });
    if (insertError) return false;
    const { error: statsError } = await supabase.from('intraday_daily_stats').upsert({
      date: today,
      trades_taken: (dailyStats?.trades_taken ?? 0) + 1,
      wins: dailyStats?.wins ?? 0, losses: dailyStats?.losses ?? 0,
      gross_pnl: dailyStats?.gross_pnl ?? 0, consecutive_losses: dailyStats?.consecutive_losses ?? 0,
      locked: dailyStats?.locked ?? false, lock_reason: dailyStats?.lock_reason ?? null,
    });
    if (statsError) return true; // the position itself was opened; the daily counter just didn't bump — still surfaced honestly via `open`
    return true;
  } catch {
    return false; // network-level failure — the position was not opened
  }
}

// ---- Position Management + Exit Engine ----

export function parseSquareOffMinutes(str) {
  const [hh, mm] = String(str || '15:15').split(':').map(Number);
  return hh * 60 + mm;
}

/**
 * Closes one position and folds its P&L into the day's running stats
 * (wins/losses/gross_pnl/consecutive_losses), re-checking the daily lock
 * afterward — the single accounting path shared by the Exit Engine's
 * automatic exits and the manual kill-switch square-off, so the two can
 * never drift out of sync on how a closed trade affects the day's risk
 * state. riskPerShare is derived from target1 (always exactly 1R from
 * entry by construction) rather than a stored field, since the stop may
 * have since been trailed to breakeven.
 */
async function closePositionAndRecordStats(supabase, settings, position, exitPrice, exitReason, dailyStats, today) {
  const riskPerShare = position.target1 != null ? Math.abs(position.target1 - position.entry_price) : null;
  const signedMove = position.direction === 'LONG' ? exitPrice - position.entry_price : position.entry_price - exitPrice;
  const pnl = signedMove * position.shares;
  const rMultiple = riskPerShare ? signedMove / riskPerShare : null;

  try {
    const { error } = await supabase.from('intraday_positions').update({
      status: 'CLOSED', exit_time: new Date().toISOString(), exit_price: exitPrice,
      exit_reason: exitReason, r_multiple: rMultiple, pnl,
    }).eq('id', position.id);
    if (error) return { closed: false, dailyStats };

    const isWin = pnl > 0;
    const stats = {
      trades_taken: dailyStats?.trades_taken ?? 0,
      wins: (dailyStats?.wins ?? 0) + (isWin ? 1 : 0),
      losses: (dailyStats?.losses ?? 0) + (isWin ? 0 : 1),
      gross_pnl: (dailyStats?.gross_pnl ?? 0) + pnl,
      consecutive_losses: isWin ? 0 : (dailyStats?.consecutive_losses ?? 0) + 1,
      locked: false, lock_reason: null,
    };
    const limitCheck = checkDailyRiskLimits({
      dailyPnl: stats.gross_pnl, capital: settings.capital, maxDailyLossPct: settings.max_daily_loss_pct,
      tradesToday: stats.trades_taken, maxTrades: settings.max_trades_per_day,
      consecutiveLosses: stats.consecutive_losses, maxConsecutiveLosses: settings.max_consecutive_losses,
    });
    stats.locked = limitCheck.locked;
    stats.lock_reason = limitCheck.reason;
    await supabase.from('intraday_daily_stats').upsert({ date: today, ...stats });
    return { closed: true, dailyStats: stats, pnl };
  } catch {
    return { closed: false, dailyStats };
  }
}

/**
 * Runs every scan tick against every OPEN paper position, independent of
 * whether new-entry execution is currently enabled — a position that was
 * already opened must still be managed (EOD square-off above all) even
 * if the user later flips Paper Execution off. Exit priority: EOD square-
 * off > target2 (full exit) > stop (initial risk, or a breakeven "TRAIL"
 * once already moved there) > momentum failure (VWAP/EMA-based setups
 * only, before target1 has proven the trade). Once price reaches
 * target1, the stop is walked up/down to breakeven exactly once — target1
 * itself is always exactly 1R from entry by construction (buildTradePlan
 * never mutates it), so it doubles as the risk-per-share basis for
 * R-multiple even after the stop has been trailed.
 */
async function managePositions(supabase, settings, openPositions, dailyStats, quoteBySymbol, today) {
  let stats = dailyStats;
  const stillOpen = [];
  const nowMin = nowMinutesIST();
  const squareOffDue = nowMin >= MARKET_CLOSE_MIN || nowMin >= parseSquareOffMinutes(settings.square_off_time);

  for (const original of openPositions) {
    let p = original;
    const q = quoteBySymbol[`NSE:${p.symbol}`];
    if (!q) { stillOpen.push(p); continue; }
    const price = q.last_price;
    const riskPerShare = p.target1 != null ? Math.abs(p.target1 - p.entry_price) : null;
    const target1Hit = riskPerShare != null && (p.direction === 'LONG' ? price >= p.target1 : price <= p.target1);
    const target2Hit = p.target2 != null && (p.direction === 'LONG' ? price >= p.target2 : price <= p.target2);
    const stopHit = p.stop != null && (p.direction === 'LONG' ? price <= p.stop : price >= p.stop);

    let exitReason = null, exitPrice = null;
    if (squareOffDue) { exitReason = 'EOD_SQUAREOFF'; exitPrice = price; }
    else if (target2Hit) { exitReason = 'TARGET2'; exitPrice = p.target2; }
    else if (stopHit) {
      const atBreakeven = Math.abs(p.stop - p.entry_price) < 1e-6 * Math.max(1, p.entry_price);
      exitReason = atBreakeven ? 'TRAIL' : 'STOP';
      exitPrice = p.stop;
    } else if (!target1Hit && q.average_price && (p.setup_type === 'VWAP_PULLBACK' || p.setup_type === 'EMA_TREND_CONTINUATION')) {
      const wrongSide = p.direction === 'LONG' ? price < q.average_price * 0.9995 : price > q.average_price * 1.0005;
      if (wrongSide) { exitReason = 'MOMENTUM_FAILURE'; exitPrice = price; }
    }

    if (exitReason) {
      const result = await closePositionAndRecordStats(supabase, settings, p, exitPrice, exitReason, stats, today);
      if (!result.closed) { stillOpen.push(p); continue; }
      stats = result.dailyStats;
      continue;
    }

    if (target1Hit && p.stop != null) {
      const shouldTrailToBreakeven = p.direction === 'LONG' ? p.stop < p.entry_price : p.stop > p.entry_price;
      if (shouldTrailToBreakeven) {
        try {
          const { error } = await supabase.from('intraday_positions').update({ stop: p.entry_price }).eq('id', p.id);
          if (!error) p = { ...p, stop: p.entry_price };
        } catch { /* trail failed — keep the original stop and try again next tick */ }
      }
    }
    stillOpen.push(p);
  }
  return { openPositions: stillOpen, dailyStats: stats };
}

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

    // ---- Position Management + Exit Engine — runs whenever positions
    // exist, independent of whether new-entry execution is enabled, so
    // EOD square-off and stop/target exits still fire even if the user
    // has since turned Paper Execution off. ----
    const today = new Date().toISOString().slice(0, 10);
    let openPositions = [];
    let dailyStats = null;
    let executionAvailable = false;
    try {
      const [posResult, statsResult] = await Promise.all([
        supabase.from('intraday_positions').select('*').eq('status', 'OPEN'),
        supabase.from('intraday_daily_stats').select('*').eq('date', today).maybeSingle(),
      ]);
      // supabase-js resolves with { data: null, error } rather than throwing
      // on a missing table — both must be error-checked explicitly, or a
      // not-yet-migrated schema would be silently treated as "available
      // with zero rows" instead of "unavailable".
      if (!posResult.error && !statsResult.error) {
        openPositions = posResult.data ?? [];
        dailyStats = statsResult.data ?? null;
        executionAvailable = true;
      }
    } catch { /* network-level failure — execution stays off, scan itself still works */ }

    if (executionAvailable && openPositions.length > 0) {
      const managed = await managePositions(supabase, settings, openPositions, dailyStats, quoteBySymbol, today);
      openPositions = managed.openPositions;
      dailyStats = managed.dailyStats;
    }

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

    const sectorScoreMap = computeSectorScores(enriched);

    const ranked = enriched.map((e) => {
      const direction = e.returnPct >= 0 ? 'LONG' : 'SHORT';
      const factors = {
        relativeStrength: relativeStrengthScoreFor(e.returnPct, regimeInfo.niftyReturnPct),
        volume: rvolScoreFor(e.rvol),
        vwapPosition: vwapPositionScore(e.lastPrice, e.averagePrice),
        regimeAlignment: regimeAlignmentScore(regimeInfo.regime, direction),
        sectorStrength: sectorScoreFor(e.sector, sectorScoreMap),
      };
      const rankScore = Math.round(factors.relativeStrength * 0.30 + factors.volume * 0.25 + factors.vwapPosition * 0.20 + factors.regimeAlignment * 0.15 + factors.sectorStrength * 0.10);
      return { ...e, direction, rankFactors: factors, rankScore };
    }).sort((a, b) => b.rankScore - a.rankScore);

    // ---- Stage 2: setup/signal detection on the shortlist ----
    const shortlist = ranked.slice(0, SETUP_SHORTLIST).filter((c) => c.instrumentToken);
    const from = `${today} 09:15:00`;
    const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const to = `${today} ${String(nowIst.getHours()).padStart(2, '0')}:${String(nowIst.getMinutes()).padStart(2, '0')}:00`;

    const executionOn = executionAvailable && settings.enabled && settings.execution_mode === 'PAPER';

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

      const direction = cand.direction;
      const signal = evaluateIntradaySignal({ bars, direction, regimeInfo, rankFactors: cand.rankFactors, rvol: cand.rvol, settings });
      withSignals.push({ ...cand, signal });

      if (status === 'SIGNAL_CONFIRMED') {
        let signalId = null;
        try {
          const { data: inserted } = await supabase.from('intraday_signals').insert({
            symbol: cand.symbol, sector: cand.sector, direction, status, score: finalScore, confidence,
            setup_type: bestSetup?.type ?? null, entry, stop, target1, target2, risk_reward: riskReward,
            market_regime: regimeInfo.regime, signal_components: { rankFactors: cand.rankFactors, checklist, momentumScore },
          }).select('id').single();
          signalId = inserted?.id ?? null;
        } catch { /* migration not run yet — signal still returned live, just not journaled */ }

        if (executionOn) {
          const opened = await tryOpenPaperPosition(supabase, settings, {
            symbol: cand.symbol, sector: cand.sector, direction, signal, signalId, regime: regimeInfo.regime, today,
            openPositions, dailyStats,
          });
          if (opened) {
            openPositions = [...openPositions, { symbol: cand.symbol, sector: cand.sector }];
            dailyStats = {
              gross_pnl: dailyStats?.gross_pnl ?? 0, wins: dailyStats?.wins ?? 0, losses: dailyStats?.losses ?? 0,
              consecutive_losses: dailyStats?.consecutive_losses ?? 0, locked: dailyStats?.locked ?? false,
              lock_reason: dailyStats?.lock_reason ?? null, trades_taken: (dailyStats?.trades_taken ?? 0) + 1,
            };
          }
        }
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

async function handlePositions(supabase, req, res) {
  try {
    const [openResult, closedResult] = await Promise.all([
      supabase.from('intraday_positions').select('*').eq('status', 'OPEN').order('entry_time', { ascending: false }),
      supabase.from('intraday_positions').select('*').eq('status', 'CLOSED').order('exit_time', { ascending: false }).limit(20),
    ]);
    if (openResult.error || closedResult.error) {
      res.status(200).json({ open: [], closed: [], error: 'not_available', message: 'Run the intraday schema migration to enable paper positions.' });
      return;
    }
    res.status(200).json({ open: openResult.data ?? [], closed: closedResult.data ?? [] });
  } catch {
    res.status(200).json({ open: [], closed: [], error: 'not_available', message: 'Run the intraday schema migration to enable paper positions.' });
  }
}

/**
 * Kill switch + emergency square-off (`?resource=kill-switch`, POST) — a
 * manual override distinct from the Exit Engine's automatic EOD square-
 * off. Always disables intraday_settings.enabled first (so no new paper
 * position can open even if everything after this fails), then fetches
 * a single fresh quote batch and closes every OPEN position immediately
 * at the current price with exit_reason 'MANUAL', regardless of where
 * price sits relative to stop/target. Reuses the same
 * closePositionAndRecordStats accounting path as the Exit Engine so a
 * kill-switch close affects the day's risk stats identically to a
 * normal one.
 */
async function handleKillSwitch(supabase, req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const { error: disableError } = await supabase.from('intraday_settings').update({ enabled: false, updated_at: new Date().toISOString() }).eq('id', 1);
  const disabled = !disableError;

  const { data: openPositions, error: posError } = await supabase.from('intraday_positions').select('*').eq('status', 'OPEN');
  if (posError) {
    res.status(200).json({ ok: true, disabled, closed: [], stillOpen: [], message: 'Engine disabled. Could not read open positions — run the intraday schema migration.' });
    return;
  }
  const positions = openPositions ?? [];
  if (positions.length === 0) { res.status(200).json({ ok: true, disabled, closed: [], stillOpen: [] }); return; }

  const apiKey = process.env.KITE_API_KEY;
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!apiKey || !token) {
    res.status(200).json({
      ok: true, disabled, closed: [], stillOpen: positions.map((p) => p.symbol),
      message: 'Engine disabled, but no Kite session — could not fetch prices to square off open positions. Reconnect Kite and retry, or close them manually.',
    });
    return;
  }

  let settings = DEFAULT_SETTINGS;
  try {
    const { data } = await supabase.from('intraday_settings').select('*').eq('id', 1).maybeSingle();
    if (data) settings = data;
  } catch { /* use defaults */ }

  const today = new Date().toISOString().slice(0, 10);
  let dailyStats = null;
  try {
    const { data } = await supabase.from('intraday_daily_stats').select('*').eq('date', today).maybeSingle();
    dailyStats = data ?? null;
  } catch { /* stats just won't reflect these closes */ }

  let quoteBySymbol = {};
  try {
    quoteBySymbol = await kiteQuote(positions.map((p) => `NSE:${p.symbol}`), { token, apiKey });
  } catch { /* every position falls through to stillOpen below */ }

  const closed = [];
  const stillOpen = [];
  for (const p of positions) {
    const q = quoteBySymbol[`NSE:${p.symbol}`];
    if (!q) { stillOpen.push(p.symbol); continue; }
    const result = await closePositionAndRecordStats(supabase, settings, p, q.last_price, 'MANUAL', dailyStats, today);
    if (!result.closed) { stillOpen.push(p.symbol); continue; }
    dailyStats = result.dailyStats;
    closed.push({ symbol: p.symbol, exitPrice: q.last_price, pnl: result.pnl });
  }

  res.status(200).json({ ok: true, disabled, closed, stillOpen });
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
  if (resource === 'positions') { await handlePositions(supabase, req, res); return; }
  if (resource === 'kill-switch') { await handleKillSwitch(supabase, req, res); return; }
  res.status(400).json({ error: 'bad_request', message: `Unknown resource "${resource}".` });
}
