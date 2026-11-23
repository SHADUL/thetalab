/**
 * Previous-trading-day NIFTY 1-minute bars from Kite's historical API (Q5).
 * The HTTP call is injected (`fetchData`) so the server can route it
 * through ThetaLab's existing Kite session and throttle; this module never
 * sees a credential. Only CLOSES are used downstream.
 */
import { SESSION_FIRST_BAR, SESSION_LAST_BAR, RESEARCH_RULES_V1, type ResearchRules } from '../core/rules.ts';
import type { PrevSession } from '../core/engine.ts';
import { NIFTY_INDEX_TOKEN } from './adapter.ts';

/** Returns the Kite response's `data` object for a GET path, or throws. */
export type FetchData = (path: string) => Promise<any>;

export interface PrevReport {
  date: string | null;
  bars: number;
  expected: number;
  missingLabels: number[];
  has1515: boolean;
  close1515: number | null;
  duplicates: number;
  rejected: number;
  skippedDays: string[];
  error: string | null;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Most recent trading day strictly before `date` according to the calendar. */
export function previousTradingDay(date: string, isTradingDay: (d: string) => boolean, maxBack = 14): string | null {
  for (let i = 1; i <= maxBack; i++) { const d = addDays(date, -i); if (isTradingDay(d)) return d; }
  return null;
}

/** Kite candle timestamp "2026-11-20T09:15:00+0530" → { date, label }. */
export function candleLabel(ts: string): { date: string; label: number } | null {
  const iso = String(ts).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + 330 * 60_000);
  if (ist.getUTCSeconds() !== 0) return null;
  return { date: ist.toISOString().slice(0, 10), label: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

/** Parses Kite candles for one day: session bars only, positive closes, first duplicate wins, sorted. */
export function parseDayCandles(day: string, candles: unknown[], rules: ResearchRules = RESEARCH_RULES_V1): { prev: PrevSession; report: PrevReport } {
  const seen = new Map<number, number>();
  let duplicates = 0, rejected = 0;
  for (const c of candles) {
    if (!Array.isArray(c) || c.length < 5) { rejected++; continue; }
    const lab = candleLabel(String(c[0]));
    const close = Number(c[4]);
    if (!lab || lab.date !== day || lab.label < SESSION_FIRST_BAR || lab.label > SESSION_LAST_BAR || !(close > 0) || !Number.isFinite(close)) { rejected++; continue; }
    if (seen.has(lab.label)) { duplicates++; continue; }
    seen.set(lab.label, close);
  }
  const bars = [...seen].sort((a, b) => a[0] - b[0]).map(([label, close]) => ({ label, close }));
  const expected = SESSION_LAST_BAR - SESSION_FIRST_BAR + 1;
  const missingLabels: number[] = [];
  for (let m = SESSION_FIRST_BAR; m <= SESSION_LAST_BAR; m++) if (!seen.has(m)) missingLabels.push(m);
  const c1515 = seen.get(rules.prevCloseBar) ?? null;
  return {
    prev: { date: day, bars },
    report: { date: day, bars: bars.length, expected, missingLabels, has1515: c1515 != null, close1515: c1515, duplicates, rejected, skippedDays: [], error: null },
  };
}

/**
 * Loads the previous trading day. If Kite returns no candles at all for the
 * calendar's previous trading day (an unlisted holiday), it walks back one
 * more trading day, up to `maxSkips`, and reports every skipped day. It never
 * looks at today or later.
 */
export async function loadPrevSession(date: string, fetchData: FetchData, isTradingDay: (d: string) => boolean, o: { indexToken?: number; maxSkips?: number; rules?: ResearchRules } = {}): Promise<{ prev: PrevSession; report: PrevReport }> {
  const token = o.indexToken ?? NIFTY_INDEX_TOKEN;
  const skipped: string[] = [];
  let day = previousTradingDay(date, isTradingDay);
  for (let attempt = 0; day && attempt <= (o.maxSkips ?? 3); attempt++) {
    if (day >= date) break;
    const data = await fetchData(`/instruments/historical/${token}/minute?from=${day}+09:15:00&to=${day}+15:30:00`);
    const candles: unknown[] = Array.isArray(data?.candles) ? data.candles : [];
    if (candles.length === 0) { skipped.push(day); day = previousTradingDay(day, isTradingDay); continue; }
    const out = parseDayCandles(day, candles, o.rules);
    out.report.skippedDays = skipped;
    return out;
  }
  return {
    prev: { date: day ?? '', bars: [] },
    report: { date: null, bars: 0, expected: 375, missingLabels: [], has1515: false, close1515: null, duplicates: 0, rejected: 0, skippedDays: skipped, error: 'no previous trading day with Kite minute data found' },
  };
}
