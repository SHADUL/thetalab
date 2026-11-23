/**
 * Deterministic SIMULATION market for NIFTY ASCENT replay. Everything here
 * is synthetic: index paths are drawn through hand-placed anchors plus seeded
 * noise; option quotes are Black-76 prices off that path with modelled
 * spreads. Nothing is market data and nothing here is evidence of
 * profitability. Same scenario + same seed ⇒ identical event stream.
 */
import { black76 } from '../../quant/pricing/black76.ts';
import { barStart, istMidnight, SESSION_FIRST_BAR, type ExecutionSettings } from '../core/rules.ts';
import { AscentEngine, type Instrument, type PrevSession } from '../core/engine.ts';

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  /** What this fixture is built to demonstrate (asserted by tests). */
  expect: { outcome: 'TRADE' | 'NO_TRADE' | 'DATA_ERROR'; reason: string; bot?: 'GAP_AND_GO' | 'WILLIAMS'; standDown?: string };
  date: string;
  prevDate: string;
  /** Previous day close-path anchors [HH:MM, close]; extremes are exact. */
  prevAnchors: Array<[string, number]>;
  /** Today's anchors [HH:MM or HH:MM:SS, price]; the 09:15:00 anchor is the first tick. */
  anchors: Array<[string, number]>;
  seed: number;
  noise: number;
  iv: number;
  spreadPct?: number;
  missing?: Array<[string, string]>;
  noPrint?: string[];
  lotSize?: number;
}

/* ---------------- seeded RNG ---------------- */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const secOf = (hms: string) => { const [h, m, s = '0'] = hms.split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
const r05 = (v: number) => Math.round(v * 20) / 20;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Second-by-second index path 09:15:00 … 15:29:59 (22,500 points). */
export function indexPath(sc: Scenario): Float64Array {
  const start = secOf('09:15:00'), end = secOf('15:30:00');
  const n = end - start;
  const a = sc.anchors.map(([t, p]) => [secOf(t) - start, p] as const).sort((x, y) => x[0] - y[0]);
  const out = new Float64Array(n);
  const rnd = mulberry32(sc.seed);
  let e = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < a.length - 2 && i > a[k + 1][0]) k++;
    const [t0, p0] = a[Math.min(k, a.length - 1)], [t1, p1] = a[Math.min(k + 1, a.length - 1)];
    const base = i <= t0 ? p0 : i >= t1 ? p1 : p0 + ((p1 - p0) * (i - t0)) / (t1 - t0);
    e = 0.9 * e + (rnd() - 0.5) * sc.noise;
    // Anchors are exact: noise fades to zero within 20 s of any anchor.
    const dist = Math.min(Math.abs(i - t0), Math.abs(i - t1));
    out[i] = r2(base + e * Math.min(1, dist / 20));
  }
  return out;
}

/** Previous session minute closes 09:15 … 15:29 with exact anchor values and extremes. */
export function prevSession(sc: Scenario): PrevSession {
  const a = sc.prevAnchors.map(([t, p]) => [secOf(t) / 60 - SESSION_FIRST_BAR, p] as const);
  const hi = Math.max(...a.map((x) => x[1])), lo = Math.min(...a.map((x) => x[1]));
  const rnd = mulberry32(sc.seed ^ 0x9e3779b9);
  const bars: Array<{ label: number; close: number }> = [];
  let k = 0;
  for (let m = 0; m < 375; m++) {
    while (k < a.length - 2 && m > a[k + 1][0]) k++;
    const [t0, p0] = a[k], [t1, p1] = a[Math.min(k + 1, a.length - 1)];
    const base = m <= t0 ? p0 : m >= t1 ? p1 : p0 + ((p1 - p0) * (m - t0)) / (t1 - t0);
    const exact = a.find((x) => x[0] === m);
    const v = exact ? exact[1] : Math.min(hi - 0.05, Math.max(lo + 0.05, base + (rnd() - 0.5) * 6));
    bars.push({ label: SESSION_FIRST_BAR + m, close: r2(v) });
  }
  return { date: sc.prevDate, bars };
}

