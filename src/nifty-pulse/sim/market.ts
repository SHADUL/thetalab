/**
 * Deterministic SYNTHETIC market for replay / simulation mode.
 *
 * Everything here is invented: index prices, ticks, option quotes, the lot
 * size and the expiry. It exists so the engine and the interface can be
 * exercised outside market hours with identical results for the same seed.
 * Nothing produced here may be shown or reported as market data; every
 * snapshot carries source: 'SIMULATION'.
 *
 * Model (per second):
 *   regimes   CALM (mean-reverting noise) / UP / DOWN (directional bursts)
 *             / GAP (feed silence: no ticks, option quotes go stale)
 *   ticks     0–3 per second (Kite does not send exactly one per second),
 *             each with an exchange timestamp and 20–140 ms receipt latency
 *   options   Black-76 mid with a volatility smile, bid/ask around mid
 *             rounded to the 0.05 tick, random top-of-book depth, and
 *             occasional one-sided/thin books
 */
import { black76 } from '../../quant/pricing/black76.ts';
import type { Tick } from '../core/sampler.ts';
import type { ChainSnapshot, OptionQuote, Right } from '../core/chain.ts';

export const SIM_LOT_SIZE = 65;
export const SIM_STRIKE_STEP = 50;
export const SIM_STRIKES_EACH_SIDE = 20;

/** Seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless hash → [0,1) for per-(second, strike) quote noise. */
export function hash01(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h ^= Math.floor(x) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

const tick05 = (x: number) => Math.round(x * 20) / 20;

type Regime = 'CALM' | 'UP' | 'DOWN' | 'GAP';

export interface SimDayOptions {
  seed: number;
  /** IST calendar date of the synthetic session, YYYY-MM-DD. */
  date: string;
  startSpot?: number;
}

/** 09:15:00 IST on `date`, epoch ms. */
export function sessionOpenMs(date: string): number {
  return Date.parse(`${date}T09:15:00+05:30`);
}
export function sessionCloseMs(date: string): number {
  return Date.parse(`${date}T15:30:00+05:30`);
}

export class SyntheticMarket {
  readonly seed: number;
  readonly date: string;
  readonly expiry: string;
  readonly expiryMs: number;
  /** Current second boundary (epoch ms); advanced by next(). */
  t: number;
  spot: number;
  regime: Regime = 'CALM';
  private left = 30;
  private anchor: number;
  private rnd: () => number;
  private lastQuoteTs: number;
  private exch: number;

  constructor(o: SimDayOptions) {
    this.seed = o.seed;
    this.date = o.date;
    this.rnd = mulberry32(o.seed * 7919 + 17);
    this.spot = o.startSpot ?? tick05(24_600 + Math.floor(this.rnd() * 1_600));
    this.anchor = this.spot;
    this.t = sessionOpenMs(o.date);
    this.lastQuoteTs = this.t;
    this.exch = this.t;
    // Synthetic weekly expiry: the next Tuesday strictly after the session date.
    const d = new Date(`${o.date}T00:00:00Z`);
    const add = ((2 - d.getUTCDay() + 7) % 7) || 7;
    const e = new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
    this.expiry = e;
    this.expiryMs = Date.parse(`${e}T15:30:00+05:30`);
  }

  private gauss(): number {
    // Box–Muller from the seeded stream.
    const u = Math.max(1e-12, this.rnd()), v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private nextRegime() {
    const r = this.rnd();
    if (r < 0.62) { this.regime = 'CALM'; this.left = 45 + Math.floor(this.rnd() * 200); }
    else if (r < 0.80) { this.regime = 'UP'; this.left = 12 + Math.floor(this.rnd() * 60); }
    else if (r < 0.985) { this.regime = 'DOWN'; this.left = 12 + Math.floor(this.rnd() * 60); }
    else { this.regime = 'GAP'; this.left = 3 + Math.floor(this.rnd() * 7); }
  }

  /** Advance one second; returns the ticks received during (t, t+1000]. */
  next(): Tick[] {
    const from = this.t;
    this.t += 1000;
    if (--this.left <= 0) this.nextRegime();
    if (this.regime === 'GAP') return [];
    const u = this.rnd();
    const n = u < 0.06 ? 0 : u < 0.76 ? 1 : u < 0.96 ? 2 : 3;
    const ticks: Tick[] = [];
    const drift = this.regime === 'UP' ? 1.05 : this.regime === 'DOWN' ? -1.05 : (this.anchor - this.spot) * 0.004;
    const sd = this.regime === 'CALM' ? 1.5 : 1.35;
    for (let i = 0; i < n; i++) {
      this.spot = tick05(this.spot + drift / n + (sd / Math.sqrt(n)) * this.gauss());
      const latency = 20 + Math.floor(this.rnd() * 120);
      const recv = from + Math.floor(((i + 1) / (n + 1)) * 1000);
      this.exch = Math.max(this.exch, recv - latency);
      ticks.push({ price: this.spot, exchTs: this.exch, recvTs: recv });
    }
    if (this.regime === 'CALM' && this.rnd() < 0.01) this.anchor = this.spot;
    this.lastQuoteTs = this.t - 40 - Math.floor(this.rnd() * 300);
    return ticks;
  }

  /** Option-chain snapshot at the current boundary. */
  chain(): ChainSnapshot {
    const now = this.t;
    const spot = this.spot;
    const gap = this.regime === 'GAP';
    const quoteTs = gap ? this.lastQuoteTs : now - 60 - Math.floor(hash01(this.seed, now / 1000, 1) * 400);
    const T = Math.max(1e-6, (this.expiryMs - now) / (365 * 86_400_000));
    const seed = this.seed;
    const sec = Math.floor(now / 1000);
    const minute = Math.floor(sec / 60);
    const atm = Math.round(spot / SIM_STRIKE_STEP) * SIM_STRIKE_STEP;
    const lo = atm - SIM_STRIKES_EACH_SIDE * SIM_STRIKE_STEP;
    const hi = atm + SIM_STRIKES_EACH_SIDE * SIM_STRIKE_STEP;
    const expiry = this.expiry;
    const cache = new Map<string, OptionQuote>();
    const ivBase = 0.118 + 0.008 * Math.sin(sec / 2_700 + seed);
    return {
      underlying: 'NIFTY', spot, expiry, lotSize: SIM_LOT_SIZE, strikeStep: SIM_STRIKE_STEP, at: now, source: 'SIMULATION',
      quote(strike: number, right: Right): OptionQuote | undefined {
        if (strike < lo || strike > hi || strike % SIM_STRIKE_STEP !== 0) return undefined;
        const key = `${strike}${right}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const m = Math.log(strike / spot);
        const iv = ivBase + 0.55 * Math.abs(m) + (m < 0 ? 0.9 * -m : 0);
        const midPx = black76({ forward: spot, strike, timeToExpiry: T, vol: iv, rate: 0, right }).price;
        const h = hash01(seed, sec, strike, right === 'CE' ? 1 : 2);
        const h2 = hash01(seed, minute, strike, right === 'CE' ? 3 : 4);
        const half = 0.025 + midPx * 0.0006 + h * 0.06 + (Math.abs(m) > 0.02 ? 0.15 : 0);
        let bid: number | null = Math.max(0.05, Math.floor((midPx - half) * 20) / 20);
        let ask: number | null = Math.max(bid + 0.05, Math.ceil((midPx + half) * 20) / 20);
        // Occasional thin / one-sided books (changes once a minute per strike).
        let bidQty = SIM_LOT_SIZE * (1 + Math.floor(h2 * 36));
        let askQty = SIM_LOT_SIZE * (1 + Math.floor(hash01(seed, minute, strike, 9) * 36));
        if (h2 > 0.975) { bid = null; bidQty = 0; }
        else if (h2 < 0.02) { ask = null; askQty = 0; }
        else if (h2 > 0.94) { bidQty = Math.floor(SIM_LOT_SIZE / 2); }
        const q: OptionQuote = {
          token: 9_000_000 + strike * 2 + (right === 'CE' ? 0 : 1),
          tradingsymbol: `SIM-NIFTY ${expiry.slice(5)} ${strike} ${right}`,
          strike, right, expiry, lotSize: SIM_LOT_SIZE,
          bid, ask, bidQty, askQty, ltp: tick05(midPx), ts: quoteTs,
        };
        cache.set(key, q);
        return q;
      },
    };
  }
}
