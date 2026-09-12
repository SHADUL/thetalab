/**
 * Pattern Engine (spec §53's "Pattern Engine" stage) — turns a price series
 * into the setup classifications spec §6/§16/§18/§19/§23/§26/§27 describe.
 * Sits downstream of the Indicator Engine (src/swing/indicators) but is its
 * own concern: indicators measure the raw series, patterns interpret it.
 *
 * detectPatterns takes bars up to and including "today" and only ever looks
 * backward — never at bars[asOfIdx+1..]. That's deliberate: the same
 * function serves live scanning (call it on the full series) and the
 * backtest engine (spec §31/§32 — call it on bars.slice(0, i+1) for
 * historical date i) without a second implementation to keep in sync, and
 * without look-ahead bias being something a caller could accidentally
 * introduce.
 *
 * Expects bars already split/bonus-adjusted (src/swing/indicators/splitAdjust) —
 * this module has no opinion on corporate actions of its own.
 */
import type { Bar } from '../indicators/types.ts';
import { ema } from '../indicators/movingAverages.ts';
import { rsi } from '../indicators/oscillators.ts';
import { atr, trueRange } from '../indicators/trend.ts';
import { volumeRatio, classifyVolumeRatio } from '../indicators/volume.ts';
import type {
  BreakoutSignal, ConsolidationSignal, PullbackSignal, GapSignal,
  ExtensionRisk, EntryStatus, SetupType, PatternResult,
} from './types.ts';

const BREAKOUT_LOOKBACKS = [20, 50, 100, 252] as const;
const GAP_THRESHOLD_PCT = 2; // below this, day-to-day noise, not a real gap
const CONSOLIDATION_SHORT_WINDOW = 10;
const CONSOLIDATION_LONG_WINDOW = 50;
const CONSOLIDATION_CONTRACTION_MAX = 0.65; // short-window range comfortably under the long-window one
const PULLBACK_ATR_TOLERANCE = 1.0; // "near" an EMA means within one ATR of it
const RETEST_WINDOW = 15; // how many recent sessions count as "a breakout that just happened"
const RETEST_TOLERANCE_PCT = 3; // how close to the old level counts as "testing" it

function priorHigh(bars: Bar[], asOfIdx: number, lookback: number): number | null {
  const start = asOfIdx - lookback;
  if (start < 0) return null;
  let max = -Infinity;
  for (let i = start; i < asOfIdx; i++) max = Math.max(max, bars[i].h);
  return max;
}

export function detectBreakouts(bars: Bar[], asOfIdx: number): BreakoutSignal[] {
  return BREAKOUT_LOOKBACKS.map((lookback) => {
    const level = priorHigh(bars, asOfIdx, lookback);
    return { lookback, level, brokeOut: level != null && bars[asOfIdx].c > level };
  });
}

/** Where in today's own range the close landed — 1 means it closed at the
 *  high (buyers in control into the close), 0 at the low (sellers were).
 *  A breakout on a weak close is exactly the "confirmed vs potential vs
 *  failed" distinction spec §17 asks for. */
export function closingStrength(bar: Bar): number {
  const range = bar.h - bar.l;
  return range === 0 ? 0.5 : (bar.c - bar.l) / range;
}

/** 0-100. Only meaningful when at least one lookback broke out today —
 *  callers should treat a null-breakout day's quality as not applicable,
 *  not zero. Every factor here has a stated reason, per spec §56 — no
 *  parameter here was tuned against historical profit, only against what a
 *  breakout is supposed to look like when it's real. */
export function breakoutQuality(
  bars: Bar[], asOfIdx: number, breakouts: BreakoutSignal[], volRatio: number | null,
): number | null {
  if (!breakouts.some((b) => b.brokeOut)) return null;
  let score = 40; // a genuine break of a real level is worth something on its own
  const strength = closingStrength(bars[asOfIdx]);
  score += strength * 25; // closed at the high of the day: full marks; at the low: none
  if (volRatio != null) {
    if (volRatio >= 2.0) score += 25;
    else if (volRatio >= 1.5) score += 18;
    else if (volRatio >= 1.0) score += 8;
    // volRatio < 1.0: no volume points at all — a breakout nobody showed up for
  }
  const widestBreak = breakouts.filter((b) => b.brokeOut).sort((a, b) => b.lookback - a.lookback)[0];
  if (widestBreak.lookback >= 100) score += 10; // clearing a longer base says more than a 20-day blip
  return Math.min(100, Math.round(score));
}

/** Plain mean true range over the trailing `n` bars — deliberately not
 *  Wilder-smoothed ATR(14). Reusing ATR(14) for both a 10-day and a 50-day
 *  reading doesn't work: seeding ATR(14) itself pulls in 14 bars of
 *  history regardless of which "window" it's nominally for, so a 10-day
 *  slice's ATR still gets contaminated by whatever came before it. A
 *  simple mean over exactly the bars in each window has no such seeding
 *  period to leak across the boundary. */
