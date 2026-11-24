/**
 * NIFTY ASCENT — LIVE mirror of the live PAPER engine (owner decision 24 Nov 2026:
 * live uses exactly the live paper engine and settings).
 *
 *   entry  when the paper entry FILLS (and the owner has armed live, and the server
 *          runs with LIVE_ORDERS=on, and this server holds the single-engine lease),
 *          BUY the same contract and quantity at Zerodha with a marketable LIMIT capped
 *          by the same premium-outlay / theoretical-loss budget. Then place the broker
 *          stop (crash guard) a little beyond the strategy's fixed stop.
 *   exit   as soon as the paper engine starts its exit (fixed/trailing stop, time
 *          exit, KILL/FLATTEN) — or if the paper position is gone, or at 15:20 as a
 *          time guard — close the real position.
 *
 * Paper and live are separate records: live results come only from real broker
 * fills and are never mixed into the live paper journal. At most one real entry
 * per day (one record per day is enough to stop a second attempt, even after a
 * restart). A paper fill older than 60 s (e.g. seen after a restart) is not chased.
 */
import type { AscentEngine } from '../nifty-ascent/core/engine.ts';
import { buyFees, sellFees } from '../nifty-ascent/core/costs.ts';
import { DONE, floorTick, TICK, type LiveOrderRunner, type LivePosition, type LiveStorePort, type Quote } from './runner.ts';
import type { LiveControlState } from './control.ts';

export interface MirrorDeps {
  runner: LiveOrderRunner;
  store: LiveStorePort;
  /** Server switch: LIVE_ORDERS=on and the broker is configured. */
  liveEnabled: () => boolean;
  /** Latest owner control (cached by the caller). */
  control: () => LiveControlState | null;
  /** REST quote fallback. */
  quote?: (tradingsymbol: string) => Promise<Quote | null>;
  log?: (m: string) => void;
}

