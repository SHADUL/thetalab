/**
 * Point-in-time IV rank/percentile (QUANT_AUDIT.md Phase B, Task 6). The
 * existing archive (`buildIvHistory.ts` / `loadIvHistory`, consumed by
 * `ivRank.ts`'s `ivRankAndPercentile`) is a live, near-term, session-based
 * store — fine for a live scan asking "what is IV rank RIGHT NOW," but
 * unsafe to hand directly to a chronological backtest: naively filtering
 * "the whole archive up to `lookbackDays` entries" without also checking
 * that every one of those entries' OWN DATE is `<= asOfDate` would leak
 * future IV observations into a historical decision at date T.
 *
 * This module is the point-in-time-safe wrapper: it filters to
 * observations dated `<= asOfDate` FIRST, then applies the same
 * rank/percentile math ivRank.ts already implements (not reimplemented
 * here — imported and reused, per "do not duplicate math").
 */
import { ivRankAndPercentile, MIN_WINDOW_DAYS, type IvHistoryPoint, type IvRankResult } from './ivRank.ts';

export type { IvHistoryPoint, IvRankResult };

export interface PointInTimeIvRankResult extends IvRankResult {
  asOfDate: string;
  windowStartDate: string;
  windowEndDate: string;
}

export type PointInTimeIvRankOutcome =
  | { available: true; result: PointInTimeIvRankResult }
  | { available: false; reason: string };

/**
 * @param history Full IV history archive — may include dates AFTER
 *   asOfDate (a real archive keeps growing); this function is exactly what
 *   makes it safe to pass the whole thing in without the caller needing to
 *   pre-filter it themselves.
 * @param asOfDate "YYYY-MM-DD" — the backtest's current simulated date.
 *   No observation dated after this may influence the result.
 * @param currentAtmIv The (real, point-in-time) ATM IV to rank, e.g. this
 *   symbol's own real per-session archive point for asOfDate itself.
 */
export function computePointInTimeIvRank(
  history: IvHistoryPoint[],
  asOfDate: string,
  currentAtmIv: number | null,
  lookbackDays = 252,
): PointInTimeIvRankOutcome {
  if (currentAtmIv === null || !(currentAtmIv > 0)) {
    return { available: false, reason: 'No current ATM IV to rank.' };
  }
  // The core leakage guard — nothing dated after asOfDate is ever passed
  // into ivRankAndPercentile below.
  const upToDate = history.filter((p) => p.date <= asOfDate).sort((a, b) => a.date.localeCompare(b.date));
  if (upToDate.length < MIN_WINDOW_DAYS) {
    return { available: false, reason: `Only ${upToDate.length} historical IV observation(s) available as of ${asOfDate} (< ${MIN_WINDOW_DAYS} minimum).` };
  }

  const result = ivRankAndPercentile(upToDate, currentAtmIv, lookbackDays);
  if (!result) {
    return { available: false, reason: 'Insufficient usable (non-null) IV observations in the point-in-time window.' };
  }

  const windowed = upToDate.filter((p) => p.atmIv !== null).slice(-lookbackDays);
  return {
    available: true,
    result: {
      ...result,
      asOfDate,
      windowStartDate: windowed[0]?.date ?? asOfDate,
      windowEndDate: windowed[windowed.length - 1]?.date ?? asOfDate,
    },
  };
}
