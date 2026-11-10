/**
 * Swing India — cash-equity swing scanner + paper-trading tracker.
 *
 * Pure functions only (no fetching, no storage): the API layer loads daily
 * bars from Supabase and live prices from Kite, then calls into here. Rules
 * follow the swing-india skill (SKILL.md):
 *
 *  - Cash equity only, max 3 open positions, risk ≤ 1% per trade,
 *    R:R ≥ 1.5 to T1, halt new entries when the month is down more than 3%.
 *  - Scan: reject below 200DMA, weak ADX, overheated RSI, barely above the
 *    DMA, fading MACD, illiquid (ADV < ₹5 cr), oversized (> 35% capital).
 *    entry = CMP + 0.5·ATR, stop = CMP − 1.5·ATR, T1 = entry + 1.5R,
 *    T2 = entry + 3R, qty = capital·risk% / R. Score 0–100.
 *  - Daily: EXIT / TRAIL / WATCH / HOLD+ / HOLD per open position.
 *  - Compile: rewrite learnings from closed trades once N ≥ 10.
 *
 * Not automated (no data source here): market cap, results calendar,
 * ASM/GSM surveillance and the DCF/comps fundamental stage. The UI shows
 * these as manual checks rather than pretending they were done.
 */
import { sma } from '../swing/indicators/movingAverages.ts';
import { rsi, macd } from '../swing/indicators/oscillators.ts';
import { atr, adx } from '../swing/indicators/trend.ts';
import { aggregateWeekly } from '../swing/indicators/weekly.ts';
import type { Bar } from '../swing/indicators/types.ts';

// ------------------------------------------------------------------ rules

export const HARD_RULES = {
  maxOpen: 3,
  monthHaltPct: -3,
  maxRiskPct: 1,
  minRrT1: 1.5,
  minRrT2: 2.5,
  maxPositionPct: 35,
  minAdvInr: 5e7, // ₹5 cr
  defaultHorizonDays: 15,
} as const;

export interface Learnings {
  sampleSize: number;
  active: boolean; // overrides only apply once sampleSize >= 10
  skipList: string[];
  favorList: string[];
  rsiMaxEntry: number;
  minAdx: number;
  maxHoldingDays: number;
  sectorFavor: string[];
  sectorAvoid: string[];
}

export const DEFAULT_LEARNINGS: Learnings = {
  sampleSize: 0, active: false, skipList: [], favorList: [],
  rsiMaxEntry: 70, minAdx: 20, maxHoldingDays: HARD_RULES.defaultHorizonDays, sectorFavor: [], sectorAvoid: [],
};

/** The thresholds actually in force: learned overrides only once the sample is big enough. */
export function effectiveRules(l: Learnings | null | undefined): Learnings {
  if (!l || !l.active || l.sampleSize < 10) return { ...DEFAULT_LEARNINGS, sampleSize: l?.sampleSize ?? 0 };
  return { ...DEFAULT_LEARNINGS, ...l };
}

// ------------------------------------------------------------------ technicals

export interface Technicals {
  close: number;
  asOf: string;
  dma50: number | null;
  dma200: number | null;
  dmaPct: number | null; // % above 200DMA
  rsi14: number | null;
  adx14: number | null;
  atr14: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  macdState: 'accelerating' | 'positive' | 'fading' | 'negative' | null;
  advInr: number | null; // 20-day average traded value
}

const last = <T>(xs: (T | null)[]): T | null => (xs.length ? xs[xs.length - 1] : null);

export function computeTechnicals(bars: Bar[]): Technicals | null {
  if (bars.length < 210) return null;
  const closes = bars.map((b) => b.c);
  const close = closes[closes.length - 1];
  const dma200 = last(sma(closes, 200));
  const m = macd(closes);
  const h = m[m.length - 1]?.histogram ?? null;
  const hp = m[m.length - 2]?.histogram ?? null;
  const macdState = h == null || hp == null ? null
    : h > 0 ? (h > hp ? 'accelerating' : 'positive')
      : h < hp ? 'fading' : 'negative';
  const tail = bars.slice(-20);
  const advInr = tail.reduce((a, b) => a + b.c * b.v, 0) / tail.length;
  return {
    close, asOf: bars[bars.length - 1].t,
    dma50: last(sma(closes, 50)), dma200,
    dmaPct: dma200 ? (close / dma200 - 1) * 100 : null,
    rsi14: last(rsi(closes, 14)),
    adx14: last(adx(bars, 14))?.adx ?? null,
    atr14: last(atr(bars, 14)),
    macdHist: h, macdHistPrev: hp, macdState, advInr,
  };
}

