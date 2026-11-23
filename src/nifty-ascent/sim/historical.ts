/**
 * Historical backtest on REAL NIFTY data (Kite 1-minute candles) with
 * MODELLED option prices. Kite does not serve history for expired weekly
 * options, so option bid/ask/trades are Black-76 prices off the real index
 * path, using the previous day's India VIX as implied volatility. Results are
 * research, clearly separate from live paper and from synthetic simulation.
 *
 * Intra-minute path: each real candle becomes 60 one-second points
 * O → (L then H on an up candle, H then L on a down candle) → C, so every
 * minute CLOSE is exact, the 09:15 reference is the real open, and tick-based
 * gap fills see the real intra-minute high/low.
 */
import { Replay, kiteOptionSymbol, type Scenario, type ReplayOptions } from './market.ts';
import type { Instrument } from '../core/contracts.ts';
import type { PrevSession } from '../core/engine.ts';
import { SESSION_FIRST_BAR, SESSION_LAST_BAR } from '../core/rules.ts';

export interface MinuteCandle { label: number; o: number; h: number; l: number; c: number }

export interface HistDay {
  kind: 'NIFTY_ASCENT_HIST_DAY';
  date: string;
  prevDate: string;
  bars: MinuteCandle[];
  prevBars: Array<{ label: number; close: number }>;
  /** Previous day's India VIX close (percent) — the modelled implied volatility. */
  vixPrevClose: number | null;
  /** Listed weekly expiries on/after the date (holiday-adjusted), nearest first. */
  expiries: string[];
  lotSize: number;
  strikeStep: number;
  source: 'KITE_HISTORICAL';
  fetchedAt: string;
}

/** 22,500 one-second prices 09:15:00–15:29:59; NaN where Kite has no candle for that minute. */
export function pathFromMinuteBars(bars: MinuteCandle[]): Float64Array {
  const out = new Float64Array((SESSION_LAST_BAR - SESSION_FIRST_BAR + 1) * 60).fill(Number.NaN);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const b of bars) {
    if (b.label < SESSION_FIRST_BAR || b.label > SESSION_LAST_BAR) continue;
    const up = b.c >= b.o;
    const pts: Array<[number, number]> = [[0, b.o], [20, up ? b.l : b.h], [40, up ? b.h : b.l], [59, b.c]];
    const base = (b.label - SESSION_FIRST_BAR) * 60;
    for (let k = 0; k < 3; k++) {
      const [s0, p0] = pts[k], [s1, p1] = pts[k + 1];
      for (let s = s0; s <= s1; s++) out[base + s] = r2(p0 + ((p1 - p0) * (s - s0)) / (s1 - s0));
    }
  }
  return out;
}

/** Instruments for the day: listed strike grid around the open for the given expiries (modelled contracts). */
export function histInstruments(h: HistDay): Instrument[] {
  const open = h.bars.find((b) => b.label === SESSION_FIRST_BAR)?.o ?? h.bars[0]?.o ?? 0;
  const lo = Math.floor((open - 2500) / h.strikeStep) * h.strikeStep, hi = Math.ceil((open + 2500) / h.strikeStep) * h.strikeStep;
  const out: Instrument[] = [];
  let tok = 8_000_001;
  for (const expiry of h.expiries.slice(0, 2)) {
    for (let k = lo; k <= hi; k += h.strikeStep) for (const right of ['CE', 'PE'] as const) {
      out.push({ token: tok++, tradingsymbol: kiteOptionSymbol('NIFTY', expiry, k, right), strike: k, right, expiry, lotSize: h.lotSize });
    }
  }
  return out;
}

export function histScenario(h: HistDay): Scenario {
  const seed = Number(h.date.replaceAll('-', '')) % 2_147_483_647;
  return {
    id: `hist-${h.date}`, title: `NIFTY ${h.date} · real data, modelled options`,
    summary: 'Real NIFTY 1-minute candles from Kite; option prices are MODELLED (Black-76, previous-day India VIX).',
    expect: { outcome: 'NO_TRADE', reason: '' }, date: h.date, prevDate: h.prevDate, prevAnchors: [], anchors: [],
    seed, noise: 0, iv: h.vixPrevClose ? h.vixPrevClose / 100 : 0.13, spreadPct: 0.3,
  };
}

export function histReplay(h: HistDay, o: Omit<ReplayOptions, 'data'> = {}): Replay {
  const prev: PrevSession = { date: h.prevDate, bars: h.prevBars };
  return new Replay(histScenario(h), { ...o, data: { path: pathFromMinuteBars(h.bars), prev, instruments: histInstruments(h) } });
}

/** Weekly NIFTY expiries: Tuesdays, moved to the previous trading day when Tuesday is a holiday. */
export function weeklyExpiries(date: string, isTradingDay: (d: string) => boolean, n = 2): string[] {
  const add = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
  const out: string[] = [];
  let d = date;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 2) d = add(d, 1);
  for (let i = 0; out.length < n && i < 10; i++, d = add(d, 7)) {
    let e = d;
    for (let k = 0; k < 6 && !isTradingDay(e); k++) e = add(e, -1);
    if (e >= date) out.push(e);
  }
  return out;
}
