/**
 * Intraday Naked Sell — pure strategy engine (no I/O).
 *
 * Reads the intraday trend of the index from completed 5-minute candles and
 * sells ONE naked option in the trend's direction:
 *   BULLISH → sell PE (collect premium while price rises / holds)
 *   BEARISH → sell CE
 *   NEUTRAL → no trade
 *
 * Exits (whichever first):
 *   TP          option premium decays by tpPct (default 40%)
 *   SL          option premium rises by slPct (default 30%) — the hard stop
 *   TREND_FLIP  the intraday trend turns against the position
 *   SQUARE_OFF  15:15 IST — never carried overnight
 *
 * Launch scope (owner decision 2026-11-12): PAPER + SHADOW only — never a
 * real order. SHADOW applies the same liquidity realism as the main
 * options engine (≤5% bid/ask spread, ≥100 contracts traded) and fills at
 * the bid on entry / ask on exit; PAPER fills at mid with no gate.
 */
import { black76, impliedVol } from '../quant/pricing/black76.ts';

export type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type Right = 'CE' | 'PE';
export type ExitReason = 'TP' | 'SL' | 'TREND_FLIP' | 'SQUARE_OFF' | 'MANUAL';

export interface Candle { t: string; o: number; h: number; l: number; c: number }

export interface NakedSellSettings {
  enabled: boolean;
  paper_enabled: boolean;
  shadow_enabled: boolean;
  symbols: string[];
  lots: number;
  target_delta: number;      // 0.30
  tp_pct: number;            // 40
  sl_pct: number;            // 30
  entry_start_min: number;   // minutes after midnight IST, 585 = 09:45
  entry_end_min: number;     // 870 = 14:30
  square_off_min: number;    // 915 = 15:15
  max_entries_per_day: number;
  max_daily_loss: number;    // ₹, per mode
  cooldown_min: number;
  allow_expiry_day: boolean;
  max_spread_pct: number;    // SHADOW liquidity gate
  min_volume: number;        // SHADOW liquidity gate
}