// ------------------------------------------------------------------ plan + score

export interface TradePlan {
  entry: number; stop: number; t1: number; t2: number; qty: number;
  riskPerShare: number; riskInr: number; positionInr: number; positionPct: number;
  rrT1: number; rrT2: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildPlan(cmp: number, atr14: number, capital: number, riskPct: number): TradePlan {
  const risk = Math.min(riskPct, HARD_RULES.maxRiskPct);
  const entry = r2(cmp + 0.5 * atr14);
  const stop = r2(cmp - 1.5 * atr14);
  const R = entry - stop;
  const t1 = r2(entry + 1.5 * R);
  const t2 = r2(entry + 3 * R);
  const qty = R > 0 ? Math.floor((capital * risk) / 100 / R) : 0;
  const positionInr = qty * entry;
  return {
    entry, stop, t1, t2, qty, riskPerShare: r2(R), riskInr: r2(qty * R),
    positionInr: r2(positionInr), positionPct: capital > 0 ? r2((positionInr / capital) * 100) : 0,
    rrT1: R > 0 ? r2((t1 - entry) / R) : 0, rrT2: R > 0 ? r2((t2 - entry) / R) : 0,
  };
}

export function scoreSetup(t: Technicals, favored: boolean): number {
  let s = 0;
  const r = t.rsi14 ?? 0, a = t.adx14 ?? 0, d = t.dmaPct ?? 0;
  if (r >= 40 && r < 50) s += 30; else if (r >= 50 && r < 60) s += 22; else if (r >= 60 && r <= 65) s += 12;
  if (a >= 35 && a < 50) s += 25; else if (a >= 25 && a < 35) s += 18; else if (a >= 50) s += 12;
  if (d >= 2 && d < 5) s += 20; else if (d >= 5 && d < 10) s += 12; else if (d >= 10 && d < 20) s += 5;
  if (t.macdState === 'accelerating') s += 15; else if (t.macdState === 'positive') s += 8;
  if (favored) s += 10;
  return Math.min(100, s);
}

export interface ScanInput { symbol: string; name?: string | null; sector?: string | null; bars: Bar[]; cmp?: number | null }

export interface ScanRow {
  symbol: string; name: string | null; sector: string | null;
  cmp: number; cmpLive: boolean; score: number;
  technicals: Technicals; plan: TradePlan;
}

export interface Rejection { symbol: string; reason: string }

/** Hard technical gates shared by scan and analyze. Returns the first failing reason, or null. */
export function technicalReject(t: Technicals, rules: Learnings): string | null {
  if (t.dma200 == null || t.close < t.dma200) return 'below 200DMA';
  if (t.adx14 == null || t.adx14 < rules.minAdx) return `ADX < ${rules.minAdx}`;
  if (t.advInr == null || t.advInr < HARD_RULES.minAdvInr) return 'ADV < ₹5 cr';
  return null;
}

export function scanUniverse(inputs: ScanInput[], capital: number, riskPct: number, learnings: Learnings, topN = 10) {
  const rules = effectiveRules(learnings);
  const rows: ScanRow[] = [];
  const rejected: Rejection[] = [];
  for (const inp of inputs) {
    const sym = inp.symbol;
    if (rules.skipList.includes(sym)) { rejected.push({ symbol: sym, reason: 'skip list (learnings)' }); continue; }
    if (inp.sector && rules.sectorAvoid.includes(inp.sector)) { rejected.push({ symbol: sym, reason: 'avoided sector (learnings)' }); continue; }
    const t = computeTechnicals(inp.bars);
    if (!t || t.atr14 == null) { rejected.push({ symbol: sym, reason: 'insufficient history' }); continue; }
    const hard = technicalReject(t, rules);
    if (hard) { rejected.push({ symbol: sym, reason: hard }); continue; }
    if ((t.rsi14 ?? 0) > rules.rsiMaxEntry) { rejected.push({ symbol: sym, reason: `RSI > ${rules.rsiMaxEntry}` }); continue; }
    if ((t.dmaPct ?? 0) < 1) { rejected.push({ symbol: sym, reason: 'barely above 200DMA' }); continue; }
    if (t.macdState === 'fading' || t.macdState === 'negative') { rejected.push({ symbol: sym, reason: 'MACD fading' }); continue; }
    const cmp = inp.cmp ?? t.close;
    const plan = buildPlan(cmp, t.atr14, capital, riskPct);
    if (plan.qty < 1) { rejected.push({ symbol: sym, reason: 'risk budget < 1 share' }); continue; }
    if (plan.rrT2 < HARD_RULES.minRrT2) { rejected.push({ symbol: sym, reason: 'R:R T2 < 2.5' }); continue; }
    if (plan.positionPct > HARD_RULES.maxPositionPct) { rejected.push({ symbol: sym, reason: 'position > 35% of capital' }); continue; }
    rows.push({
      symbol: sym, name: inp.name ?? null, sector: inp.sector ?? null, cmp, cmpLive: inp.cmp != null,
      score: scoreSetup(t, rules.favorList.includes(sym) || (inp.sector != null && rules.sectorFavor.includes(inp.sector))),
      technicals: t, plan,
    });
  }
  rows.sort((a, b) => b.score - a.score || (b.technicals.adx14 ?? 0) - (a.technicals.adx14 ?? 0));
  return { picks: rows.slice(0, topN), candidates: rows.length, rejected, scanned: inputs.length, rules };
}

// ------------------------------------------------------------------ analyze (deep card)

export interface Analysis {
  symbol: string;
  verdict: 'BUY' | 'WAIT' | 'SKIP';
  reason: string;
  cmp: number;
  technicals: Technicals;
  weeklyTrend: 'up' | 'sideways' | 'down' | null;
  weeklyBasis: string;
  bearishDivergence: boolean;
  fib: { swingLow: number; swingHigh: number; support: number | null; resistance: number | null; levels: { ratio: number; price: number }[] };
  plan: TradePlan;
  score: number;
  checks: { label: string; ok: boolean | null; detail: string }[];
}

/** Bearish divergence: the latest pivot high is higher in price but lower in RSI than the previous one. */
export function bearishRsiDivergence(bars: Bar[], lookback = 60, wing = 3): boolean {
  const closes = bars.map((b) => b.c);
  const r = rsi(closes, 14);
  const start = Math.max(wing, bars.length - lookback);
  const pivots: number[] = [];
  for (let i = start; i < bars.length - wing; i++) {
    let isPivot = true;
    for (let k = 1; k <= wing; k++) if (bars[i - k].h >= bars[i].h || bars[i + k].h > bars[i].h) { isPivot = false; break; }
    if (isPivot && r[i] != null) pivots.push(i);
  }
  if (pivots.length < 2) return false;
  const a = pivots[pivots.length - 2], b = pivots[pivots.length - 1];
  return bars[b].h > bars[a].h && (r[b] as number) < (r[a] as number) - 2;
}

export function fibLevels(bars: Bar[], cmp: number, lookback = 120) {
  const w = bars.slice(-lookback);
  const swingHigh = Math.max(...w.map((b) => b.h));
  const swingLow = Math.min(...w.map((b) => b.l));
  const span = swingHigh - swingLow;
  const levels = [0.236, 0.382, 0.5, 0.618, 0.786].map((ratio) => ({ ratio, price: r2(swingHigh - span * ratio) }));
  const ext = [{ ratio: 1.272, price: r2(swingLow + span * 1.272) }, { ratio: 1.618, price: r2(swingLow + span * 1.618) }];
  const below = [...levels, { ratio: 1, price: r2(swingLow) }].filter((l) => l.price < cmp).map((l) => l.price);
  // Major resistance = the swing high; once price is through it, the next Fib extension.
  const majorAbove = [{ ratio: 0, price: r2(swingHigh) }, ...ext].filter((l) => l.price > cmp * 1.005).map((l) => l.price);
  return {
    swingLow: r2(swingLow), swingHigh: r2(swingHigh),
    support: below.length ? Math.max(...below) : null,
    resistance: majorAbove.length ? Math.min(...majorAbove) : null,
    levels,
  };
}

export function weeklyTrend(bars: Bar[]): { trend: 'up' | 'sideways' | 'down' | null; basis: string } {
  const weeks = aggregateWeekly(bars);
  const closes = weeks.map((w) => w.c);
  // 200-week MA needs ~4 years; history here starts 2023, so use the longest MA it supports.
  const period = closes.length >= 210 ? 200 : closes.length >= 60 ? 50 : closes.length >= 45 ? 40 : 0;
  if (!period) return { trend: null, basis: 'not enough weekly history' };
  const ma = sma(closes, period);
  const now = ma[ma.length - 1] as number, prior = ma[ma.length - 5];
  const c = closes[closes.length - 1];
  const rising = prior != null && now > prior;
  const trend = c > now && rising ? 'up' : c < now && !rising ? 'down' : 'sideways';
  return { trend, basis: `weekly close vs ${period}-week MA` };
}

export interface PortfolioGate { openCount: number; monthPnlPct: number; alreadyOpen: boolean }

export function analyzeTicker(symbol: string, bars: Bar[], cmpLive: number | null, capital: number, riskPct: number,
  learnings: Learnings, gate: PortfolioGate, sector: string | null = null): Analysis | null {
  const rules = effectiveRules(learnings);
  const t = computeTechnicals(bars);
  if (!t || t.atr14 == null) return null;
  const cmp = cmpLive ?? t.close;
  const plan = buildPlan(cmp, t.atr14, capital, riskPct);
  const wk = weeklyTrend(bars);
  const div = bearishRsiDivergence(bars);
  const fib = fibLevels(bars, cmp);
  const favored = rules.favorList.includes(symbol) || (sector != null && rules.sectorFavor.includes(sector));
  const score = scoreSetup(t, favored);

  const checks: Analysis['checks'] = [
    { label: 'Above 200DMA', ok: t.dma200 != null && t.close > t.dma200, detail: t.dmaPct == null ? '—' : `${t.dmaPct.toFixed(1)}% above` },
    { label: `ADX ≥ ${rules.minAdx}`, ok: (t.adx14 ?? 0) >= rules.minAdx, detail: t.adx14?.toFixed(1) ?? '—' },
    { label: 'Weekly trend not down', ok: wk.trend == null ? null : wk.trend !== 'down', detail: `${wk.trend ?? '—'} (${wk.basis})` },
    { label: 'No bearish RSI divergence', ok: !div, detail: div ? 'higher high on lower RSI' : 'none on daily' },
    { label: `RSI ≤ ${rules.rsiMaxEntry}`, ok: (t.rsi14 ?? 0) <= rules.rsiMaxEntry, detail: t.rsi14?.toFixed(1) ?? '—' },
    { label: 'MACD supportive', ok: t.macdState === 'accelerating' || t.macdState === 'positive', detail: t.macdState ?? '—' },
    { label: 'ADV ≥ ₹5 cr', ok: (t.advInr ?? 0) >= HARD_RULES.minAdvInr, detail: t.advInr ? `₹${(t.advInr / 1e7).toFixed(1)} cr` : '—' },
    { label: 'Position ≤ 35% of capital', ok: plan.positionPct <= HARD_RULES.maxPositionPct, detail: `${plan.positionPct.toFixed(1)}%` },
    { label: 'R:R T1 ≥ 1.5 / T2 ≥ 2.5', ok: plan.rrT1 >= HARD_RULES.minRrT1 && plan.rrT2 >= HARD_RULES.minRrT2, detail: `${plan.rrT1} / ${plan.rrT2}` },
    { label: 'Resistance beyond T1', ok: fib.resistance == null || fib.resistance >= plan.t1, detail: fib.resistance ? `next resistance ₹${fib.resistance}` : 'at 120-day high' },
    { label: 'Not on skip list', ok: !rules.skipList.includes(symbol), detail: rules.active ? 'learnings active' : 'learnings inactive' },
  ];

  let verdict: Analysis['verdict'] = 'BUY';
  let reason = 'All technical gates pass — check results date, surveillance and fundamentals before entry.';
  const skip = (why: string) => { verdict = 'SKIP'; reason = why; };
  const wait = (why: string) => { if (verdict === 'BUY') { verdict = 'WAIT'; reason = why; } };

  if (rules.skipList.includes(symbol)) skip('On the learned skip list.');
  else if (t.dma200 == null || t.close < t.dma200) skip('Daily close below the 200DMA.');
  else if ((t.adx14 ?? 0) < rules.minAdx) skip(`Trend too weak (ADX ${t.adx14?.toFixed(1)} < ${rules.minAdx}).`);
  else if (wk.trend === 'down') skip('Weekly trend is down.');
  else if (div) skip('Bearish RSI divergence on the daily chart.');
  else if ((t.advInr ?? 0) < HARD_RULES.minAdvInr) skip('Illiquid (ADV under ₹5 cr).');
  else if (plan.qty < 1 || plan.positionPct > HARD_RULES.maxPositionPct) skip('Position would exceed 35% of capital at 1% risk.');

  if (verdict !== 'SKIP') {
    if (gate.alreadyOpen) wait('Already holding this — review it instead.');
    if (gate.openCount >= HARD_RULES.maxOpen) wait(`All ${HARD_RULES.maxOpen} position slots are in use.`);
    if (gate.monthPnlPct < HARD_RULES.monthHaltPct) wait(`Month P&L ${gate.monthPnlPct.toFixed(2)}% is below −3% — new entries halted.`);
    if ((t.rsi14 ?? 0) > rules.rsiMaxEntry) wait(`RSI ${t.rsi14?.toFixed(1)} is overheated — wait for a pullback.`);
    if (t.macdState === 'fading' || t.macdState === 'negative') wait('MACD momentum is fading — wait for it to turn up.');
    if (fib.resistance != null && fib.resistance < plan.t1) wait(`Resistance at ₹${fib.resistance} sits before T1.`);
    if ((t.dmaPct ?? 0) < 1) wait('Barely above the 200DMA — wait for confirmation.');
  }

  return { symbol, verdict, reason, cmp, technicals: t, weeklyTrend: wk.trend, weeklyBasis: wk.basis, bearishDivergence: div, fib, plan, score, checks };
}

// ------------------------------------------------------------------ daily (open positions)

export type Signal = 'EXIT' | 'TRAIL' | 'WATCH' | 'HOLD+' | 'HOLD';
export const SIGNAL_PRIORITY: Signal[] = ['EXIT', 'TRAIL', 'WATCH', 'HOLD+', 'HOLD'];

export interface OpenPosition { id: number; symbol: string; entry: number; stop: number; t1: number; t2: number; qty: number; opened_at: string; atr?: number | null }

export interface PositionStatus {
  id: number; symbol: string; cmp: number; cmpLive: boolean; daysHeld: number; horizon: number;
  unrealizedInr: number; unrealizedPct: number; rMultiple: number;
  distToT1Pct: number; distToStopPct: number; signal: Signal; reason: string; trailStop: number | null;
}

/** Calendar days between two YYYY-MM-DD dates. */
export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from.slice(0, 10) + 'T00:00:00Z')) / 86_400_000));
}

