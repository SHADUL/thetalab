/**
 * IST-correct clock — Asia/Kolkata, never raw server-local or bare UTC
 * hours/minutes (worker/main.ts previously read `now.getUTCHours()`
 * directly, which is wrong the instant the worker runs on any host whose
 * clock isn't already UTC-aligned to IST's fixed +05:30 offset by
 * coincidence — this file is the single, tested place that conversion
 * happens). India has no DST, so the offset is always exactly +05:30, but
 * the conversion itself is still done via `Intl.DateTimeFormat` rather
 * than a hand-rolled offset add, so it's correct regardless of the
 * runtime's own timezone setting.
 */

const IST_TIME_ZONE = 'Asia/Kolkata';

export interface ISTNow {
  /** "YYYY-MM-DD" in IST. */
  dateISO: string;
  /** Minutes since IST midnight (0-1439). */
  minutesSinceMidnight: number;
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/** `epochMs` defaults to `Date.now()` — always overridable for deterministic tests. */
export function nowIST(epochMs: number = Date.now()): ISTNow {
  const parts = formatter.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dateISO = `${get('year')}-${get('month')}-${get('day')}`;
  // Intl's hour12:false can print "24" for midnight in some engines —
  // normalize that to 0 rather than let it silently overflow the minute count.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { dateISO, minutesSinceMidnight: hour * 60 + minute };
}

// Exchange clock constants (spec §13, all IST) — named here so nothing
// downstream re-derives them from a raw hour/minute literal.
export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
export const SESSION_WINDOW_START_MIN = 9 * 60 + 31; // 09:31
export const SESSION_WINDOW_END_MIN = 14 * 60 + 31; // 14:31
export const SIGNAL_CUTOFF_MIN = 14 * 60 + 30; // 14:30
export const SCHEDULED_EXIT_MIN = 15 * 60 + 10; // 15:10
export const SAFETY_EXIT_MIN = 15 * 60 + 20; // 15:20
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30

export function isWithinSignalWindow(minutesSinceMidnight: number): boolean {
  return minutesSinceMidnight >= SESSION_WINDOW_START_MIN && minutesSinceMidnight <= SESSION_WINDOW_END_MIN;
}
export function isPastSignalCutoff(minutesSinceMidnight: number): boolean {
  return minutesSinceMidnight >= SIGNAL_CUTOFF_MIN;
}
export function isScheduledExitTime(minutesSinceMidnight: number): boolean {
  return minutesSinceMidnight >= SCHEDULED_EXIT_MIN;
}
export function isSafetyExitTime(minutesSinceMidnight: number): boolean {
  return minutesSinceMidnight >= SAFETY_EXIT_MIN;
}
export function isMarketOpen(minutesSinceMidnight: number): boolean {
  return minutesSinceMidnight >= MARKET_OPEN_MIN && minutesSinceMidnight <= MARKET_CLOSE_MIN;
}
