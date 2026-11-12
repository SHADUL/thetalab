/**
 * One-second sampler: turns irregular exchange ticks into one observation
 * per second, without pretending a quiet or broken feed is live.
 *
 * Kite does not send exactly one tick per second. At each 1-second boundary
 * the sampler takes the latest price and labels it:
 *   FRESH   — at least one tick arrived during this second
 *   HELD    — no tick this second, but the last price is within the freshness
 *             threshold (a quiet but healthy market); still a valid sample
 *   STALE   — the last price is older than the freshness threshold; shown,
 *             but NOT valid for signals
 *   NO_DATA — no price has ever been received
 *
 * Freshness is measured on receipt time (server clock). The exchange timestamp
 * orders ticks: a tick whose exchange time is older than the last accepted one
 * is dropped as out-of-order instead of overwriting a newer price.
 */

export interface Tick {
  price: number;
  /** Exchange timestamp, epoch ms (null when the packet carries none). */
  exchTs: number | null;
  /** Receipt time on our server, epoch ms. */
  recvTs: number;
}

export type SampleStatus = 'FRESH' | 'HELD' | 'STALE' | 'NO_DATA';

export interface Sample {
  /** The 1-second boundary this sample belongs to, epoch ms. */
  t: number;
  price: number | null;
  status: SampleStatus;
  /** True only for FRESH and HELD. */
  valid: boolean;
  /** Ticks accepted during this second. */
  ticks: number;
  /** Age of the price at the boundary (boundary − receipt), ms. */
  ageMs: number | null;
  /** Exchange timestamp of the sampled price. */
  exchTs: number | null;
}

export class OneSecondSampler {
  private last: Tick | null = null;
  private ticksThisSecond = 0;
  /** Lifetime counters for feed statistics. */
  accepted = 0;
  dropped = 0;

  private freshnessMs: number;

  constructor(freshnessMs: number) { this.freshnessMs = freshnessMs; }

  setFreshness(ms: number) { this.freshnessMs = ms; }

  onTick(t: Tick): boolean {
    if (!(t.price > 0) || !Number.isFinite(t.price)) { this.dropped++; return false; }
    if (this.last && t.exchTs != null && this.last.exchTs != null && t.exchTs < this.last.exchTs) {
      this.dropped++;
      return false;
    }
    this.last = t;
    this.ticksThisSecond++;
    this.accepted++;
    return true;
  }

  sample(boundaryMs: number): Sample {
    const ticks = this.ticksThisSecond;
    this.ticksThisSecond = 0;
    if (!this.last) return { t: boundaryMs, price: null, status: 'NO_DATA', valid: false, ticks: 0, ageMs: null, exchTs: null };
    const ageMs = Math.max(0, boundaryMs - this.last.recvTs);
    let status: SampleStatus;
    if (ticks > 0) status = 'FRESH';
    else if (ageMs <= this.freshnessMs) status = 'HELD';
    else status = 'STALE';
    return { t: boundaryMs, price: this.last.price, status, valid: status === 'FRESH' || status === 'HELD', ticks, ageMs, exchTs: this.last.exchTs };
  }

  lastTick(): Tick | null { return this.last; }
}