export function positionStatus(p: OpenPosition, cmp: number, cmpLive: boolean, today: string, horizon: number): PositionStatus {
  const R = p.entry - p.stop;
  const rMultiple = R > 0 ? (cmp - p.entry) / R : 0;
  const daysHeld = daysBetween(p.opened_at, today);
  let signal: Signal = 'HOLD', reason = 'Inside the plan — let it work.';
  if (cmp <= p.stop) { signal = 'EXIT'; reason = 'Stop hit — close it.'; }
  else if (cmp >= p.t2) { signal = 'EXIT'; reason = 'T2 reached — take the profit.'; }
  else if (daysHeld >= horizon) { signal = 'EXIT'; reason = `Time stop — held ${daysHeld}d of ${horizon}d.`; }
  else if (cmp >= p.t1) { signal = 'TRAIL'; reason = 'T1 reached — book 50%, raise stop to ATR×1.5 below CMP.'; }
  else if (rMultiple < -0.5) { signal = 'WATCH'; reason = 'Down more than half the risk — no adds.'; }
  else if (rMultiple > 0.8) { signal = 'HOLD+'; reason = 'Approaching T1.'; }
  const trailStop = p.atr ? r2(Math.max(p.stop, cmp - 1.5 * p.atr)) : null;
  return {
    id: p.id, symbol: p.symbol, cmp, cmpLive, daysHeld, horizon,
    unrealizedInr: r2((cmp - p.entry) * p.qty), unrealizedPct: r2((cmp / p.entry - 1) * 100), rMultiple: r2(rMultiple),
    distToT1Pct: r2((p.t1 / cmp - 1) * 100), distToStopPct: r2((p.stop / cmp - 1) * 100), signal, reason, trailStop,
  };
}

