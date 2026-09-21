/**
 * Entry signal detection — Section 3 of the reference doc. Ported
 * bar-by-bar exactly as the Pine source evaluates it:
 *
 *   Touch:     SHORT when high >= VWAP+3σ,  LONG when low <= VWAP-3σ
 *   Rejection: Touch condition AND close back inside the band, confirmed
 *              bar only (never repaints)
 *
 * "One signal per excursion": after a SHORT signal, no new SHORT fires
 * until price closes back inside VWAP+2σ; same logic mirrored for LONG
 * vs VWAP-2σ. The two sides are tracked independently — reaching the
 * opposite band never auto-reverses or cancels a setup (Section 3).
 *
 * Optional filters (both off by default, purely additive, matching the
 * Pine source's own "Filters (Off by Default)" input group): a VWAP
 * slope filter and an EMA trend filter.
 */
import type { Bar, VwapBandsPoint, VwapScalperParams, VwapScalperSignal } from './types.ts';

/** Standard EMA, full series — null until `period` bars have accumulated (matches ta.ema's own warm-up, seeded with a simple average like the rest of this codebase's ema() helpers). */
export function computeEma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * @param bars, @param bands  Same length, index-aligned (bands[i] describes bars[i]).
 * @param lastBarUnconfirmed  True when bars[bars.length-1] is still forming
 *   (a live in-progress candle) — suppresses a Rejection-mode signal on
 *   that bar only, matching Pine's `barstate.isconfirmed` gate exactly.
 *   Touch mode is unaffected (Section 3: touch uses intrabar high/low by
 *   design, the same as the Pine source).
 */
export function detectVwapScalperSignals(
  bars: Bar[],
  bands: VwapBandsPoint[],
  params: VwapScalperParams = { stdevMultiplier: 1, entryMode: 'REJECTION', slopeFilter: null, trendFilter: null, stopLoss: null },
  lastBarUnconfirmed = false,
): VwapScalperSignal[] {
  const n = bars.length;
  const signals: VwapScalperSignal[] = [];
  if (n === 0) return signals;

  const emaSeries = params.trendFilter ? computeEma(bars.map((b) => b.c), params.trendFilter.emaLength) : null;

  let shortReady = true;
  let longReady = true;

  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const band = bands[i];
    const confirmed = !(lastBarUnconfirmed && i === n - 1);

    // Re-arm: independent per side, only after a genuine retreat inside the 2σ band.
    if (bar.c < band.upper2) shortReady = true;
    if (bar.c > band.lower2) longReady = true;

    // Guard against the degenerate case where stdev is exactly 0 (e.g. the
    // very first bar of a session, before any variance has accumulated) —
    // the 3σ bands then collapse to a single point equal to VWAP, and any
    // bar whose price equals that point would trivially "touch" BOTH
    // bands at once. That's a data artifact (no volatility observed yet),
    // not a genuine 3σ extreme, so no touch/rejection condition can fire
    // while stdev is non-positive. This is inherent to the formula itself
    // (the same degeneracy exists in the Pine reference's own math) —
    // added here as a deliberate safeguard, not a deviation from the
    // stated entry rules.
    const touchShort = band.stdev > 0 && bar.h >= band.upper3;
    const touchLong = band.stdev > 0 && bar.l <= band.lower3;
    const rejectShort = touchShort && bar.c < band.upper3 && confirmed;
    const rejectLong = touchLong && bar.c > band.lower3 && confirmed;

    const baseShort = params.entryMode === 'TOUCH' ? touchShort : rejectShort;
    const baseLong = params.entryMode === 'TOUCH' ? touchLong : rejectLong;

    let trendAllowsShort = true, trendAllowsLong = true;
    if (params.trendFilter && emaSeries) {
      const ema = emaSeries[i];
      if (ema === null) { trendAllowsShort = false; trendAllowsLong = false; }
      else { trendAllowsShort = bar.c < ema; trendAllowsLong = bar.c > ema; }
    }

    let slopeAllows = true;
    if (params.slopeFilter) {
      const { lookbackBars, thresholdSigma } = params.slopeFilter;
      const priorIdx = i - lookbackBars;
      if (priorIdx < 0 || band.stdev <= 0) slopeAllows = true; // not enough history yet to judge — don't block
      else {
        const slopeInSigma = (band.vwap - bands[priorIdx].vwap) / band.stdev;
        slopeAllows = Math.abs(slopeInSigma) <= thresholdSigma;
      }
    }

    const shortCondition = baseShort && trendAllowsShort && slopeAllows;
    const longCondition = baseLong && trendAllowsLong && slopeAllows;

    if (shortCondition && shortReady) {
      const stopPrice = params.stopLoss
        ? params.stopLoss.mode === 'PERCENTAGE'
          ? bar.c * (1 + params.stopLoss.percent / 100)
          : band.upper3 + params.stopLoss.sigmaBuffer * band.stdev
        : null;
      signals.push({
        direction: 'SHORT', barIndex: i, entryPrice: bar.c, vwapAtEntry: band.vwap, stopPrice,
        reason: params.entryMode === 'TOUCH'
          ? `Touched VWAP+3σ (${band.upper3.toFixed(2)}) at ${bar.h.toFixed(2)}.`
          : `Rejected at VWAP+3σ (${band.upper3.toFixed(2)}) — closed back inside at ${bar.c.toFixed(2)}.`,
      });
      shortReady = false;
    }
    if (longCondition && longReady) {
      const stopPrice = params.stopLoss
        ? params.stopLoss.mode === 'PERCENTAGE'
          ? bar.c * (1 - params.stopLoss.percent / 100)
          : band.lower3 - params.stopLoss.sigmaBuffer * band.stdev
        : null;
      signals.push({
        direction: 'LONG', barIndex: i, entryPrice: bar.c, vwapAtEntry: band.vwap, stopPrice,
        reason: params.entryMode === 'TOUCH'
          ? `Touched VWAP-3σ (${band.lower3.toFixed(2)}) at ${bar.l.toFixed(2)}.`
          : `Rejected at VWAP-3σ (${band.lower3.toFixed(2)}) — closed back inside at ${bar.c.toFixed(2)}.`,
      });
      longReady = false;
    }
  }

  return signals;
}
