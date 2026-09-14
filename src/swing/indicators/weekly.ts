import type { Bar } from './types.ts';

/** Monday of the calendar week containing `dateStr` (YYYY-MM-DD), used
 *  purely as a grouping key — not a claim about trading calendars. */
export function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Rolls daily bars up into one bar per Mon-Sun trading week: first open,
 * highest high, lowest low, last close, summed volume. `t` on each weekly
 * bar is the LAST trading day actually seen that week (not the Monday) —
 * that's what a caller needs to know "is this weekly bar's week actually
 * over yet" when aligning it against a daily series without look-ahead
 * (see runBacktest-style scripts for that alignment).
 */
export function aggregateWeekly(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let weekKey: string | null = null;
  let cur: Bar | null = null;
  for (const b of bars) {
    const key = mondayOf(b.t);
    if (key !== weekKey) {
      if (cur) out.push(cur);
      cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      weekKey = key;
    } else if (cur) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      cur.t = b.t;
    }
  }
  if (cur) out.push(cur);
  return out;
}
