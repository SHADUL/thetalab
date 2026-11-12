/**
 * Replay harness: drives the real PulseEngine with the SyntheticMarket, one
 * second at a time. Same seed + config ⇒ identical decisions (see tests).
 */
import type { PulseConfig } from '../core/config.ts';
import { PulseEngine } from '../core/engine.ts';
import type { ChainSnapshot } from '../core/chain.ts';
import { SyntheticMarket, sessionCloseMs, sessionOpenMs } from './market.ts';

export interface ReplayOptions {
  seed: number;
  date: string;
  config: PulseConfig;
  /** The replay engine starts running so the simulation produces decisions; the live engine is OFF by default. */
  running?: boolean;
}

export class Replay {
  readonly market: SyntheticMarket;
  readonly engine: PulseEngine;
  readonly openMs: number;
  readonly closeMs: number;
  private chainCache: { at: number; chain: ChainSnapshot } | null = null;

  readonly opts: ReplayOptions;

  constructor(opts: ReplayOptions) {
    this.opts = opts;
    this.market = new SyntheticMarket({ seed: opts.seed, date: opts.date });
    this.engine = new PulseEngine(opts.config, { dataMode: 'SIMULATION', running: opts.running ?? true });
    this.openMs = sessionOpenMs(opts.date);
    this.closeMs = sessionCloseMs(opts.date);
  }

  get now(): number { return this.market.t; }
  get done(): boolean { return this.market.t >= this.closeMs; }

  /** Current chain (memoised per second). */
  chain(): ChainSnapshot {
    if (this.chainCache?.at !== this.market.t) this.chainCache = { at: this.market.t, chain: this.market.chain() };
    return this.chainCache.chain;
  }

  step(): boolean {
    if (this.done) return false;
    const ticks = this.market.next();
    this.engine.step(this.market.t, ticks, () => this.chain());
    return true;
  }

  advance(seconds: number): number {
    let n = 0;
    while (n < seconds && this.step()) n++;
    return n;
  }

  advanceTo(ms: number): void {
    while (!this.done && this.market.t < ms) this.step();
  }

  runToEnd(): void { this.advanceTo(this.closeMs); }
}

/** Synthetic session dates (weekdays) used for multi-session simulation analytics. */
export function simDates(start: string, count: number): string[] {
  const out: string[] = [];
  let d = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86_400_000);
  }
  return out.reverse();
}
