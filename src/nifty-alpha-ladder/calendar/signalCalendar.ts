/**
 * Gates 5.1–5.3 (spec §6): exchange trading day, signal weekday with holiday
 * fallback, and the session window. `isTradingDay`'s holiday check defaults
 * to the real, dedicated NSE calendar (nseHolidays.ts) — still overridable
 * for fixture-driven tests, never a `() => false` placeholder in real use.
 */
import { isNseHoliday } from './nseHolidays.ts';
import { SESSION_WINDOW_START_MIN, SESSION_WINDOW_END_MIN, SIGNAL_CUTOFF_MIN, isWithinSignalWindow } from './istClock.ts';

export type Weekday = 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';

const WEEKDAYS: Weekday[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[date.getUTCDay()];
}

/** Gate 5.1: 𝟙_H(t) — an NSE trading day. `isHoliday` defaults to the real dedicated NSE calendar; a caller may still inject a different predicate for tests. `date`'s calendar day is read as-is (UTC) — the worker itself is responsible for passing an IST-correct Date/ISO day (see istClock.ts), this function does not re-derive timezone. */
export function isTradingDay(date: Date, isHoliday: (d: Date) => boolean = (d) => isNseHoliday(d.toISOString().slice(0, 10))): boolean {
  const wd = weekdayOf(date);
  return wd !== 'Saturday' && wd !== 'Sunday' && !isHoliday(date);
}

export { SESSION_WINDOW_START_MIN, SESSION_WINDOW_END_MIN, SIGNAL_CUTOFF_MIN, isWithinSignalWindow };

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

/** κ(d): the calendar date of the Wednesday of the signal week — the Wednesday itself even on a Thursday fallback (Gate 5.4's idempotency key). */
export function weekIdempotencyKey(signalDate: Date): string {
  const wd = weekdayOf(signalDate);
  const wednesday = new Date(signalDate);
  if (wd === 'Thursday') wednesday.setUTCDate(wednesday.getUTCDate() - 1);
  return wednesday.toISOString().slice(0, 10);
}