/** Next two weekly (Tuesday) expiries on/after the date, plus today's if it is a Tuesday. */
export function simExpiries(date: string): string[] {
  const d = new Date(`${date}T00:00:00Z`);
  const out: string[] = [];
  for (let i = 0; out.length < 2 && i < 21; i++) {
    const x = new Date(d.getTime() + i * 864e5);
    if (x.getUTCDay() === 2) out.push(x.toISOString().slice(0, 10));
  }
  return out;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/**
 * Kite/NSE option symbol convention (SIMULATION instruments only — live
 * symbols always come from the instrument master): the month's last weekly
 * expiry is the monthly contract, NIFTY{YY}{MON}{strike}{CE|PE}; other
 * weeklies are NIFTY{YY}{M}{DD}{strike}{CE|PE} with M = 1–9, O, N, D.
 */
export function kiteOptionSymbol(root: string, expiry: string, strike: number, right: 'CE' | 'PE'): string {
  const d = new Date(`${expiry}T00:00:00Z`);
  const monthly = new Date(d.getTime() + 7 * 864e5).getUTCMonth() !== d.getUTCMonth();
  const yy = expiry.slice(2, 4), m = d.getUTCMonth();
  return monthly ? `${root}${yy}${MONTHS[m]}${strike}${right}` : `${root}${yy}${'123456789OND'[m]}${expiry.slice(8)}${strike}${right}`;
}

export function simInstruments(sc: Scenario): Instrument[] {
  const open = sc.anchors[0][1];
  const lo = Math.floor((open - 2000) / 50) * 50, hi = Math.ceil((open + 2000) / 50) * 50;
  const out: Instrument[] = [];
  let tok = 9_000_001;
  for (const expiry of simExpiries(sc.date)) {
    for (let k = lo; k <= hi; k += 50) {
      for (const right of ['CE', 'PE'] as const) {
        out.push({ token: tok++, tradingsymbol: kiteOptionSymbol('NIFTY', expiry, k, right), strike: k, right, expiry, lotSize: sc.lotSize ?? 65 });
      }
    }
  }
  return out;
}

/* ---------------- replay driver ---------------- */

export interface ReplayOptions { exec?: ExecutionSettings; startRunning?: boolean }

/**
 * Drives an AscentEngine second by second: clock(t) → index tick (exch t,
 * received +120–260 ms) → quotes for every token the engine wants (exch
 * t+400 ms, received +520–650 ms). Deterministic for a given scenario.
 */
export class Replay {
  readonly sc: Scenario;
  engine: AscentEngine;
  readonly path: Float64Array;
  readonly instruments: Instrument[];
  readonly startMs: number;
  readonly endMs: number;
  t: number;
  private rnd: () => number;
  private vol = new Map<number, number>();
  private missing: Array<[number, number]>;
  private noPrint: Set<string>;
  private byToken: Map<number, Instrument>;

  constructor(sc: Scenario, o: ReplayOptions = {}) {
    this.sc = sc;
    this.path = indexPath(sc);
    this.instruments = simInstruments(sc);
    this.byToken = new Map(this.instruments.map((i) => [i.token, i]));
    this.engine = new AscentEngine({ date: sc.date, prev: prevSession(sc), instruments: this.instruments, exec: o.exec, startRunning: o.startRunning ?? true });
    this.startMs = barStart(sc.date, 9 * 60 + 10);
    this.endMs = barStart(sc.date, 15 * 60 + 31);
    this.t = this.startMs;
    this.rnd = mulberry32(sc.seed * 7 + 3);
    const mid = istMidnight(sc.date);
    this.missing = (sc.missing ?? []).map(([a, b]) => [mid + secOf(a) * 1000, mid + secOf(b) * 1000]);
    this.noPrint = new Set(sc.noPrint ?? []);
  }

  get done() { return this.t > this.endMs; }

  /** NIFTY at epoch ms (null outside the session). */
  spotAt(ms: number): number | null {
    const i = Math.floor((ms - barStart(this.sc.date, SESSION_FIRST_BAR)) / 1000);
    return i >= 0 && i < this.path.length ? this.path[i] : null;
  }

  stepTo(ms: number) {
    while (this.t <= Math.min(ms, this.endMs)) { this.second(this.t); this.t += 1000; }
  }
  runToEnd() { this.stepTo(this.endMs); return this.engine; }

  private second(t: number) {
    const e = this.engine;
    e.onClock(t);
    const spot = this.spotAt(t);
    if (spot == null) return;
    if (!this.missing.some(([a, b]) => t >= a && t <= b)) {
      e.onIndexTick({ exchTs: t, recvTs: t + 120 + Math.floor(this.rnd() * 140), price: spot });
    }
    const hm = new Date(t + 330 * 60_000).toISOString().slice(11, 16);
    for (const tok of e.wantedTokens()) {
      const inst = this.byToken.get(tok);
      if (!inst) continue;
      const q = this.quote(inst, spot, t + 400);
      const traded = !this.noPrint.has(hm) && this.rnd() < 0.8;
      const v = (this.vol.get(tok) ?? 180_000 + Math.floor(this.rnd() * 40_000)) + (traded ? 65 * (1 + Math.floor(this.rnd() * 6)) : 0);
      this.vol.set(tok, v);
      const ltp = traded ? r05(this.rnd() < 0.5 ? q.bid : q.ask) : null;
      e.onOptionTick({ token: tok, exchTs: t + 400, recvTs: t + 520 + Math.floor(this.rnd() * 130), ltp, traded, bid: q.bid, ask: q.ask, volume: v });
    }
  }

  /** Black-76 mid with a modelled spread (SIMULATION only). */
  quote(inst: Instrument, spot: number, at: number): { bid: number; ask: number; mid: number } {
    const T = Math.max(Date.parse(`${inst.expiry}T15:30:00+05:30`) - at, 60_000) / (365 * 864e5);
    const r = 0.065;
    const px = black76({ forward: spot * Math.exp(r * T), strike: inst.strike, timeToExpiry: T, vol: this.sc.iv, rate: r, right: inst.right }).price;
    const mid = Math.max(px, 0.05);
    const half = Math.max(0.05, r05((mid * (this.sc.spreadPct ?? 0.3)) / 200));
    const bid = Math.max(0.05, r05(mid - half)), ask = r05(Math.max(bid + 0.05, mid + half));
    return { bid, ask, mid: r2(mid) };
  }
}
