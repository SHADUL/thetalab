/**
 * NIFTY ASCENT historical backtest data: real NIFTY 1-minute candles, the
 * previous session's closes and the previous day's India VIX, fetched once
 * from Kite's historical API (read-only GETs through the shared throttle) and
 * cached on the VM's persistent archive disk. Completed past trading days only.
 * Nothing here is sent anywhere but the logged-in browser; no credentials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { previousTradingDay, candleLabel } from '../src/nifty-ascent/live/history.ts';
import { weeklyExpiries, type HistDay, type MinuteCandle } from '../src/nifty-ascent/sim/historical.ts';
import { SESSION_FIRST_BAR, SESSION_LAST_BAR, istDateOf } from '../src/nifty-ascent/core/rules.ts';

export type FetchData = (path: string) => Promise<any>;
const NIFTY = 256265, INDIA_VIX = 264969;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function candles(day: string, raw: unknown[]): MinuteCandle[] {
  const seen = new Map<number, MinuteCandle>();
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 5) continue;
    const lab = candleLabel(String(c[0]));
    if (!lab || lab.date !== day || lab.label < SESSION_FIRST_BAR || lab.label > SESSION_LAST_BAR) continue;
    const [o, h, l, cl] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])];
    if (![o, h, l, cl].every((v) => v > 0 && Number.isFinite(v)) || seen.has(lab.label)) continue;
    seen.set(lab.label, { label: lab.label, o, h, l, c: cl });
  }
  return [...seen.values()].sort((a, b) => a.label - b.label);
}

/** Trading days of `month` (YYYY-MM) strictly before today IST. */
export function monthTradingDays(month: string, isTradingDay: (d: string) => boolean, nowMs = Date.now()): string[] {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  const today = istDateOf(nowMs), out: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) if (d < today && isTradingDay(d)) out.push(d);
  return out;
}

export class AscentHistory {
  private readonly dir: string;
  private readonly fetchData: FetchData;
  private readonly isTradingDay: (d: string) => boolean;
  private inflight = new Map<string, Promise<HistDay>>();
  /** Kite allows ~3 historical requests/s: requests are serialised and spaced, and a 429 is retried with backoff. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(o: { dir: string; fetchData: FetchData; isTradingDay: (d: string) => boolean; gapMs?: number; sleep?: (ms: number) => Promise<void> }) {
    this.dir = o.dir; this.fetchData = o.fetchData; this.isTradingDay = o.isTradingDay;
    this.gapMs = o.gapMs ?? 400; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  private get(p: string): Promise<any> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try { const v = await this.fetchData(p); await this.sleep(this.gapMs); return v; }
        catch (e) {
          await this.sleep(this.gapMs);
          if (attempt >= 3 || !/\b429\b/.test(String((e as Error)?.message))) throw e;
          await this.sleep(1000 * (attempt + 1));
        }
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private file(date: string) { return path.join(this.dir, `${date}.json`); }
  isCached(date: string) { return fs.existsSync(this.file(date)); }

  async day(date: string, nowMs = Date.now()): Promise<HistDay> {
    if (!DATE.test(date)) throw new Error('date must be YYYY-MM-DD');
    if (date >= istDateOf(nowMs)) throw new Error('only completed past sessions can be backtested');
    if (!this.isTradingDay(date)) throw new Error(`${date} is not a trading day`);
    if (this.isCached(date)) return JSON.parse(fs.readFileSync(this.file(date), 'utf8'));
    const running = this.inflight.get(date);
    if (running) return running;
    const p = this.fetchDay(date).finally(() => this.inflight.delete(date));
    this.inflight.set(date, p);
    return p;
  }

  private async fetchDay(date: string): Promise<HistDay> {
    const prevDate = previousTradingDay(date, this.isTradingDay);
    if (!prevDate) throw new Error(`no previous trading day for ${date}`);
    const today = await this.get(`/instruments/historical/${NIFTY}/minute?from=${date}+09:15:00&to=${date}+15:30:00`);
    const prev = await this.get(`/instruments/historical/${NIFTY}/minute?from=${prevDate}+09:15:00&to=${prevDate}+15:30:00`);
    const vix = await this.get(`/instruments/historical/${INDIA_VIX}/day?from=${addDays(prevDate, -10)}+00:00:00&to=${prevDate}+23:59:59`);
    const bars = candles(date, today?.candles ?? []);
    const prevBars = candles(prevDate, prev?.candles ?? []).map((b) => ({ label: b.label, close: b.c }));
    if (bars.length < 300) throw new Error(`Kite returned only ${bars.length} NIFTY minute candles for ${date}`);
    const vixRows = (vix?.candles ?? []).filter((c: unknown) => Array.isArray(c) && String(c[0]).slice(0, 10) <= prevDate);
    const vixPrevClose = vixRows.length ? Number(vixRows[vixRows.length - 1][4]) : null;
    const h: HistDay = {
      kind: 'NIFTY_ASCENT_HIST_DAY', date, prevDate, bars, prevBars, vixPrevClose,
      expiries: weeklyExpiries(date, this.isTradingDay, 2), lotSize: 65, strikeStep: 50,
      source: 'KITE_HISTORICAL', fetchedAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(date), JSON.stringify(h));
    return h;
  }
}