function meanTrueRange(tr: number[], n: number): number {
  const slice = tr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

export function detectConsolidation(bars: Bar[], asOfIdx: number): ConsolidationSignal {
  if (asOfIdx < CONSOLIDATION_LONG_WINDOW) return { inConsolidation: false, contractionRatio: null, rangePct: null };
  const window = bars.slice(0, asOfIdx + 1);
  const tr = trueRange(window);
  const price = bars[asOfIdx].c;
  const shortVal = meanTrueRange(tr, CONSOLIDATION_SHORT_WINDOW);
  const longVal = meanTrueRange(tr, CONSOLIDATION_LONG_WINDOW);
  if (longVal === 0 || price === 0) {
    return { inConsolidation: false, contractionRatio: null, rangePct: null };
  }
  const contractionRatio = shortVal / longVal;
  const recentBars = bars.slice(asOfIdx - CONSOLIDATION_SHORT_WINDOW + 1, asOfIdx + 1);
  const hi = Math.max(...recentBars.map((b) => b.h)), lo = Math.min(...recentBars.map((b) => b.l));
  const rangePct = ((hi - lo) / price) * 100;
  return { inConsolidation: contractionRatio < CONSOLIDATION_CONTRACTION_MAX, contractionRatio, rangePct };
}

export function detectPullback(bars: Bar[], asOfIdx: number): PullbackSignal {
  const closes = bars.slice(0, asOfIdx + 1).map((b) => b.c);
  const ema20series = ema(closes, 20), ema50series = ema(closes, 50);
  const atrSeries = atr(bars.slice(0, asOfIdx + 1), 14);
  const price = bars[asOfIdx].c;
  const e20 = ema20series[asOfIdx], e50 = ema50series[asOfIdx], a = atrSeries[asOfIdx];

  const uptrend = e20 != null && e50 != null && e20 >= e50 * 0.98; // roughly aligned, not requiring a rigid stack
  const near = (level: number | null) => level != null && a != null && a > 0 && Math.abs(price - level) <= a * PULLBACK_ATR_TOLERANCE;

  let breakoutRetest = false;
  if (asOfIdx >= RETEST_WINDOW) {
    for (let back = 1; back <= RETEST_WINDOW; back++) {
      const idx = asOfIdx - back;
      const level = priorHigh(bars, idx, 50);
      if (level != null && bars[idx].c > level) {
        // idx was a genuine 50-day breakout — is price now sitting back
        // near that old resistance, from above rather than having failed
        // below it?
        const withinTolerance = Math.abs(price - level) / level <= RETEST_TOLERANCE_PCT / 100;
        if (withinTolerance && price >= level * 0.99) breakoutRetest = true;
        break; // only the most recent breakout in the window counts
      }
    }
  }

  return { toEma20: uptrend && near(e20), toEma50: uptrend && near(e50), breakoutRetest };
}

export function detectGap(bars: Bar[], asOfIdx: number): GapSignal {
  if (asOfIdx < 1) return { type: 'NONE', gapPct: null };
  const prevClose = bars[asOfIdx - 1].c;
  if (prevClose === 0) return { type: 'NONE', gapPct: null };
  const gapPct = ((bars[asOfIdx].o - prevClose) / prevClose) * 100;
  if (gapPct >= GAP_THRESHOLD_PCT) return { type: 'GAP_UP', gapPct };
  if (gapPct <= -GAP_THRESHOLD_PCT) return { type: 'GAP_DOWN', gapPct };
  return { type: 'NONE', gapPct };
}

/** Low/Medium/High (spec §26) — how far price has run from its own recent
 *  base, in units that scale with the stock's own volatility (ATR) rather
 *  than a flat percentage, so a naturally-volatile stock isn't flagged for
 *  behaving normally. */
export function detectExtensionRisk(bars: Bar[], asOfIdx: number): ExtensionRisk {
  const closes = bars.slice(0, asOfIdx + 1).map((b) => b.c);
  const ema20series = ema(closes, 20);
  const atrSeries = atr(bars.slice(0, asOfIdx + 1), 14);
  const rsiSeries = rsi(closes, 14);
  const e20 = ema20series[asOfIdx], a = atrSeries[asOfIdx], r = rsiSeries[asOfIdx];
  const price = bars[asOfIdx].c;

  let points = 0;
  if (e20 != null && a != null && a > 0) {
    const atrDistance = (price - e20) / a;
    if (atrDistance > 3) points += 2; else if (atrDistance > 2) points += 1;
  }
  if (r != null) { if (r > 80) points += 2; else if (r > 70) points += 1; }
  let consecutiveUp = 0;
  for (let i = asOfIdx; i > 0 && bars[i].c > bars[i - 1].c; i--) consecutiveUp++;
  if (consecutiveUp >= 5) points += 1;

  return points >= 3 ? 'HIGH' : points >= 1 ? 'MEDIUM' : 'LOW';
}

function deriveEntryStatus(
  extensionRisk: ExtensionRisk, breakouts: BreakoutSignal[], volumeConfirmed: boolean,
  pullback: PullbackSignal, consolidation: ConsolidationSignal, nearBreakoutLevel: boolean,
): EntryStatus {
  if (extensionRisk === 'HIGH') return 'EXTENDED';
  const brokeOutToday = breakouts.some((b) => b.brokeOut);
  if (brokeOutToday && volumeConfirmed) return 'BREAKOUT_CONFIRMED';
  if (pullback.toEma20 || pullback.toEma50 || pullback.breakoutRetest) return 'BUY_ZONE';
  if (brokeOutToday && !volumeConfirmed) return 'NEAR_ENTRY';
  if (nearBreakoutLevel) return 'NEAR_ENTRY';
  if (consolidation.inConsolidation) return 'WAIT_FOR_BREAKOUT';
  return 'AVOID';
}

/** Highest high seen up to and including asOfIdx — "ATH" in the same
 *  limited sense computeIndicators.ts uses it (highest within the data
 *  this project has, not a verified true all-time high). Recomputed here
 *  rather than threaded in from the Indicator Engine's output so the
 *  Pattern Engine stays self-contained on just `bars`, matching the
 *  Provider-adapter discipline src/quant/data/adapter.ts already
 *  established: nothing downstream depends on another stage's internals. */
function athSoFar(bars: Bar[], asOfIdx: number): number {
  let max = -Infinity;
  for (let i = 0; i <= asOfIdx; i++) max = Math.max(max, bars[i].h);
  return max;
}

function deriveSetupTypes(
  bars: Bar[], asOfIdx: number, breakouts: BreakoutSignal[], volumeConfirmed: boolean,
  pullback: PullbackSignal, extensionRisk: ExtensionRisk, volRatio: number | null, todayClosingStrength: number,
): SetupType[] {
  const tags: SetupType[] = [];
  const brokeOutToday = breakouts.some((b) => b.brokeOut);
  const broke252 = breakouts.find((b) => b.lookback === 252)?.brokeOut;
  const ath = athSoFar(bars, asOfIdx);
  const distAthPct = ath === 0 ? null : ((bars[asOfIdx].c - ath) / ath) * 100;

  if (brokeOutToday) tags.push(broke252 ? 'ATH_BREAKOUT' : 'BREAKOUT');
  if (brokeOutToday && !volumeConfirmed) tags.push('EARLY_BREAKOUT');
  if (pullback.toEma20 || pullback.toEma50 || pullback.breakoutRetest) tags.push('PULLBACK');
  if (!brokeOutToday && distAthPct != null && distAthPct > -10) tags.push('TREND_CONTINUATION');
  if (volRatio != null && volRatio >= 1.5 && !brokeOutToday) tags.push('VOLUME_ACCUMULATION');
  if (extensionRisk === 'HIGH') tags.push('EXTENDED');
  // A breakout that closed in the bottom third of its own day's range is
  // the kind that often doesn't hold — flagged, not hidden (spec §17/§23).
  if (brokeOutToday && todayClosingStrength < 0.33) tags.push('FAILED_BREAKOUT_RISK');
  return tags.length ? tags : ['TREND_CONTINUATION'];
}

export function detectPatterns(bars: Bar[], asOfIdx: number = bars.length - 1): PatternResult {
  const volumes = bars.slice(0, asOfIdx + 1).map((b) => b.v);
  const volRatioSeries = volumeRatio(volumes, 20);
  const volRatio = volRatioSeries[asOfIdx];
  const volumeConfirmed = classifyVolumeRatio(volRatio) === 'strong' || classifyVolumeRatio(volRatio) === 'exceptional';

  const breakouts = detectBreakouts(bars, asOfIdx);
  const quality = breakoutQuality(bars, asOfIdx, breakouts, volRatio);
  const consolidation = detectConsolidation(bars, asOfIdx);
  const pullback = detectPullback(bars, asOfIdx);
  const gap = detectGap(bars, asOfIdx);
  const extensionRisk = detectExtensionRisk(bars, asOfIdx);

  const level20 = priorHigh(bars, asOfIdx, 20);
  const nearBreakoutLevel = level20 != null && bars[asOfIdx].c < level20 && bars[asOfIdx].c >= level20 * 0.97;
  const todayClosingStrength = closingStrength(bars[asOfIdx]);

  const entryStatus = deriveEntryStatus(extensionRisk, breakouts, volumeConfirmed, pullback, consolidation, nearBreakoutLevel);
  const setupTypes = deriveSetupTypes(bars, asOfIdx, breakouts, volumeConfirmed, pullback, extensionRisk, volRatio, todayClosingStrength);

  return {
    breakouts, breakoutQuality: quality, volumeConfirmed,
    closingStrength: todayClosingStrength,
    consolidation, pullback, gap, extensionRisk, entryStatus, setupTypes,
  };
}
