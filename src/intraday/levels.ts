export interface PreviousDayLevels {
  high: number;
  low: number;
  close: number;
}

export type GapType = 'GAP_UP' | 'GAP_DOWN' | 'NONE';

const GAP_THRESHOLD_PCT = 0.3; // below this, ordinary overnight noise, not a real gap

/** Spec §21 — gap classification off today's open vs the prior close. */
export function classifyGap(todayOpen: number, prevClose: number): { type: GapType; gapPct: number } {
  const gapPct = prevClose > 0 ? ((todayOpen - prevClose) / prevClose) * 100 : 0;
  if (gapPct > GAP_THRESHOLD_PCT) return { type: 'GAP_UP', gapPct };
  if (gapPct < -GAP_THRESHOLD_PCT) return { type: 'GAP_DOWN', gapPct };
  return { type: 'NONE', gapPct };
}

/** Spec §20 — previous-day level events, informational context surfaced
 *  in the explanation panel rather than a standalone setup in v1. */
export function detectPrevDayLevelEvents(price: number, levels: PreviousDayLevels): {
  aboveHigh: boolean; belowLow: boolean; aboveClose: boolean;
} {
  return {
    aboveHigh: price > levels.high,
    belowLow: price < levels.low,
    aboveClose: price > levels.close,
  };
}
