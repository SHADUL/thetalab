/**
 * LIVE ORDERS — the real-money order lifecycle of ONE position at Zerodha.
 * Shared by NIFTY ASCENT (live mirror of live paper) and Naked Sell (LIVE mode).
 *
 *   open     marketable LIMIT entry → wait for the fill (cancel on timeout; a
 *            partial fill keeps the filled quantity)
 *   protect  broker-side stop-loss (SL) order at Zerodha — the crash guard: it
 *            stays at the exchange even if this server stops
 *   close    cancel the broker stop FIRST and re-read it (a stop that already
 *            filled reduces what is left to close — never a double exit), then
 *            marketable LIMIT exits with a fresh quote, up to N attempts
 *   syncStop detect that the broker stop filled while we were not looking
 *
 * Every position is written to the store BEFORE its order is sent (with a
 * unique Kite order tag), so a crash between "sent" and "recorded" is
 * recovered by looking the tag up. Every broker request is audited.
 *
 * Off by default: the server's broker refuses to send anything unless the
 * owner has set LIVE_ORDERS=on, and each strategy must also be ARMED by the
 * owner in the UI. Tests use a fake broker only.
 */

export type Side = 'BUY' | 'SELL';
export type Exchange = 'NFO' | 'BFO';
export type Strategy = 'NIFTY_ASCENT' | 'NAKED_SELL';
export type OrderStatus = 'OPEN' | 'TRIGGER_PENDING' | 'COMPLETE' | 'CANCELLED' | 'REJECTED' | 'UNKNOWN';

export interface OrderRequest {
  exchange: Exchange; tradingsymbol: string; side: Side; qty: number;
  kind: 'LIMIT' | 'SL'; price: number; trigger?: number; tag: string;
  /** ENTRY opens risk; STOP / EXIT only protect or close an existing real position. */
  purpose: 'ENTRY' | 'STOP' | 'EXIT';
}
export interface OrderState { status: OrderStatus; filledQty: number; avgPrice: number | null; message?: string | null }
export interface Quote { bid: number | null; ask: number | null; ltp?: number | null }

export interface BrokerPort {
  place(r: OrderRequest): Promise<string>;
  cancel(orderId: string): Promise<void>;
  order(orderId: string): Promise<OrderState>;
  findByTag(tag: string): Promise<Array<OrderState & { orderId: string }>>;
  /** Signed intraday (MIS) net quantity at the broker; null when unknown. */
  netQty(exchange: Exchange, tradingsymbol: string): Promise<number | null>;
  /** Fresh quote by REST (fallback when the stream has none). */
  quote(exchange: Exchange, tradingsymbol: string): Promise<Quote | null>;
}

export interface OrderLeg {
  orderId: string | null; tag: string; side: Side; qty: number; kind: 'LIMIT' | 'SL';
  price: number; trigger: number | null; status: OrderStatus | 'NOT_SENT';
  filledQty: number; avgPrice: number | null; at: number; message?: string | null;
}

export type LiveStatus = 'OPENING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'ENTRY_FAILED' | 'CLOSE_FAILED';
export const DONE: ReadonlySet<LiveStatus> = new Set(['CLOSED', 'ENTRY_FAILED']);

export interface LivePosition {
  id: string; strategy: Strategy; date: string; exchange: Exchange; tradingsymbol: string; lotSize: number;
  entrySide: Side; requestedQty: number; qty: number; status: LiveStatus;
  entry: OrderLeg; entryPrice: number | null; entryAt: number | null;
  stop: OrderLeg | null; exits: OrderLeg[];
  exitPrice: number | null; exitAt: number | null; exitReason: string | null; closedBy: 'STRATEGY' | 'BROKER_STOP' | null;
  gross: number | null; charges: number | null; net: number | null;
  /** Link to the strategy's own record (paper date / naked_sell_positions id). */
  ref: Record<string, unknown>;
  log: Array<{ at: number; msg: string }>;
  createdAt: number; updatedAt: number;
}

