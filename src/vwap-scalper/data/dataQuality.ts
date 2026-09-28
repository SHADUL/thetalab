/**
 * Data-quality validators for persisted 1-minute equity bars
 * (VWAP_SCALPER_DATA_FOUNDATION Task 6). Pure functions over an already-
 * fetched bar array — no I/O, no fabrication. Missing minutes are
 * reported as gaps, never synthesized as flat/interpolated candles.
 */
import type { Bar } from '../types.ts';

export interface RawBar extends Bar {
  symbol: string;
}

export type DataQualityIssueType =
  | 'TIMESTAMP_OUT_OF_ORDER'
  | 'DUPLICATE_TIMESTAMP'
  | 'OHLC_INCONSISTENT'
  | 'NEGATIVE_VOLUME'
  | 'OUTSIDE_SESSION_HOURS'
  | 'LARGE_INTRABAR_GAP';

export interface DataQualityIssue {
  type: DataQualityIssueType;
  barIndex: number;
  timestamp: number;
  detail: string;
}

// NSE regular equity session: 09:15–15:30 IST. Bars are minute-START
// timestamps, so the LAST valid bar starts at 15:29.
const SESSION_START_MINUTES = 9 * 60 + 15;
const SESSION_END_MINUTES = 15 * 60 + 29;

function istMinutesOfDay(epochMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return hour * 60 + minute;
}

/**
 * Checks one session's worth of bars (already sorted by the caller's own
 * fetch order — this function does NOT re-sort, so an out-of-order
 * timestamp is itself flagged rather than silently corrected).
 */
export function validateBars(bars: Bar[], options: { maxGapMinutes?: number } = {}): DataQualityIssue[] {
  const maxGapMinutes = options.maxGapMinutes ?? 5;
  const issues: DataQualityIssue[] = [];
  const seenTimestamps = new Set<number>();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    if (seenTimestamps.has(bar.t)) {
      issues.push({ type: 'DUPLICATE_TIMESTAMP', barIndex: i, timestamp: bar.t, detail: `Timestamp ${new Date(bar.t).toISOString()} appears more than once.` });
    }
    seenTimestamps.add(bar.t);

    if (i > 0 && bar.t <= bars[i - 1].t) {
      issues.push({ type: 'TIMESTAMP_OUT_OF_ORDER', barIndex: i, timestamp: bar.t, detail: `Bar ${i} (${new Date(bar.t).toISOString()}) is not strictly after bar ${i - 1} (${new Date(bars[i - 1].t).toISOString()}).` });
    }

    const low = bar.l, high = bar.h;
    if (!(low <= bar.o && bar.o <= high && low <= bar.c && bar.c <= high && low <= high)) {
      issues.push({ type: 'OHLC_INCONSISTENT', barIndex: i, timestamp: bar.t, detail: `OHLC=(${bar.o},${bar.h},${bar.l},${bar.c}) violates low<=open/close<=high.` });
    }

    if (bar.v < 0) {
      issues.push({ type: 'NEGATIVE_VOLUME', barIndex: i, timestamp: bar.t, detail: `volume=${bar.v}` });
    }

    const minutesOfDay = istMinutesOfDay(bar.t);
    if (minutesOfDay < SESSION_START_MINUTES || minutesOfDay > SESSION_END_MINUTES) {
      issues.push({ type: 'OUTSIDE_SESSION_HOURS', barIndex: i, timestamp: bar.t, detail: `Bar timestamp falls outside 09:15-15:29 IST (minute-of-day=${minutesOfDay}).` });
    }

    if (i > 0) {
      const gapMinutes = (bar.t - bars[i - 1].t) / 60_000;
      // Only flag a gap WITHIN the same session — the overnight gap
      // between one day's last bar and the next day's first bar is
      // expected and not a data-quality issue.
      const sameSession = istMinutesOfDay(bars[i - 1].t) < istMinutesOfDay(bar.t) || gapMinutes < 60 * 12;
      if (sameSession && gapMinutes > maxGapMinutes) {
        issues.push({ type: 'LARGE_INTRABAR_GAP', barIndex: i, timestamp: bar.t, detail: `${gapMinutes.toFixed(1)} minutes since the prior bar (threshold ${maxGapMinutes}).` });
      }
    }
  }

  return issues;
}

/** True session-hours minute count for one NSE trading day (09:15-15:29 inclusive, 1-minute bars) — 375 minutes. Used to detect a PARTIAL session (an early market close, a data gap) without fabricating the missing bars themselves. */
export const EXPECTED_BARS_PER_FULL_SESSION = 375;

export function isPartialSession(barsInSession: number): boolean {
  return barsInSession > 0 && barsInSession < EXPECTED_BARS_PER_FULL_SESSION;
}
