import type { RvolClass } from './types.ts';

const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
const SESSION_MINUTES = MARKET_CLOSE_MIN - MARKET_OPEN_MIN;

/** How far through today's session we are, 0 at 09:15, 1 at 15:30. */
export function sessionFractionElapsed(nowMinutesIST: number): number {
  return Math.max(0, Math.min(1, (nowMinutesIST - MARKET_OPEN_MIN) / SESSION_MINUTES));
}

/**
 * Relative volume by time of day (spec §11) — comparing right-now's
 * cumulative volume against a time-normalized expectation, not against a
 * whole day's average blindly.
 *
 * v1 approximation, stated plainly: the "expected" baseline here is a
 * LINEAR share of the 20-day average daily volume (elapsed session
 * fraction × avgDailyVolume20d) — not a true per-minute historical
 * volume curve, which real intraday volume isn't linear against (volume
 * typically skews toward the open and close). This will systematically
 * under-read RVOL near the open/close and over-read it midday until a
 * real per-minute historical baseline is accumulated from this system's
 * own live data going forward — a known, documented limitation, not a
 * silent one.
 */
export function estimateRVOL(cumulativeVolumeToday: number, avgDailyVolume20d: number | null, nowMinutesIST: number): number | null {
  if (avgDailyVolume20d == null || avgDailyVolume20d <= 0) return null;
  const fraction = sessionFractionElapsed(nowMinutesIST);
  if (fraction <= 0) return null;
  const expected = avgDailyVolume20d * fraction;
  return expected > 0 ? cumulativeVolumeToday / expected : null;
}

export function classifyRVOL(rvol: number | null): RvolClass {
  if (rvol == null) return 'UNKNOWN';
  if (rvol < 0.75) return 'WEAK';
  if (rvol < 1.0) return 'NORMAL';
  if (rvol < 1.5) return 'POSITIVE';
  if (rvol < 2.0) return 'STRONG';
  return 'EXCEPTIONAL';
}

/** Restated as a 0-100 factor score — volume alone isn't directional, so
 *  this only measures "is there unusual participation," the direction
 *  read comes from price action elsewhere. */
export function rvolScore(rvol: number | null): number {
  if (rvol == null) return 40;
  if (rvol < 0.75) return 20;
  if (rvol < 1.0) return 45;
  if (rvol < 1.5) return 65;
  if (rvol < 2.0) return 85;
  return 95;
}