// ------------------------------------------------------------------ close + stats

export const EXIT_REASONS = ['t1_hit', 't2_hit', 'stop_hit', 'trail_hit', 'time_stop', 'discretionary', 'invalidation'] as const;
export type ExitReason = typeof EXIT_REASONS[number];

export function closeMetrics(p: { entry: number; stop: number; qty: number; opened_at: string }, exit: number, today: string) {
  const R = p.entry - p.stop;
  const rMultiple = R > 0 ? r2((exit - p.entry) / R) : 0;
  return {
    rMultiple, daysHeld: daysBetween(p.opened_at, today), pnlInr: r2((exit - p.entry) * p.qty),
    outcome: (rMultiple > 0.2 ? 'win' : rMultiple < -0.2 ? 'loss' : 'breakeven') as 'win' | 'loss' | 'breakeven',
  };
}

export interface ClosedTrade {
  symbol: string; r_multiple: number; pnl_inr: number; days_held: number; outcome: string; closed_at: string;
  sector?: string | null; setup?: { rsi14?: number | null; adx14?: number | null; dmaPct?: number | null } | null;
}

export function closedStats(closed: ClosedTrade[]) {
  const n = closed.length;
  const wins = closed.filter((c) => c.outcome === 'win');
  const losses = closed.filter((c) => c.outcome === 'loss');
  const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const byR = [...closed].sort((a, b) => b.r_multiple - a.r_multiple);
  return {
    count: n, wins: wins.length, losses: losses.length, breakeven: n - wins.length - losses.length,
    winRate: n ? r2((wins.length / n) * 100) : null,
    avgR: avg(closed.map((c) => Number(c.r_multiple))),
    avgWinR: avg(wins.map((c) => Number(c.r_multiple))),
    avgLossR: avg(losses.map((c) => Number(c.r_multiple))),
    realizedInr: r2(closed.reduce((a, c) => a + Number(c.pnl_inr), 0)),
    avgDaysHeld: avg(closed.map((c) => Number(c.days_held))),
    best: byR[0] ? { symbol: byR[0].symbol, r: byR[0].r_multiple, pnl: byR[0].pnl_inr } : null,
    worst: byR[n - 1] ? { symbol: byR[n - 1].symbol, r: byR[n - 1].r_multiple, pnl: byR[n - 1].pnl_inr } : null,
  };
}

