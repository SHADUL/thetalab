/**
 * NSE/BSE equity+F&O trading holidays. No shared holiday calendar exists
 * anywhere else in this codebase yet (src/quant/analytics/timeConventions.ts's
 * own header discloses this as a known, repo-wide gap) — so, per your
 * instruction, this is a dedicated Nifty Alpha Ladder implementation, not
 * a reuse of something that doesn't actually exist.
 *
 * SOURCE: Zerodha's own published 2026 holiday calendar
 * (https://zerodha.com/marketintel/holiday-calendar/), fetched 2026-09-30.
 * This is a real, disclosed source — not fabricated — but it is a
 * third-party publication, not NSE's own official circular. VERIFY against
 * NSE's official holiday notice (nseindia.com) before this list is ever
 * used to gate a real SHADOW/AUTO decision with money at stake; treat it
 * as a good-faith starting point, not a guaranteed-authoritative one.
 */

export const NSE_HOLIDAYS_2026: readonly string[] = [
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Eid
  '2026-06-26', // Moharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
];

const HOLIDAY_SET = new Set(NSE_HOLIDAYS_2026);

/** `date` compared by its IST calendar date (YYYY-MM-DD), never the server's local timezone. */
export function isNseHoliday(dateIsoIST: string): boolean {
  return HOLIDAY_SET.has(dateIsoIST);
}