export interface AuditRow { at: number; strategy: Strategy; positionId: string; action: string; request: unknown; result: unknown; ok: boolean }
export interface LiveStorePort {
  save(p: LivePosition): Promise<void>;
  get(id: string): Promise<LivePosition | null>;
  /** Not CLOSED / ENTRY_FAILED. */
  active(strategy: Strategy): Promise<LivePosition[]>;
  forDate(strategy: Strategy, date: string): Promise<LivePosition[]>;
  audit(row: AuditRow): Promise<void>;
}

export interface RunnerOptions {
  /** Entry limit = ask (buy) / bid (sell) ± this %. */
  entryProtectionPct: number;
  /** Exit limit ± this % on attempt 1, ×2 on attempt 2, ×3 … */
  exitProtectionPct: number;
  /** Broker stop: limit = trigger ± this % (SL-M is not allowed for index options). */
  stopLimitPct: number;
  fillTimeoutMs: number;
  exitAttempts: number;
  pollMs: number;
  /** Hard cap on lots in one order (belt and braces on top of the strategy limits). */
  maxLots: number;
}
export const DEFAULT_RUNNER: RunnerOptions = { entryProtectionPct: 2, exitProtectionPct: 3, stopLimitPct: 10, fillTimeoutMs: 10_000, exitAttempts: 3, pollMs: 1_000, maxLots: 10 };

export interface RunnerDeps {
  broker: BrokerPort;
  store: LiveStorePort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export const TICK = 0.05;
const r2 = (v: number) => Math.round(v * 100) / 100;
export const ceilTick = (v: number) => r2(Math.ceil(v / TICK - 1e-9) * TICK);
export const floorTick = (v: number) => r2(Math.max(TICK, Math.floor(v / TICK + 1e-9) * TICK));
const opposite = (s: Side): Side => (s === 'BUY' ? 'SELL' : 'BUY');
const TERMINAL = new Set<OrderStatus | 'NOT_SENT'>(['COMPLETE', 'CANCELLED', 'REJECTED', 'NOT_SENT']);

/** Marketable limit: buy above the ask, sell below the bid, on the 0.05 tick. */
export function marketable(side: Side, ref: number, pct: number): number {
  return side === 'BUY' ? ceilTick(ref * (1 + pct / 100)) : floorTick(ref * (1 - pct / 100));
}

/**
 * Zerodha F&O option charges for a round trip (estimate, not a contract note):
 * ₹20/order, STT 0.1% of the SELL premium, txn (NSE 0.03503% / BSE 0.0325%) both
 * sides, SEBI ₹10/crore, stamp 0.003% of the BUY side, GST 18% on brokerage+txn+SEBI.
 */
export function roundTripCharges(entrySide: Side, entry: number, exit: number, qty: number, exchange: Exchange): number {
  const buyT = (entrySide === 'BUY' ? entry : exit) * qty, sellT = (entrySide === 'BUY' ? exit : entry) * qty;
  const t = buyT + sellT, brokerage = 40;
  const txn = (exchange === 'BFO' ? 0.000325 : 0.0003503) * t, sebi = (t * 10) / 1e7;
  return r2(brokerage + 0.001 * sellT + txn + sebi + 0.00003 * buyT + 0.18 * (brokerage + txn + sebi));
}

export function newTag(strategy: Strategy, date: string, rnd: () => number = Math.random): string {
  // Kite tags: alphanumeric, ≤ 20 chars. NA/NS + yymmdd + 6 random.
  const r = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(rnd() * 32)]).join('');
  return `${strategy === 'NIFTY_ASCENT' ? 'NA' : 'NS'}${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}${r}`;
}

export class LiveOrderRunner {
  readonly strategy: Strategy;
  readonly opts: RunnerOptions;
  private readonly d: Required<RunnerDeps>;
  private readonly busy = new Set<string>();

