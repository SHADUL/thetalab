/**
 * IV Rank and IV Percentile against the historical ATM-IV store
 * (buildIvHistory.ts). These are related but distinct, and conflating them
 * is a common source of bad reads:
 *
 *  - Rank:       where today sits between the window's min and max, linearly.
 *                A single historical spike can make "rank" look artificially
 *                low even when IV has actually been elevated for weeks.
 *  - Percentile: what fraction of days in the window had a LOWER IV than
 *                today. Robust to that one spike, since it only counts order,
 *                not magnitude.
 *
 * Refuses to compute either with too little history to mean anything, rather
 * than reporting a number off three data points.
 */

export interface IvHistoryPoint {
  date: string;
  atmIv: number | null;
}

export interface IvRankResult {
  rank: number;
  percentile: number;
  windowDays: number;
  min: number;
  max: number;
}

export const MIN_WINDOW_DAYS = 20;

export function ivRankAndPercentile(
  history: IvHistoryPoint[],
  current: number,
  lookbackDays = 252,
): IvRankResult | null {
  if (!(current > 0)) return null;

  const usable = history
    .filter((p): p is IvHistoryPoint & { atmIv: number } => p.atmIv !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-lookbackDays)
    .map((p) => p.atmIv);

  if (usable.length < MIN_WINDOW_DAYS) return null;

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const rank = max > min ? ((current - min) / (max - min)) * 100 : 50;

  const below = usable.filter((v) => v < current).length;
  const percentile = (below / usable.length) * 100;

  return {
    rank: Math.max(0, Math.min(100, rank)),
    percentile,
    windowDays: usable.length,
    min,
    max,
  };
}
