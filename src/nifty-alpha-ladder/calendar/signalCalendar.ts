/**
 * Gates 5.1–5.3 (spec §6): exchange trading day, signal weekday with holiday
 * fallback, and the session window. Milestone 2 takes the holiday calendar
 * as an injected predicate (fixture-friendly, no live data) — a real NSE
 * holiday source is a Milestone 3 concern.
 */

export type Weekday = 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';

const WEEKDAYS: Weekday[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[date.getUTCDay()];
}

/** Gate 5.1: 𝟙_H(t) — an NSE trading day per a compiled holiday calendar, injected here as `isHoliday`. */
export function isTradingDay(date: Date, isHoliday: (d: Date) => boolean): boolean {
  const wd = weekdayOf(date);
  return wd !== 'Saturday' && wd !== 'Sunday' && !isHoliday(date);
}

/**
 * Gate 5.2: signal weekday with holiday fallback. `precedingWednesdayHadData`
 * is true iff the Wednesday immediately before `date` produced non-empty
 * aggregate-imbalance data in either the spot or futures source (i.e. it was
 * a genuine trading session that reached data collection) — the caller
 * supplies this from Gate 5.5's own result on that earlier day, never
 * inferred here. A normal Wednesday with no fire must NOT open Thursday: at
 * most one signal day exists per week.
 */
export function isSignalWeekday(date: Date, precedingWednesdayHadData: boolean): boolean {
  const wd = weekdayOf(date);
  if (wd === 'Wednesday') return true;
  if (wd === 'Thursday') return !precedingWednesdayHadData;
  return false;
}

/** Gate 5.3: 09:31 ≤ t ≤ 14:31, expressed in minutes since midnight IST. */
export const SESSION_WINDOW_START_MIN = 9 * 60 + 31;
export const SESSION_WINDOW_END_MIN = 14 * 60 + 31;
export const SIGNAL_CUTOFF_MIN = 14 * 60 + 30;

export function isWithinSignalWindow(minutesSinceMidnight: number): boolean {
  return minutesSinceMidnight >= SESSION_WINDOW_START_MIN && minutesSinceMidnight <= SESSION_WINDOW_END_MIN;
}

/** κ(d): the calendar date of the Wednesday of the signal week — the Wednesday itself even on a Thursday fallback (Gate 5.4's idempotency key). */
export function weekIdempotencyKey(signalDate: Date): string {
  const wd = weekdayOf(signalDate);
  const wednesday = new Date(signalDate);
  if (wd === 'Thursday') wednesday.setUTCDate(wednesday.getUTCDate() - 1);
  return wednesday.toISOString().slice(0, 10);
}