// ------------------------------------------------------------------ compile learnings

type Bucket = { key: string; n: number; wins: number; winRate: number; avgR: number };

function bucketize(closed: ClosedTrade[], keyOf: (c: ClosedTrade) => string | null): Bucket[] {
  const m = new Map<string, ClosedTrade[]>();
  for (const c of closed) { const k = keyOf(c); if (k == null) continue; m.set(k, [...(m.get(k) ?? []), c]); }
  return [...m.entries()].map(([key, xs]) => {
    const wins = xs.filter((x) => x.outcome === 'win').length;
    return { key, n: xs.length, wins, winRate: r2((wins / xs.length) * 100), avgR: r2(xs.reduce((a, x) => a + Number(x.r_multiple), 0) / xs.length) };
  }).sort((a, b) => b.n - a.n);
}

const rsiBucket = (v: number | null | undefined) => v == null ? null : v < 40 ? '<40' : v < 50 ? '40-50' : v <= 65 ? '50-65' : '>65';
const adxBucket = (v: number | null | undefined) => v == null ? null : v < 25 ? '<25' : v < 35 ? '25-35' : v < 50 ? '35-50' : '50+';
const daysBucket = (d: number) => d <= 5 ? '0-5d' : d <= 10 ? '6-10d' : '11d+';

