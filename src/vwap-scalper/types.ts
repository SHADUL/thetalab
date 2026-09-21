/**
 * VWAP 3σ Mean Reversion — a standalone intraday scalping strategy, kept
 * deliberately separate from src/intraday/'s composite-score setup system
 * (see that module's own VWAP relationship classifier in vwap.ts, which
 * uses simple typical-price VWAP with no variance/bands at all — a
 * different, coarser signal feeding a blended score, not this strategy).
 *
 * This module ports the rules from the user-supplied Pine Script v6
 * reference (indicator + strategy, both compiled 0-errors) as closely as
 * the difference between a bar-by-bar charting language and a batch
 * TypeScript array computation allows — see each function's own header
 * for exactly which Pine construct it corresponds to.
 *
 * Callers are expected to pass ONLY the current session's bars (same
 * convention src/intraday/vwap.ts already uses) — this module does not
 * detect session boundaries itself; that's a live-data-fetch concern,
 * not a signal-computation one.
 */

export interface Bar {
  t: number; // epoch ms
  o: number; h: number; l: number; c: number; v: number;
}

/** hlc3 by default (the Pine source's own VWAP Source default). */
export type VwapSource = (bar: Bar) => number;

export interface VwapBandsPoint {
  vwap: number;
  stdev: number;
  upper1: number; upper2: number; upper3: number;
  lower1: number; lower2: number; lower3: number;
}

export type Direction = 'LONG' | 'SHORT';
export type EntryMode = 'TOUCH' | 'REJECTION';
export type StopLossMode = 'PERCENTAGE' | 'BEYOND_3SIGMA';

export interface VwapScalperParams {
  /** Scales the base 1σ unit — Pine's "Standard Deviation Multiplier". Default 1.0. */
  stdevMultiplier: number;
  entryMode: EntryMode;
  /** Pine's "Avoid Trades When VWAP Slope Is Strongly Directional" filter. Off (null) by default. */
  slopeFilter: { lookbackBars: number; thresholdSigma: number } | null;
  /** Pine's EMA Trend Filter. Off (null) by default. */
  trendFilter: { emaLength: number } | null;
  stopLoss: { mode: StopLossMode; percent: number; sigmaBuffer: number } | null;
}

export const DEFAULT_VWAP_SCALPER_PARAMS: VwapScalperParams = {
  stdevMultiplier: 1.0,
  entryMode: 'REJECTION',
  slopeFilter: null,
  trendFilter: null,
  stopLoss: null,
};

export interface VwapScalperSignal {
  direction: Direction;
  barIndex: number;
  entryPrice: number;
  /** VWAP at signal time — the initial target; the live target tracks VWAP as it moves (see targetAndStop.ts). */
  vwapAtEntry: number;
  stopPrice: number | null;
  reason: string;
}