export const DEFAULT_SETTINGS: NakedSellSettings = {
  enabled: true, paper_enabled: true, shadow_enabled: true, symbols: ['NIFTY', 'SENSEX'], lots: 1,
  target_delta: 0.3, tp_pct: 40, sl_pct: 30, entry_start_min: 585, entry_end_min: 870, square_off_min: 915,
  max_entries_per_day: 2, max_daily_loss: 5000, cooldown_min: 15, allow_expiry_day: false,
  max_spread_pct: 5, min_volume: 100,
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------ */
/* Trend                                                                */
/* ------------------------------------------------------------------ */

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

export interface TrendResult {
  state: Trend;
  reason: string;
  bars: number;
  lastClose: number | null;
  sessionAvg: number | null;
  ema9: number | null;
  ema21: number | null;
  emaGapPct: number | null;
}

/** Minimum completed 5-minute bars before any signal (6 bars = 09:45). */
export const MIN_TREND_BARS = 6;
/** EMA9/EMA21 separation (as % of price) below which the trend is treated as flat. */
export const MIN_EMA_GAP_PCT = 0.03;

/**
 * Intraday trend from COMPLETED 5-minute index candles of today's session.
 * The index has no volume, so the session anchor is the equal-weight average
 * of typical price (h+l+c)/3 — a TWAP, used where VWAP would be on a stock.
 *
 * BULLISH needs all three: close above the session average, EMA9 above
 * EMA21 by at least MIN_EMA_GAP_PCT, and close above EMA9. BEARISH mirrors.
 */
export function intradayTrend(bars: Candle[]): TrendResult {
  const empty = { lastClose: null, sessionAvg: null, ema9: null, ema21: null, emaGapPct: null };
  if (bars.length < MIN_TREND_BARS) {
    return { state: 'NEUTRAL', reason: `only ${bars.length} completed 5-min bars (need ${MIN_TREND_BARS})`, bars: bars.length, ...empty };
  }
  const closes = bars.map((b) => b.c);
  const sessionAvg = bars.reduce((s, b) => s + (b.h + b.l + b.c) / 3, 0) / bars.length;
  const e9 = ema(closes, 9).at(-1)!;
  const e21 = ema(closes, 21).at(-1)!;
  const close = closes.at(-1)!;
  const gapPct = ((e9 - e21) / close) * 100;
  const base = { bars: bars.length, lastClose: r2(close), sessionAvg: r2(sessionAvg), ema9: r2(e9), ema21: r2(e21), emaGapPct: Math.round(gapPct * 1000) / 1000 };

  if (close > sessionAvg && gapPct >= MIN_EMA_GAP_PCT && close > e9) {
    return { state: 'BULLISH', reason: 'close above session average, EMA9 above EMA21, close above EMA9', ...base };
  }
  if (close < sessionAvg && gapPct <= -MIN_EMA_GAP_PCT && close < e9) {
    return { state: 'BEARISH', reason: 'close below session average, EMA9 below EMA21, close below EMA9', ...base };
  }
  const why: string[] = [];
  if (Math.abs(gapPct) < MIN_EMA_GAP_PCT) why.push('EMA9/EMA21 too close (flat)');
  if ((close > sessionAvg) !== (gapPct > 0)) why.push('price vs session average disagrees with EMAs');
  if (gapPct > 0 && close <= e9) why.push('close back below EMA9');
  if (gapPct < 0 && close >= e9) why.push('close back above EMA9');
  return { state: 'NEUTRAL', reason: why.join('; ') || 'no aligned trend', ...base };
}

/** Drop the still-forming last candle: a 5-min bar starting at t is complete once now ≥ t + 5 min. */
export function completedBars(bars: Candle[], nowMs: number, barMinutes = 5): Candle[] {
  return bars.filter((b) => Date.parse(b.t) + barMinutes * 60_000 <= nowMs);
}

export function sideForTrend(trend: Trend): Right | null {
  return trend === 'BULLISH' ? 'PE' : trend === 'BEARISH' ? 'CE' : null;
}

/** True if the trend now argues against an open short of `right`. */
export function trendAgainst(right: Right, trend: Trend): boolean {
  return (right === 'PE' && trend === 'BEARISH') || (right === 'CE' && trend === 'BULLISH');
}

/* ------------------------------------------------------------------ */
/* Strike selection                                                     */
/* ------------------------------------------------------------------ */

export interface OptionQuote {
  strike: number;
  right: Right;
  tradingsymbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  oi: number | null;
}

export function midOf(q: { bid: number | null; ask: number | null; last: number | null }): number | null {
  if (q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0 && q.ask >= q.bid) return (q.bid + q.ask) / 2;
  return q.last != null && q.last > 0 ? q.last : null;
}

export function spreadPct(q: { bid: number | null; ask: number | null }): number | null {
  if (q.bid == null || q.ask == null || !(q.bid > 0) || !(q.ask > 0)) return null;
  return ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100;
}

/** Year fraction to 15:30 IST on the expiry date. */
export function yearsToExpiry(expiry: string, nowMs: number): number {
  const exp = Date.parse(`${expiry}T15:30:00+05:30`);
  return Math.max(exp - nowMs, 0) / (365 * 86_400_000);
}

export interface StrikePick {
  quote: OptionQuote;
  mid: number;
  iv: number;
  delta: number;
}

/**
 * The OTM strike of `right` whose |delta| is closest to target. Delta comes
 * from Black-76 with each strike's own implied vol (from its mid). Strikes
 * with no usable price/IV are skipped, never guessed.
 */
export function pickStrike(quotes: OptionQuote[], right: Right, spot: number, expiry: string, nowMs: number, targetDelta: number, rate = 0.065): StrikePick | null {
  const T = yearsToExpiry(expiry, nowMs);
  if (!(T > 0)) return null;
  const forward = spot * Math.exp(rate * T);
  let best: StrikePick | null = null;
  for (const q of quotes) {
    if (q.right !== right) continue;
    const otm = right === 'PE' ? q.strike < spot : q.strike > spot;
    if (!otm) continue;
    const mid = midOf(q);
    if (mid == null) continue;
    const iv = impliedVol(mid, { forward, strike: q.strike, timeToExpiry: T, rate, right });
    const vol = iv.vol;
    if (vol == null) continue;
    const delta = Math.abs(black76({ forward, strike: q.strike, timeToExpiry: T, vol, rate, right }).delta);
    if (!best || Math.abs(delta - targetDelta) < Math.abs(best.delta - targetDelta)) {
      best = { quote: q, mid: r2(mid), iv: Math.round(vol * 10000) / 10000, delta: Math.round(delta * 1000) / 1000 };
    }
  }
  return best;
}

/** SHADOW liquidity gate — null when OK, otherwise the reasons. */
export function liquidityProblems(q: OptionQuote, maxSpreadPct: number, minVolume: number): string[] | null {
  const out: string[] = [];
  const sp = spreadPct(q);
  if (sp == null) out.push('no two-sided bid/ask');
  else if (sp > maxSpreadPct) out.push(`bid/ask spread ${sp.toFixed(1)}% above ${maxSpreadPct}%`);
  if ((q.volume ?? 0) < minVolume) out.push(`volume ${q.volume ?? 0} below ${minVolume}`);
  return out.length ? out : null;
}

/* ------------------------------------------------------------------ */
/* Fills, levels, exits                                                 */
/* ------------------------------------------------------------------ */

export type Mode = 'PAPER' | 'SHADOW';

/** Price a SELL entry fills at: PAPER mid, SHADOW the bid. */
export function entryFill(mode: Mode, q: OptionQuote): number | null {
  if (mode === 'PAPER') return midOf(q);
  return q.bid != null && q.bid > 0 ? q.bid : null;
}

/** Price the BUY-to-close would fill at: PAPER mid, SHADOW the ask. */
export function exitFill(mode: Mode, q: { bid: number | null; ask: number | null; last: number | null }): number | null {
  if (mode === 'PAPER') return midOf(q);
  return q.ask != null && q.ask > 0 ? q.ask : null;
}

export function levels(entry: number, tpPct: number, slPct: number): { tp: number; sl: number } {
  return { tp: r2(entry * (1 - tpPct / 100)), sl: r2(entry * (1 + slPct / 100)) };
}

export interface ExitCheck { exit: boolean; reason: ExitReason | null; detail: string }

/**
 * Priority: SL (capital protection) > SQUARE_OFF > TP > TREND_FLIP. SL is
 * first so a spike that also crosses square-off time is labelled correctly.
 */
export function checkExit(p: { right: Right; tp_price: number; sl_price: number }, price: number | null, trend: Trend | null, minuteIst: number, squareOffMin: number): ExitCheck {
  if (price != null && price >= p.sl_price) return { exit: true, reason: 'SL', detail: `premium ${price} ≥ stop ${p.sl_price}` };
  if (minuteIst >= squareOffMin) return { exit: true, reason: 'SQUARE_OFF', detail: 'intraday square-off time reached' };
  if (price != null && price <= p.tp_price) return { exit: true, reason: 'TP', detail: `premium ${price} ≤ target ${p.tp_price}` };
  if (trend && trendAgainst(p.right, trend)) return { exit: true, reason: 'TREND_FLIP', detail: `intraday trend turned ${trend}` };
  return { exit: false, reason: null, detail: '' };
}

/* ------------------------------------------------------------------ */
/* P&L and charges                                                      */
/* ------------------------------------------------------------------ */

/**
 * Indian F&O option charges for one round trip (sell open, buy close),
 * per Zerodha's published schedule: ₹20/order brokerage, STT 0.1% of sell
 * premium, exchange txn charge (NSE 0.03503%, BSE 0.0325%) on both sides,
 * SEBI ₹10/crore, stamp duty 0.003% on the buy side, GST 18% on
 * brokerage + txn + SEBI. Estimates, not a broker contract note.
 */
export function roundTripCharges(entry: number, exit: number, qty: number, exchange: 'NFO' | 'BFO'): number {
  const sellTurnover = entry * qty;
  const buyTurnover = exit * qty;
  const turnover = sellTurnover + buyTurnover;
  const brokerage = 40;
  const stt = 0.001 * sellTurnover;
  const txn = (exchange === 'BFO' ? 0.000325 : 0.0003503) * turnover;
  const sebi = turnover * 10 / 1e7;
  const stamp = 0.00003 * buyTurnover;
  const gst = 0.18 * (brokerage + txn + sebi);
  return r2(brokerage + stt + txn + sebi + stamp + gst);
}

export function shortPnl(entry: number, current: number, qty: number): number {
  return r2((entry - current) * qty);
}

/* ------------------------------------------------------------------ */
/* Entry gating                                                         */
/* ------------------------------------------------------------------ */

export interface EntryContext {
  minuteIst: number;
  isExpiryDay: boolean;
  hasOpenPosition: boolean;
  entriesToday: number;
  realizedToday: number;
  minutesSinceLastExit: number | null;
}

/** Why a new entry is NOT allowed right now, or null when it is. */
export function entryBlocker(s: NakedSellSettings, c: EntryContext): string | null {
  if (c.minuteIst < s.entry_start_min) return 'before entry window';
  if (c.minuteIst > s.entry_end_min) return 'after entry window';
  if (c.isExpiryDay && !s.allow_expiry_day) return 'expiry day (gamma risk) — disabled in settings';
  if (c.hasOpenPosition) return 'position already open';
  if (c.entriesToday >= s.max_entries_per_day) return `max ${s.max_entries_per_day} entries today reached`;
  if (c.realizedToday <= -Math.abs(s.max_daily_loss)) return `daily loss limit ₹${s.max_daily_loss} hit`;
  if (c.minutesSinceLastExit != null && c.minutesSinceLastExit < s.cooldown_min) return `cooldown (${s.cooldown_min} min after last exit)`;
  return null;
}

export function istMinuteOf(nowMs: number): number {
  const d = new Date(nowMs + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function istDateOf(nowMs: number): string {
  return new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
}
