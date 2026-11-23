/** Test harness: exact, minute-controlled sessions for the NIFTY ASCENT engine. */
import { AscentEngine, type Instrument, type PrevSession, type OptionTick } from '../core/engine.ts';
import { DEFAULT_EXECUTION, istMidnight, type ExecutionSettings } from '../core/rules.ts';

export const D = '2026-11-18'; // a Wednesday; weekly expiries 2026-11-24 and 2026-12-01
export const at = (date: string, hms: string) => {
  const [h, m, s = '0'] = hms.split(':');
  return istMidnight(date) + ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
};

/** 375 previous-day closes with an exact 15:15 close and exact extremes. */
export function prevBars(o: { close1515?: number; hi?: number; lo?: number; drop?: number[]; close1514?: number } = {}): PrevSession {
  const close1515 = o.close1515 ?? 25100, hi = o.hi ?? 25260, lo = o.lo ?? 25010;
  const bars: Array<{ label: number; close: number }> = [];
  for (let m = 555; m <= 929; m++) {
    let c = 25120 + ((m * 7) % 23) - 11;
    if (m === 660) c = hi;
    if (m === 810) c = lo;
    if (m === 915) c = close1515;
    if (m === 914 && o.close1514 != null) c = o.close1514;
    if (!(o.drop ?? []).includes(m)) bars.push({ label: m, close: c });
  }
  return { date: '2026-11-17', bars };
}

export function instruments(expiries = ['2026-11-24', '2026-12-01'], lot = 65): Instrument[] {
  const out: Instrument[] = [];
  let tok = 100;
  for (const e of expiries) for (let k = 24000; k <= 26500; k += 50) for (const r of ['CE', 'PE'] as const) {
    out.push({ token: tok++, tradingsymbol: `NIFTY${e}${k}${r}`, strike: k, right: r, expiry: e, lotSize: lot });
  }
  return out;
}

export function engine(o: { date?: string; prev?: PrevSession; inst?: Instrument[]; exec?: Partial<ExecutionSettings>; running?: boolean } = {}) {
  return new AscentEngine({
    date: o.date ?? D, prev: o.prev ?? prevBars(), instruments: o.inst ?? instruments(),
    exec: { ...DEFAULT_EXECUTION, ...(o.exec ?? {}) }, startRunning: o.running ?? true,
  });
}

/** Step function: price of the latest point at or before t ([HH:MM(:SS), price]). */
export function steps(date: string, pts: Array<[string, number]>) {
  const xs = pts.map(([h, p]) => [at(date, h), p] as const).sort((a, b) => a[0] - b[0]);
  return (t: number): number | null => {
    let v: number | null = null;
    for (const [x, p] of xs) { if (x <= t) v = p; else break; }
    return v;
  };
}

export type QuoteFn = (inst: Instrument, t: number, spot: number | null) => Omit<OptionTick, 'token' | 'exchTs' | 'recvTs'> | null;

/** Intrinsic + 40 time value, 0.5 wide, always traded, deep volume. */
export const defaultQuote: QuoteFn = (inst, _t, spot) => {
  if (spot == null) return null;
  const intr = inst.right === 'CE' ? Math.max(spot - inst.strike, 0) : Math.max(inst.strike - spot, 0);
  const p = Math.round((intr + 40) * 20) / 20;
  return { ltp: p, traded: true, bid: p - 0.25, ask: p + 0.25, volume: 50_000 };
};

/** Drive second by second: clock → index tick (exch t, +150 ms) → wanted quotes (exch t+400, +100 ms). */
export function drive(e: AscentEngine, o: { date?: string; from?: string; to?: string; index: (t: number) => number | null; quote?: QuoteFn; onSecond?: (t: number) => void }) {
  const date = o.date ?? D;
  const quote = o.quote ?? defaultQuote;
  const byTok = new Map(e.instruments.map((i) => [i.token, i]));
  for (let t = at(date, o.from ?? '09:14:00'); t <= at(date, o.to ?? '15:31:00'); t += 1000) {
    o.onSecond?.(t);
    e.onClock(t);
    const sessionOn = t >= at(date, '09:15:00') && t < at(date, '15:30:00');
    const spot = sessionOn ? o.index(t) : null;
    if (spot != null) e.onIndexTick({ exchTs: t, recvTs: t + 150, price: spot });
    for (const tok of e.wantedTokens()) {
      const q = quote(byTok.get(tok)!, t + 400, sessionOn ? o.index(t) : null);
      if (q) e.onOptionTick({ token: tok, exchTs: t + 400, recvTs: t + 500, ...q });
    }
  }
  return e;
}

/** Standard gap-up session: prev 25,100 → open 25,200; OR closes 25,180–25,230 → bands 25,235 / 25,175. */
export const GAP_UP_OR: Array<[string, number]> = [['09:15:00', 25200], ['09:20', 25230], ['09:30', 25180], ['09:40', 25210]];
export const GAP_DOWN_OR: Array<[string, number]> = [['09:15:00', 25000], ['09:20', 25030], ['09:30', 24980], ['09:40', 25010]];
