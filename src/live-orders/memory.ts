/**
 * In-memory store and a FAKE broker for tests. The fake broker never talks to
 * any network; tests script how each order behaves.
 */
import type { AuditRow, BrokerPort, Exchange, LivePosition, LiveStorePort, OrderRequest, OrderState, Quote, Strategy } from './runner.ts';
import { DONE } from './runner.ts';

export class MemoryLiveStore implements LiveStorePort {
  rows = new Map<string, LivePosition>();
  audits: AuditRow[] = [];
  fail = false;
  async save(p: LivePosition) { if (this.fail) throw new Error('simulated database failure'); this.rows.set(p.id, JSON.parse(JSON.stringify(p))); }
  async get(id: string) { const p = this.rows.get(id); return p ? JSON.parse(JSON.stringify(p)) : null; }
  async active(s: Strategy) { return [...this.rows.values()].filter((p) => p.strategy === s && !DONE.has(p.status)).map((p) => JSON.parse(JSON.stringify(p))); }
  async forDate(s: Strategy, d: string) { return [...this.rows.values()].filter((p) => p.strategy === s && p.date === d).sort((a, b) => a.createdAt - b.createdAt).map((p) => JSON.parse(JSON.stringify(p))); }
  async audit(r: AuditRow) { this.audits.push(r); }
}

/** How the fake exchange treats an order: fill fully at `price`, fill part, stay open, or reject. */
export type FakeBehaviour = { fill: 'full' | 'partial' | 'none' | 'reject'; price?: number; partialQty?: number; throwOnPlace?: boolean; acceptedDespiteThrow?: boolean };

export interface FakeOrder extends OrderRequest { orderId: string; state: OrderState; cancelled: boolean }

export class FakeBroker implements BrokerPort {
  orders: FakeOrder[] = [];
  /** Behaviour for the next placed orders (consumed in order); default fills fully at the limit. */
  next: FakeBehaviour[] = [];
  quotes = new Map<string, Quote>();
  net = new Map<string, number>();
  cancelFails = 0;
  private seq = 0;

  async place(r: OrderRequest): Promise<string> {
    const b = this.next.shift() ?? { fill: 'full' };
    const orderId = `F${++this.seq}`;
    const px = b.price ?? r.price;
    const state: OrderState =
      b.fill === 'reject' ? { status: 'REJECTED', filledQty: 0, avgPrice: null, message: 'RMS: simulated rejection' }
      : b.fill === 'full' && r.kind === 'LIMIT' ? { status: 'COMPLETE', filledQty: r.qty, avgPrice: px }
      : b.fill === 'partial' ? { status: 'OPEN', filledQty: b.partialQty ?? 0, avgPrice: b.partialQty ? px : null }
      : { status: r.kind === 'SL' ? 'TRIGGER_PENDING' : 'OPEN', filledQty: 0, avgPrice: null };
    const o: FakeOrder = { ...r, orderId, state, cancelled: false };
    if (b.throwOnPlace) { if (b.acceptedDespiteThrow) this.orders.push(o); throw new Error('network timeout'); }
    this.orders.push(o);
    if (state.filledQty) this.book(r.exchange, r.tradingsymbol, r.side, state.filledQty);
    return orderId;
  }
  private book(ex: Exchange, sym: string, side: 'BUY' | 'SELL', qty: number) { const k = `${ex}:${sym}`; this.net.set(k, (this.net.get(k) ?? 0) + (side === 'BUY' ? qty : -qty)); }
  /** Simulate the exchange filling a working order (e.g. the broker stop triggering). */
  fillNow(orderId: string, price: number, qty?: number) {
    const o = this.orders.find((x) => x.orderId === orderId)!;
    const add = (qty ?? o.qty) - o.state.filledQty;
    o.state = { status: (qty ?? o.qty) >= o.qty ? 'COMPLETE' : 'OPEN', filledQty: qty ?? o.qty, avgPrice: price };
    this.book(o.exchange, o.tradingsymbol, o.side, add);
  }
  async cancel(orderId: string) {
    if (this.cancelFails > 0) { this.cancelFails--; throw new Error('simulated cancel failure'); }
    const o = this.orders.find((x) => x.orderId === orderId);
    if (!o) throw new Error('no such order');
    if (o.state.status === 'COMPLETE' || o.state.status === 'REJECTED' || o.state.status === 'CANCELLED') throw new Error(`order is ${o.state.status}`);
    o.cancelled = true; o.state = { ...o.state, status: 'CANCELLED' };
  }
  async order(orderId: string) { const o = this.orders.find((x) => x.orderId === orderId); if (!o) throw new Error('no such order'); return { ...o.state }; }
  async findByTag(tag: string) { return this.orders.filter((o) => o.tag === tag).map((o) => ({ orderId: o.orderId, ...o.state })); }
  async netQty(ex: Exchange, sym: string) { return this.net.get(`${ex}:${sym}`) ?? 0; }
  async quote(ex: Exchange, sym: string) { return this.quotes.get(`${ex}:${sym}`) ?? null; }
}
