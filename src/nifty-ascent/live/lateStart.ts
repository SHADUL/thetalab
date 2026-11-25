/**
 * Late-start recovery (owner decision 25 Nov 2026): when the live engine missed
 * the start of the session (e.g. a late Kite login), it may be rebuilt from
 * Kite's 1-minute candles — but ONLY for minutes before the Gap-and-Go signal
 * window (09:46). Those minutes only build today's reference (09:15 open), the
 * gap, the gap-fill check and the opening range (31 closes); no trade can come
 * from them. Any minute from 09:46 on that was not observed live ⇒ no recovery
 * (signals are never reconstructed from later data).
 *
 * Minutes the live stream observed in full are replayed from the live ticks
 * themselves; a minute is "observed in full" when it has ticks and the stream
 * was already delivering just before it started (no gap > 5 s).
 */
import { barStart, hhmm, type ResearchRules } from '../core/rules.ts';
import type { IndexTick } from '../core/engine.ts';

export interface Candle1m { label: number; o: number; h: number; l: number; c: number }
export type CatchUpPlan =
  | { ok: true; ticks: IndexTick[]; candleMinutes: number[]; liveMinutes: number[] }
  | { ok: false; retry: boolean; why: string };

const CONTINUITY_MS = 5_000;
const FIRST_TICK_MS = 2_000;

/** Kite historical minute candles → label-keyed candles for `date`. */
export function parseKiteCandles(date: string, data: any): Map<number, Candle1m> {
  const out = new Map<number, Candle1m>();
  for (const c of data?.candles ?? []) {
    if (!Array.isArray(c) || c.length < 5) continue;
    const t = Date.parse(String(c[0]).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    const label = Math.round((t - Date.parse(`${date}T00:00:00+05:30`)) / 60_000);
    const [o, h, l, cl] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])];
    if ([o, h, l, cl].every((x) => Number.isFinite(x) && x > 0)) out.set(label, { label, o, h, l, c: cl });
  }
  return out;
}

/** Four ticks reproducing a candle's open, high, low and close inside its minute. */
export function candleTicks(date: string, k: Candle1m): IndexTick[] {
  const s = barStart(date, k.label);
  const mid = k.c >= k.o ? [k.l, k.h] : [k.h, k.l];
  return [[0, k.o], [20_000, mid[0]], [40_000, mid[1]], [59_000, k.c]].map(([dt, p]) => ({ exchTs: s + dt, recvTs: s + dt + 250, price: p }));
}

export function planCatchUp(date: string, nowMs: number, live: IndexTick[], candles: Map<number, Candle1m>, rules: ResearchRules): CatchUpPlan {
  const first = rules.orFirstBar, cutoff = rules.gapGoFirstBar;
  const current = Math.floor((nowMs - barStart(date, 0)) / 60_000);
  if (current < first) return { ok: false, retry: true, why: 'market not open yet' };
  const byLabel = new Map<number, IndexTick[]>();
  for (const t of [...live].sort((a, b) => a.exchTs - b.exchTs)) {
    const l = Math.floor((t.exchTs - barStart(date, 0)) / 60_000);
    if (!byLabel.has(l)) byLabel.set(l, []);
    byLabel.get(l)!.push(t);
  }
  const covered = (l: number) => {
    const ts = byLabel.get(l);
    if (!ts?.length) return false;
    if (l === first) return ts[0].exchTs - barStart(date, l) <= FIRST_TICK_MS;
    const prev = byLabel.get(l - 1);
    return !!prev?.length && ts[0].exchTs - prev[prev.length - 1].exchTs <= CONTINUITY_MS;
  };
  const lastLive = live.length ? Math.max(...live.map((t) => t.exchTs)) : 0;
  if (nowMs - lastLive > CONTINUITY_MS) return { ok: false, retry: true, why: 'live NIFTY prices are not arriving yet' };
  const ticks: IndexTick[] = [], candleMinutes: number[] = [], liveMinutes: number[] = [];
  for (let l = first; l < current; l++) {
    if (covered(l)) { ticks.push(...byLabel.get(l)!); liveMinutes.push(l); continue; }
    if (l >= cutoff) return { ok: false, retry: false, why: `minute ${hhmm(l)} (signal window) was not observed live — signals are never rebuilt from history` };
    const k = candles.get(l);
    if (!k) return { ok: false, retry: true, why: `Kite candle ${hhmm(l)} not available yet` };
    ticks.push(...candleTicks(date, k)); candleMinutes.push(l);
  }
  // The minute in progress must be observed live from its start; otherwise wait for it to complete.
  if (!covered(current)) {
    if (current >= cutoff) return { ok: false, retry: false, why: `minute ${hhmm(current)} (signal window) was not observed live from its start` };
    return { ok: false, retry: true, why: `waiting for ${hhmm(current)} to complete (the stream joined mid-minute)` };
  }
  ticks.push(...byLabel.get(current)!); liveMinutes.push(current);
  return { ok: true, ticks, candleMinutes, liveMinutes };
}