const TIME_GUARD_MIN = 15 * 60 + 20;
const FRESH_MS = 5_000;
const MAX_CHASE_MS = 60_000;
const minuteOf = (t: number) => { const d = new Date(t + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** Highest unit price that keeps premium + fees inside both budget limits. */
export function budgetCap(qty: number, maxOutlay: number, maxLoss: number): number {
  let p = floorTick(Math.min(maxOutlay, maxLoss) / qty);
  while (p > TICK && (p * qty + buyFees(p, qty) > maxOutlay || p * qty + buyFees(p, qty) + sellFees(0, qty) > maxLoss)) p = Math.round((p - TICK) * 100) / 100;
  return p;
}

export class AscentLiveMirror {
  private readonly d: MirrorDeps;
  date: string | null = null;
  pos: LivePosition | null = null;
  attempted = false;
  private loaded = false;
  private busy = false;
  private lastSync = 0;
  private lastRetry = 0;
  lastSkip: string | null = null;

  constructor(d: MirrorDeps) { this.d = d; }
  private log(m: string) { this.d.log?.(`[LIVE NIFTY_ASCENT] ${m}`); }

  status() {
    const c = this.d.control();
    return { enabled: this.d.liveEnabled(), armed: !!c?.armed, settings: c?.settings ?? null, date: this.date, attemptedToday: this.attempted, lastSkip: this.lastSkip, position: this.pos };
  }

  private freshQuote(e: AscentEngine, token: number, now: number): Quote | null {
    const q = e.lastQuote.get(token);
    return q && now - q.recvTs <= FRESH_MS ? { bid: q.bid, ask: q.ask, ltp: q.ltp } : null;
  }

  /** One pass; call every second. Never overlaps itself. */
  async step(e: AscentEngine | null, leaseOk: boolean, now: number): Promise<void> {
    if (!e || this.busy) return;
    if (e.date !== this.date) { this.date = e.date; this.pos = null; this.attempted = false; this.loaded = false; this.lastSkip = null; }
    this.busy = true;
    try {
      if (!this.loaded) await this.load(e);
      const p = this.pos;
      if (p && !DONE.has(p.status)) { await this.manage(e, p, now); return; }
      await this.maybeEnter(e, leaseOk, now);
    } catch (err) {
      this.log(`step failed: ${(err as Error).message}`);
    } finally { this.busy = false; }
  }

  private async load(e: AscentEngine) {
    const rows = await this.d.store.forDate('NIFTY_ASCENT', e.date);
    this.attempted = rows.length > 0;
    this.pos = rows.find((r) => !DONE.has(r.status)) ?? rows[rows.length - 1] ?? null;
    this.loaded = true;
    if (this.pos?.status === 'OPENING') this.pos = await this.d.runner.recover(this.pos);
    if (this.pos?.status === 'OPEN' && !this.pos.stop) await this.protect(e, this.pos);
    if (this.pos && !DONE.has(this.pos.status)) this.log(`resumed live position ${this.pos.id} (${this.pos.status})`);
  }

  private async protect(e: AscentEngine, p: LivePosition) {
    const buf = Number(this.d.control()?.settings?.stopBufferPct ?? 5);
    this.pos = await this.d.runner.protect(p, p.entryPrice! * e.rules.fixedStopFactor * (1 - buf / 100));
  }

  private exitReason(e: AscentEngine, now: number): string | null {
    if (e.exitOrder) return `paper exit: ${e.exitOrder.reason}`;
    if (!e.position) return 'paper position closed';
    if (e.killed) return 'kill switch';
    if (minuteOf(now) >= TIME_GUARD_MIN) return 'time guard 15:20';
    return null;
  }

  private async manage(e: AscentEngine, p: LivePosition, now: number) {
    if (p.status === 'OPENING') { this.pos = await this.d.runner.recover(p); return; }
    // A close already started (e.g. owner FLATTEN LIVE) is always finished, even while paper stays open.
    const why = this.exitReason(e, now) ?? (p.status !== 'OPEN' ? (p.exitReason ?? 'finish close') : null);
    if (why && (p.status !== 'CLOSE_FAILED' || now - this.lastRetry >= 10_000)) {
      this.lastRetry = now;
      const token = e.instruments.find((i) => i.tradingsymbol === p.tradingsymbol)?.token;
      this.pos = await this.d.runner.close(p, why, async () => (token != null ? this.freshQuote(e, token, now) : null) ?? (await this.d.quote?.(p.tradingsymbol)) ?? null);
      return;
    }
    if (p.status === 'OPEN' && now - this.lastSync >= 10_000) { this.lastSync = now; this.pos = await this.d.runner.syncStop(p); }
  }

  private skip(why: string) { if (why !== this.lastSkip) this.log(`no live entry: ${why}`); this.lastSkip = why; }

  private async maybeEnter(e: AscentEngine, leaseOk: boolean, now: number) {
    if (this.attempted) return;
    const o = e.entryOrder, pos = e.position;
    if (!pos || !o || o.status !== 'FILLED' || !o.fill || e.exitOrder || e.killed) return;
    // A paper entry filled: decide once for the day.
    const ctl = this.d.control();
    if (!this.d.liveEnabled()) return this.skip('server switch LIVE_ORDERS is off');
    if (!ctl?.armed) return this.skip('live is not armed');
    if (!leaseOk) return this.skip('this server does not hold the single-engine lease');
    this.attempted = true;
    if (now - o.fill.at > MAX_CHASE_MS) { this.skip(`paper fill is ${Math.round((now - o.fill.at) / 1000)} s old — not chased`); return; }
    const inst = pos.instrument;
    const quote = this.freshQuote(e, inst.token, now) ?? (await this.d.quote?.(inst.tradingsymbol)) ?? null;
    if (!quote) { this.skip('no fresh quote for the contract'); return; }
    const maxPrice = budgetCap(pos.qty, e.exec.maxPremiumOutlay, e.exec.maxTheoreticalLoss);
    this.log(`paper entry filled (${pos.bot} ${inst.tradingsymbol} × ${pos.qty} @ ₹${pos.entryPremium}) — sending the LIVE entry`);
    this.pos = await this.d.runner.open({
      date: e.date, exchange: 'NFO', tradingsymbol: inst.tradingsymbol, lotSize: inst.lotSize, side: 'BUY', qty: pos.qty,
      quote, maxPrice, ref: { paperDate: e.date, bot: pos.bot, paperEntry: pos.entryPremium, configVersion: e.configVersion },
    });
    if (this.pos.status === 'OPEN') await this.protect(e, this.pos);
  }

  /** Owner FLATTEN LIVE: close the real position now (the paper engine is not touched). */
  async flatten(e: AscentEngine | null): Promise<string> {
    const p = this.pos;
    if (!p || DONE.has(p.status)) return 'no open live position';
    const token = e?.instruments.find((i) => i.tradingsymbol === p.tradingsymbol)?.token;
    while (this.busy) await new Promise((r) => setTimeout(r, 100));
    this.busy = true;
    try {
      this.pos = await this.d.runner.close(p, 'owner FLATTEN LIVE', async () => (e && token != null ? this.freshQuote(e, token, Date.now()) : null) ?? (await this.d.quote?.(p.tradingsymbol)) ?? null);
    } finally { this.busy = false; }
    return `live position ${this.pos!.status}`;
  }
}
