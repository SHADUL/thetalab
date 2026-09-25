/**
 * Explicit calendar-time vs trading-time helpers — introduced by
 * VOLATILITY_TIME_CONVENTION.md's audit, which found that
 * `realizedVolatility.ts`/`distributionModel.ts` accept a parameter named
 * `horizonDays`/`lookbackDays` that is ambiguous about which calendar it
 * counts in, and that at least one real call site (expirySelector.ts
 * passing `dte`, a CALENDAR-day count, into a function that consumes it as
 * a TRADING-day array offset) is provably inconsistent as a result. See
 * that document for the full analysis and worked numeric examples.
 *
 * These helpers exist so any future fix states its unit explicitly rather
 * than passing an unqualified "days" — they are NOT yet wired into
 * production math (realizedVolatility.ts/distributionModel.ts are
 * unchanged); this file is deliberately a standalone, tested utility until
 * the convention is reviewed and a fix is explicitly approved.
 *
 * No NSE/BSE market-holiday calendar exists in this codebase today —
 * `countTradingSessions` accepts an optional holiday set and treats every
 * Mon-Fri as a trading day otherwise. That undercounts real trading-day
 * gaps around holidays (Independence Day, Diwali, etc.) until a real
 * exchange holiday list is wired in; documented as a known gap, not hidden.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ACT/365 year fraction between two calendar dates — same convention as
    enrich.ts's own yearFraction(), expressed on YYYY-MM-DD date strings
    instead of epoch-ms timestamps for use against HistoricalClose['date']. */
export function calendarYearFraction(fromDateStr: string, toDateStr: string): number {
  const from = Date.parse(`${fromDateStr}T00:00:00Z`);
  const to = Date.parse(`${toDateStr}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new RangeError(`calendarYearFraction: invalid date(s) "${fromDateStr}" / "${toDateStr}"`);
  }
  return Math.max(0, (to - from) / MS_PER_DAY) / 365;
}

/** Trading-year fraction from a COUNT of trading sessions — 252 sessions/year,
    the standard convention for annualizing a close-to-close return series that
    is already spaced one observation per trading day (as Kite's daily candle
    history is — weekends/holidays simply produce no row, see this file's
    header). Distinct from calendarYearFraction: the input here is a session
    COUNT, not a calendar date range. */
export function tradingYearFraction(tradingSessionCount: number): number {
  if (!(tradingSessionCount >= 0) || !Number.isFinite(tradingSessionCount)) {
    throw new RangeError(`tradingYearFraction: tradingSessionCount must be >= 0 and finite, got ${tradingSessionCount}`);
  }
  return tradingSessionCount / 252;
}

/**
 * Counts trading sessions (Mon-Fri, minus any date in `holidays`) strictly
 * between `fromDateStr` and `toDateStr` — i.e. how many rows a Kite daily
 * candle series would actually have over that span, absent unlisted
 * holidays. `holidays` is a set of "YYYY-MM-DD" strings; omitted holidays
 * are simply not accounted for (see this file's header) — this function
 * undercounts nothing it's told about, but knows nothing it isn't told.
 *
 * Convention: exclusive of `fromDateStr`, inclusive of `toDateStr` — this
 * matches "how many NEW candles appear between an anchor day and a target
 * day," the question every caller in this codebase actually needs answered
 * (e.g. "how many trading sessions from today to expiry").
 */
export function countTradingSessions(fromDateStr: string, toDateStr: string, holidays: Set<string> = new Set()): number {
  const from = Date.parse(`${fromDateStr}T00:00:00Z`);
  const to = Date.parse(`${toDateStr}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new RangeError(`countTradingSessions: invalid date(s) "${fromDateStr}" / "${toDateStr}"`);
  }
  if (to <= from) return 0;

  let count = 0;
  for (let t = from + MS_PER_DAY; t <= to; t += MS_PER_DAY) {
    const d = new Date(t);
    const day = d.getUTCDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) continue;
    const dateStr = d.toISOString().slice(0, 10);
    if (holidays.has(dateStr)) continue;
    count++;
  }
  return count;
}

/**
 * Approximate calendar-days -> trading-sessions conversion, for use where a
 * caller only has a DTE (calendar count, e.g. from enrich.ts's ACT/365
 * timeToExpiry) and no actual date range to run countTradingSessions
 * against — NOT a substitute for countTradingSessions when real dates are
 * available; ~252/365 is the long-run average trading-day density, not a
 * specific calendar's actual weekday/holiday pattern, so this will be off
 * by 1 session in either direction around most real horizons.
 */
export function approxTradingSessionsFromCalendarDays(calendarDays: number): number {
  if (!(calendarDays >= 0) || !Number.isFinite(calendarDays)) {
    throw new RangeError(`approxTradingSessionsFromCalendarDays: calendarDays must be >= 0 and finite, got ${calendarDays}`);
  }
  return Math.round(calendarDays * (252 / 365));
}