  constructor(strategy: Strategy, deps: RunnerDeps, opts: Partial<RunnerOptions> = {}) {
    this.strategy = strategy;
    this.opts = { ...DEFAULT_RUNNER, ...opts };
    this.d = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: () => {}, ...deps } as Required<RunnerDeps>;
  }

  isBusy(id: string) { return this.busy.has(id); }

  private note(p: LivePosition, msg: string) {
    p.log.push({ at: this.d.now(), msg });
    if (p.log.length > 200) p.log.splice(0, p.log.length - 200);
    this.d.log(`[LIVE ${this.strategy}] ${p.tradingsymbol}: ${msg}`);
  }
  private async save(p: LivePosition) { p.updatedAt = this.d.now(); await this.d.store.save(JSON.parse(JSON.stringify(p))); }
  private async saveQuiet(p: LivePosition) { try { await this.save(p); } catch (e) { this.d.log(`[LIVE ${this.strategy}] RISK could not save ${p.id}: ${(e as Error).message}`); } }
  private async audit(p: LivePosition, action: string, request: unknown, result: unknown, ok: boolean) {
    try { await this.d.store.audit({ at: this.d.now(), strategy: this.strategy, positionId: p.id, action, request, result, ok }); } catch { /* audit is best-effort */ }
  }

  /** Send an order; on an ambiguous failure (e.g. timeout) look the tag up before giving up. */
  private async send(p: LivePosition, leg: OrderLeg, purpose: OrderRequest['purpose']): Promise<void> {
    const req: OrderRequest = { exchange: p.exchange, tradingsymbol: p.tradingsymbol, side: leg.side, qty: leg.qty, kind: leg.kind, price: leg.price, ...(leg.trigger != null ? { trigger: leg.trigger } : {}), tag: leg.tag, purpose };
    try {
      leg.orderId = await this.d.broker.place(req);
      leg.status = 'OPEN';
      await this.audit(p, `place ${leg.kind} ${leg.side}`, req, { orderId: leg.orderId }, true);
    } catch (e) {
      const msg = (e as Error).message;
      let found: (OrderState & { orderId: string }) | undefined;
      try { found = (await this.d.broker.findByTag(leg.tag))[0]; } catch { /* unknown */ }
      await this.audit(p, `place ${leg.kind} ${leg.side}`, req, { error: msg, foundByTag: found?.orderId ?? null }, false);
      if (found) { leg.orderId = found.orderId; leg.status = found.status; leg.filledQty = found.filledQty; leg.avgPrice = found.avgPrice; return; }
      leg.status = 'REJECTED'; leg.message = msg;
    }
  }

  private async read(leg: OrderLeg): Promise<void> {
    if (!leg.orderId) return;
    try {
      const s = await this.d.broker.order(leg.orderId);
      leg.status = s.status; leg.filledQty = s.filledQty; leg.avgPrice = s.avgPrice; leg.message = s.message ?? leg.message ?? null;
    } catch (e) { leg.message = `status read failed: ${(e as Error).message}`; }
  }

  /** Wait until the order is terminal or the timeout passes; then cancel and re-read if still open. */
  private async settle(p: LivePosition, leg: OrderLeg): Promise<void> {
    if (!leg.orderId || TERMINAL.has(leg.status)) return;
    const deadline = this.d.now() + this.opts.fillTimeoutMs;
    for (;;) {
      await this.read(leg);
      if (TERMINAL.has(leg.status)) return;
      if (this.d.now() >= deadline) break;
      await this.d.sleep(this.opts.pollMs);
    }
    await this.cancelLeg(p, leg);
  }

  private async cancelLeg(p: LivePosition, leg: OrderLeg): Promise<void> {
    if (!leg.orderId || TERMINAL.has(leg.status)) return;
    for (let i = 0; i < 3 && !TERMINAL.has(leg.status); i++) {
      try { await this.d.broker.cancel(leg.orderId); await this.audit(p, 'cancel', { orderId: leg.orderId }, { ok: true }, true); }
      catch (e) { await this.audit(p, 'cancel', { orderId: leg.orderId }, { error: (e as Error).message }, false); }
      await this.read(leg);
      if (!TERMINAL.has(leg.status)) await this.d.sleep(this.opts.pollMs);
    }
  }

  private leg(tag: string, side: Side, qty: number, kind: 'LIMIT' | 'SL', price: number, trigger: number | null): OrderLeg {
    return { orderId: null, tag, side, qty, kind, price, trigger, status: 'NOT_SENT', filledQty: 0, avgPrice: null, at: this.d.now() };
  }

  /**
   * Open a position with a marketable LIMIT order. `maxPrice` caps a BUY limit (budget);
   * if the cap is below the ask nothing is sent. Returns OPEN (filled qty) or ENTRY_FAILED.
   */
  async open(a: { date: string; exchange: Exchange; tradingsymbol: string; lotSize: number; side: Side; qty: number; quote: Quote; maxPrice?: number | null; ref?: Record<string, unknown>; tag?: string }): Promise<LivePosition> {
    const now = this.d.now();
    const tag = a.tag ?? newTag(this.strategy, a.date);
    const ref = a.side === 'BUY' ? a.quote.ask : a.quote.bid;
    const p: LivePosition = {
      id: tag, strategy: this.strategy, date: a.date, exchange: a.exchange, tradingsymbol: a.tradingsymbol, lotSize: a.lotSize,
      entrySide: a.side, requestedQty: a.qty, qty: 0, status: 'OPENING',
      entry: this.leg(tag, a.side, a.qty, 'LIMIT', 0, null), entryPrice: null, entryAt: null, stop: null, exits: [],
      exitPrice: null, exitAt: null, exitReason: null, closedBy: null, gross: null, charges: null, net: null,
      ref: a.ref ?? {}, log: [], createdAt: now, updatedAt: now,
    };
    const fail = async (why: string) => { p.status = 'ENTRY_FAILED'; this.note(p, `entry not placed: ${why}`); await this.saveQuiet(p); return p; };
    if (!(a.lotSize > 0) || !(a.qty > 0) || a.qty % a.lotSize !== 0) return fail(`quantity ${a.qty} is not a whole number of lots (lot ${a.lotSize})`);
    if (a.qty / a.lotSize > this.opts.maxLots) return fail(`${a.qty / a.lotSize} lots exceeds the hard cap of ${this.opts.maxLots}`);
    if (!(ref != null && ref > 0)) return fail(`no ${a.side === 'BUY' ? 'ask' : 'bid'} to price the order`);
    let price = marketable(a.side, ref, this.opts.entryProtectionPct);
    if (a.side === 'BUY' && a.maxPrice != null) {
      const cap = floorTick(a.maxPrice);
      if (cap < ref) return fail(`budget allows ₹${cap} a unit, below the ask ₹${ref}`);
      price = Math.min(price, cap);
    }
    p.entry.price = price;
    // Record BEFORE sending, so a crash after sending is recoverable by tag.
    try { await this.save(p); } catch (e) { p.status = 'ENTRY_FAILED'; this.note(p, `entry not placed: could not record it first (${(e as Error).message})`); return p; }
    this.note(p, `ENTRY ${a.side} ${a.qty} @ limit ₹${price} (ref ₹${ref})`);
    await this.send(p, p.entry, 'ENTRY');
    await this.settle(p, p.entry);
    return this.finishEntry(p);
  }

  private async finishEntry(p: LivePosition): Promise<LivePosition> {
    if (p.entry.filledQty > 0 && p.entry.avgPrice != null) {
      p.qty = p.entry.filledQty; p.entryPrice = p.entry.avgPrice; p.entryAt = this.d.now(); p.status = 'OPEN';
      this.note(p, `entry FILLED ${p.qty}${p.qty < p.requestedQty ? ` of ${p.requestedQty} (partial)` : ''} @ ₹${p.entryPrice}`);
    } else {
      p.status = 'ENTRY_FAILED';
      this.note(p, `entry not filled (${p.entry.status}${p.entry.message ? `: ${p.entry.message}` : ''})`);
    }
    await this.saveQuiet(p);
    return p;
  }

  /** Place the broker-side stop-loss (crash guard) for an OPEN position. */
  async protect(p: LivePosition, trigger: number): Promise<LivePosition> {
    if (p.status !== 'OPEN' || p.stop) return p;
    const side = opposite(p.entrySide);
    const trig = side === 'BUY' ? ceilTick(trigger) : floorTick(trigger);
    const limit = side === 'BUY' ? ceilTick(trig * (1 + this.opts.stopLimitPct / 100)) : floorTick(trig * (1 - this.opts.stopLimitPct / 100));
    p.stop = this.leg(`${p.id}S`, side, p.qty, 'SL', limit, trig);
    await this.send(p, p.stop, 'STOP');
    // Kite can accept an order and reject it a moment later (RMS / price band): read it back once.
    if (p.stop.orderId) { await this.d.sleep(Math.min(this.opts.pollMs, 500)); await this.read(p.stop); }
    if (p.stop.status === 'REJECTED' || p.stop.status === 'CANCELLED' || !p.stop.orderId) this.note(p, `RISK broker stop NOT placed (${p.stop.message ?? p.stop.status}) — the server still manages the exit`);
    else this.note(p, `broker stop placed: ${side} ${p.qty} trigger ₹${trig} limit ₹${limit}`);
    await this.saveQuiet(p);
    return p;
  }

  /** Has the broker stop filled at Zerodha (crash guard fired)? Closes the record if so. */
  async syncStop(p: LivePosition): Promise<LivePosition> {
    if (p.status !== 'OPEN' || !p.stop?.orderId || TERMINAL.has(p.stop.status) || this.busy.has(p.id)) return p;
    const before = JSON.stringify([p.stop.status, p.stop.filledQty]);
    await this.read(p.stop);
    if (p.stop.status === 'COMPLETE' && p.stop.filledQty >= p.qty) {
      p.exitReason = 'BROKER_STOP'; this.complete(p, 'broker stop-loss filled at Zerodha');
    }
    if (JSON.stringify([p.stop.status, p.stop.filledQty]) !== before) await this.saveQuiet(p);
    return p;
  }

  private filledOut(p: LivePosition) {
    return (p.stop?.filledQty ?? 0) + p.exits.reduce((a, x) => a + x.filledQty, 0);
  }

  private complete(p: LivePosition, how: string) {
    const fills = [p.stop, ...p.exits].filter((x): x is OrderLeg => !!x && x.filledQty > 0 && x.avgPrice != null);
    const q = fills.reduce((a, x) => a + x.filledQty, 0);
    p.exitPrice = r2(fills.reduce((a, x) => a + x.filledQty * x.avgPrice!, 0) / q);
    p.exitAt = this.d.now();
    p.closedBy = (p.stop?.filledQty ?? 0) >= p.qty ? 'BROKER_STOP' : 'STRATEGY';
    p.gross = r2((p.entrySide === 'BUY' ? p.exitPrice - p.entryPrice! : p.entryPrice! - p.exitPrice) * p.qty);
    p.charges = roundTripCharges(p.entrySide, p.entryPrice!, p.exitPrice, p.qty, p.exchange);
    p.net = r2(p.gross - p.charges);
    p.status = 'CLOSED';
    this.note(p, `CLOSED ${p.qty} @ ₹${p.exitPrice} (${how}) · gross ₹${p.gross} · charges ₹${p.charges} · net ₹${p.net}`);
  }

  /**
   * Close the position. Cancels the broker stop first and re-reads it; whatever the stop
   * (or an earlier exit attempt) already filled is not closed again. Then marketable LIMIT
   * exits with a fresh quote. Returns CLOSED, or CLOSE_FAILED (the caller retries later).
   */
  async close(p: LivePosition, reason: string, getQuote: () => Promise<Quote | null> | Quote | null): Promise<LivePosition> {
    if (this.busy.has(p.id)) return p;
    if (p.status !== 'OPEN' && p.status !== 'CLOSING' && p.status !== 'CLOSE_FAILED') return p;
    this.busy.add(p.id);
    try {
      p.status = 'CLOSING'; p.exitReason ??= reason;
      this.note(p, `CLOSE requested: ${reason}`);
      await this.saveQuiet(p);
      // 1. Broker stop: cancel and confirm. A stop we cannot confirm cancelled blocks the exit (no double exit).
      if (p.stop?.orderId && !TERMINAL.has(p.stop.status)) {
        await this.cancelLeg(p, p.stop);
        if (!TERMINAL.has(p.stop.status)) { p.status = 'CLOSE_FAILED'; this.note(p, `RISK broker stop ${p.stop.orderId} could not be confirmed cancelled (${p.stop.status}) — exit deferred, will retry`); await this.saveQuiet(p); return p; }
      }
      // 2. Earlier exit attempts still working (e.g. after a restart): cancel and confirm.
      for (const x of p.exits) {
        if (x.orderId && !TERMINAL.has(x.status)) {
          await this.cancelLeg(p, x);
          if (!TERMINAL.has(x.status)) { p.status = 'CLOSE_FAILED'; this.note(p, `RISK exit order ${x.orderId} could not be confirmed cancelled — will retry`); await this.saveQuiet(p); return p; }
        }
      }
      const side = opposite(p.entrySide);
      for (let attempt = 1; attempt <= this.opts.exitAttempts; attempt++) {
        const left = p.qty - this.filledOut(p);
        if (left <= 0) break;
        let q: Quote | null = null;
        try { q = await getQuote(); } catch { q = null; }
        if (!q || !((side === 'BUY' ? q.ask : q.bid)! > 0)) { try { q = await this.d.broker.quote(p.exchange, p.tradingsymbol); } catch { q = null; } }
        const ref = q ? (side === 'BUY' ? q.ask : q.bid) ?? q.ltp ?? null : null;
        if (!(ref != null && ref > 0)) { this.note(p, `exit attempt ${attempt}: no quote to price the order`); await this.d.sleep(this.opts.pollMs); continue; }
        const price = marketable(side, ref, this.opts.exitProtectionPct * attempt);
        const leg = this.leg(`${p.id}X${p.exits.length + 1}`, side, left, 'LIMIT', price, null);
        p.exits.push(leg);
        this.note(p, `EXIT attempt ${attempt}: ${side} ${left} @ limit ₹${price} (ref ₹${ref})`);
        await this.saveQuiet(p);
        await this.send(p, leg, 'EXIT');
        await this.settle(p, leg);
        await this.saveQuiet(p);
      }
      if (p.qty - this.filledOut(p) <= 0) this.complete(p, reason);
      else { p.status = 'CLOSE_FAILED'; this.note(p, `RISK exit incomplete: ${p.qty - this.filledOut(p)} still open at the broker — will retry; check Zerodha`); }
      await this.saveQuiet(p);
      return p;
    } finally { this.busy.delete(p.id); }
  }

  /**
   * After a restart: an OPENING record is resolved from the broker (by order id or tag).
   * A still-working entry order is cancelled (the moment has passed); any filled quantity is kept.
   */
  async recover(p: LivePosition): Promise<LivePosition> {
    if (p.status !== 'OPENING') return p;
    if (!p.entry.orderId) {
      try {
        const f = (await this.d.broker.findByTag(p.entry.tag))[0];
        if (f) { p.entry.orderId = f.orderId; p.entry.status = f.status; p.entry.filledQty = f.filledQty; p.entry.avgPrice = f.avgPrice; }
        else { p.entry.status = 'NOT_SENT'; }
      } catch (e) { this.note(p, `recovery lookup failed (${(e as Error).message}) — will retry`); return p; }
    }
    await this.read(p.entry);
    await this.cancelLeg(p, p.entry);
    this.note(p, 'recovered after restart');
    return this.finishEntry(p);
  }
}

/** Expected broker net per contract from our open records (+ long / − short). */
export function expectedNet(positions: LivePosition[]): Map<string, { exchange: Exchange; tradingsymbol: string; qty: number }> {
  const m = new Map<string, { exchange: Exchange; tradingsymbol: string; qty: number }>();
  for (const p of positions) {
    if (DONE.has(p.status) || p.status === 'OPENING') continue;
    const out = (p.stop?.filledQty ?? 0) + p.exits.reduce((a, x) => a + x.filledQty, 0);
    const open = Math.max(0, p.qty - out) * (p.entrySide === 'BUY' ? 1 : -1);
    const k = `${p.exchange}:${p.tradingsymbol}`;
    const cur = m.get(k) ?? { exchange: p.exchange, tradingsymbol: p.tradingsymbol, qty: 0 };
    cur.qty += open; m.set(k, cur);
  }
  return m;
}