export function compileLearnings(closed: ClosedTrade[], prior: Learnings | null, today: string, priorChangelog: string[] = []) {
  const n = closed.length;
  if (n < 10) return { ok: false as const, message: `Insufficient sample (N=${n}/10). Compile aborted. Current learnings unchanged.` };

  const byRsi = bucketize(closed, (c) => rsiBucket(c.setup?.rsi14));
  const byAdx = bucketize(closed, (c) => adxBucket(c.setup?.adx14));
  const bySector = bucketize(closed, (c) => c.sector ?? null);
  const byDays = bucketize(closed, (c) => daysBucket(Number(c.days_held)));
  const byTicker = bucketize(closed, (c) => c.symbol);
  const weak = (b: Bucket | undefined) => b != null && b.n >= 5 && b.winRate < 40;

  const next: Learnings = {
    sampleSize: n, active: true,
    skipList: byTicker.filter((b) => b.n - b.wins >= 3 && b.winRate < 50).map((b) => b.key),
    favorList: byTicker.filter((b) => b.n >= 3 && b.winRate >= 67).map((b) => b.key),
    rsiMaxEntry: weak(byRsi.find((b) => b.key === '>65')) ? 65 : DEFAULT_LEARNINGS.rsiMaxEntry,
    minAdx: weak(byAdx.find((b) => b.key === '<25')) ? 25 : DEFAULT_LEARNINGS.minAdx,
    maxHoldingDays: weak(byDays.find((b) => b.key === '11d+')) ? 10 : DEFAULT_LEARNINGS.maxHoldingDays,
    sectorFavor: bySector.filter((b) => b.n >= 5 && b.winRate >= 60).map((b) => b.key),
    sectorAvoid: bySector.filter((b) => b.n >= 5 && b.winRate < 40).map((b) => b.key),
  };

  const p = prior ?? DEFAULT_LEARNINGS;
  const diff: string[] = [];
  const cmpList = (label: string, a: string[], b: string[]) => {
    const add = b.filter((x) => !a.includes(x)), rem = a.filter((x) => !b.includes(x));
    if (add.length) diff.push(`${label} +${add.join(', ')}`);
    if (rem.length) diff.push(`${label} −${rem.join(', ')}`);
  };
  for (const k of ['rsiMaxEntry', 'minAdx', 'maxHoldingDays'] as const) if (p[k] !== next[k]) diff.push(`${k}: ${p[k]} → ${next[k]}`);
  cmpList('skip list', p.skipList, next.skipList);
  cmpList('favor list', p.favorList, next.favorList);
  cmpList('sector favor', p.sectorFavor, next.sectorFavor);
  cmpList('sector avoid', p.sectorAvoid, next.sectorAvoid);
  const changelog = [`${today}: ${diff.length ? diff.join('; ') : 'no rule changes'}`, ...priorChangelog].slice(0, 30);

  const stats = closedStats(closed);
  const confidence = n >= 100 ? 'high (100+)' : n >= 30 ? 'medium (30-99)' : 'low (10-29)';
  const fmtB = (bs: Bucket[]) => bs.map((b) => `- ${b.key}: N=${b.n}, win ${b.winRate}%, avg R ${b.avgR}`).join('\n') || '- (none)';
  const all = [...byRsi, ...byAdx, ...bySector, ...byDays];
  const markdown = [
    `# Swing-India Learnings — compiled ${today}`,
    '',
    `**Sample:** N=${n} closed trades | Win rate: ${stats.winRate}% | Avg R: ${stats.avgR}`,
    '',
    `## Confidence\n${confidence}`,
    '',
    `## Patterns That Win (≥60% W, N≥5)\n${fmtB(all.filter((b) => b.n >= 5 && b.winRate >= 60))}`,
    '',
    `## Patterns That Lose (<40% W, N≥5)\n${fmtB(all.filter((b) => b.n >= 5 && b.winRate < 40))}`,
    '',
    '## Threshold Adjustments',
    `- rsi_max_entry: ${next.rsiMaxEntry} (default 70)`,
    `- min_adx: ${next.minAdx} (default 20)`,
    `- max_holding_days: ${next.maxHoldingDays} (default 15)`,
    '',
    `## Skip List\n${next.skipList.map((s) => `- ${s}`).join('\n') || '- (none)'}`,
    '',
    `## Sector Tilts\n- favor: ${next.sectorFavor.join(', ') || '—'}\n- avoid: ${next.sectorAvoid.join(', ') || '—'}`,
    '',
    `## Breakdown\n### RSI at entry\n${fmtB(byRsi)}\n### ADX at entry\n${fmtB(byAdx)}\n### Holding days\n${fmtB(byDays)}\n### Sector\n${fmtB(bySector)}`,
    '',
    `## Changelog\n${changelog.map((c) => `- ${c}`).join('\n')}`,
  ].join('\n');

  return { ok: true as const, learnings: next, markdown, diff, changelog };
}

