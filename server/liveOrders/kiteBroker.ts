/**
 * LIVE ORDERS — Zerodha Kite Connect implementation of BrokerPort.
 *
 * REAL MONEY. Refuses to open a position (ENTRY) unless the server runs with
 * LIVE_ORDERS=on (checked on every order). Stop and exit orders for a real
 * position that already exists are always allowed, so turning the switch off
 * can never strand an open position. Intraday product (MIS) only, LIMIT
 * and SL (stop-loss limit) orders only. Credentials are read per call from the
 * existing kite_session row and are never logged or returned.
 */
import type { BrokerPort, Exchange, OrderRequest, OrderState, OrderStatus, Quote } from '../../src/live-orders/runner.ts';

const KITE = 'https://api.kite.trade';

export const liveOrdersOn = () => process.env.LIVE_ORDERS === 'on';

function mapStatus(s: string | undefined): OrderStatus {
  switch (s) {
    case 'COMPLETE': return 'COMPLETE';
    case 'CANCELLED': return 'CANCELLED';
    case 'REJECTED': return 'REJECTED';
    case 'TRIGGER PENDING': return 'TRIGGER_PENDING';
    case undefined: case null: case '': return 'UNKNOWN';
    default: return 'OPEN'; // OPEN, OPEN PENDING, VALIDATION PENDING, PUT ORDER REQ RECEIVED, MODIFY/CANCEL PENDING …
  }
}
function stateOf(o: any): OrderState {
  const avg = Number(o?.average_price);
  return { status: mapStatus(o?.status), filledQty: Number(o?.filled_quantity) || 0, avgPrice: avg > 0 ? avg : null, message: o?.status_message ?? null };
}

export class KiteBroker implements BrokerPort {
  private readonly apiKey: string;
  private readonly token: () => Promise<string | null>;
  constructor(apiKey: string, token: () => Promise<string | null>) { this.apiKey = apiKey; this.token = token; }

  private async call(method: string, path: string, form?: Record<string, string | number>): Promise<any> {
    const t = await this.token();
    if (!t) throw new Error('no Kite session (log in to Kite)');
    const resp = await fetch(`${KITE}${path}`, {
      method,
      headers: { 'X-Kite-Version': '3', Authorization: `token ${this.apiKey}:${t}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await resp.json().catch(() => null);
    if (!resp.ok || json?.status === 'error') throw new Error(`Kite ${resp.status}${json?.error_type ? ` ${json.error_type}` : ''}: ${String(json?.message ?? 'request failed').slice(0, 200)}`);
    return json?.data;
  }

  async place(r: OrderRequest): Promise<string> {
    if (r.purpose === 'ENTRY' && !liveOrdersOn()) throw new Error('LIVE_ORDERS is not on — no real entry sent');
    if (!(r.qty > 0) || !Number.isInteger(r.qty)) throw new Error('bad quantity');
    const form: Record<string, string | number> = {
      tradingsymbol: r.tradingsymbol, exchange: r.exchange, transaction_type: r.side, quantity: r.qty,
      product: 'MIS', order_type: r.kind, price: r.price.toFixed(2), validity: 'DAY', tag: r.tag,
    };
    if (r.kind === 'SL') { if (!(r.trigger! > 0)) throw new Error('SL order needs a trigger'); form.trigger_price = r.trigger!.toFixed(2); }
    const d = await this.call('POST', '/orders/regular', form);
    if (!d?.order_id) throw new Error('Kite returned no order id');
    return String(d.order_id);
  }
  async cancel(orderId: string): Promise<void> { await this.call('DELETE', `/orders/regular/${encodeURIComponent(orderId)}`); }
  async order(orderId: string): Promise<OrderState> {
    const h = await this.call('GET', `/orders/${encodeURIComponent(orderId)}`);
    return stateOf(Array.isArray(h) ? h[h.length - 1] : h);
  }
  async findByTag(tag: string) {
    const all = await this.call('GET', '/orders');
    return (Array.isArray(all) ? all : []).filter((o: any) => o?.tag === tag || (Array.isArray(o?.tags) && o.tags.includes(tag))).map((o: any) => ({ orderId: String(o.order_id), ...stateOf(o) }));
  }
  async netQty(exchange: Exchange, tradingsymbol: string): Promise<number | null> {
    const d = await this.call('GET', '/portfolio/positions');
    return (d?.net ?? []).filter((p: any) => p.exchange === exchange && p.tradingsymbol === tradingsymbol && p.product === 'MIS').reduce((a: number, p: any) => a + Number(p.quantity || 0), 0);
  }
  async quote(exchange: Exchange, tradingsymbol: string): Promise<Quote | null> {
    const k = `${exchange}:${tradingsymbol}`;
    const d = await this.call('GET', `/quote?i=${encodeURIComponent(k)}`);
    const q = d?.[k];
    if (!q) return null;
    const b = Number(q?.depth?.buy?.[0]?.price), a = Number(q?.depth?.sell?.[0]?.price), l = Number(q?.last_price);
    return { bid: b > 0 ? b : null, ask: a > 0 ? a : null, ltp: l > 0 ? l : null };
  }
  /** Cash available for intraday use (equity segment net). */
  async availableCash(): Promise<number | null> {
    const d = await this.call('GET', '/user/margins/equity');
    const n = Number(d?.net);
    return Number.isFinite(n) ? n : null;
  }
  /** Kite's margin calculator for one MIS order. */
  async orderMargin(r: { exchange: Exchange; tradingsymbol: string; side: 'BUY' | 'SELL'; qty: number; price: number }): Promise<number | null> {
    const t = await this.token();
    if (!t) return null;
    const resp = await fetch(`${KITE}/margins/orders`, {
      method: 'POST',
      headers: { 'X-Kite-Version': '3', Authorization: `token ${this.apiKey}:${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ exchange: r.exchange, tradingsymbol: r.tradingsymbol, transaction_type: r.side, variety: 'regular', product: 'MIS', order_type: 'LIMIT', quantity: r.qty, price: r.price }]),
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await resp.json().catch(() => null);
    const n = Number(j?.data?.[0]?.total);
    return resp.ok && n > 0 ? n : null;
  }
}
