/**
 * Live Kite prices for trading — one WebSocket connection shared by the
 * whole web process. Prices are kept in memory only (no history).
 *
 * Callers register interest in instrument tokens with `want(tokens)`; the
 * stream subscribes to them in Kite "full" mode (LTP + 5-level depth, so
 * bid/ask are exact) and drops a token ~2 minutes after the last `want`.
 * It connects only on trading days 09:00–15:45 IST and only while
 * something is wanted; it reconnects on drop and when the daily Kite
 * access token changes.
 *
 * Kite pushes a tick whenever a price changes and a heartbeat every second
 * otherwise, so while the socket is healthy the last tick received for a
 * token IS its current price, however old — quiet contracts are not stale.
 * `get()` therefore only accepts ticks received on the CURRENT, healthy
 * connection.
 *
 * Kite allows 3 WebSocket connections per API key; the Alpha Ladder worker
 * uses one, this uses one.
 */
import WebSocket from 'ws';
import { parseFullModePacket, splitPackets } from '../src/nifty-alpha-ladder/live/kiteTickerProtocol.ts';

export interface LiveQuote {
  token: number;
  ltp: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  oi: number | null;
  /** 5-level market depth (full-mode F&O packets only), same shape as Kite REST quote depth. */
  depth: { buy: Array<{ price: number; quantity: number; orders: number }>; sell: Array<{ price: number; quantity: number; orders: number }> } | null;
  receivedAt: number;
}

/** Kite REST /quote-shaped object from a live tick, so REST-based code can consume stream prices unchanged. */
export function toRestQuote(q: LiveQuote): { last_price: number; volume?: number; oi?: number; depth?: LiveQuote['depth'] } {
  return {
    last_price: q.ltp,
    ...(q.volume != null ? { volume: q.volume } : {}),
    ...(q.oi != null ? { oi: q.oi } : {}),
    ...(q.depth ? { depth: q.depth } : {}),
  };
}

/** Decodes one packet of any length Kite sends (LTP 8, index quote 28, index full 32, F&O quote 44, F&O full 184). */
export function decodePacket(p: Buffer, receivedAt: number): LiveQuote | null {
  if (p.length < 8) return null;
  const token = p.readUInt32BE(0);
  const ltp = p.readInt32BE(4) / 100;
  if (p.length === 184) {
    const t = parseFullModePacket(p);
    const bid = t.bidDepth.find((d) => d.price > 0 && d.quantity > 0)?.price ?? null;
    const ask = t.askDepth.find((d) => d.price > 0 && d.quantity > 0)?.price ?? null;
    return { token, ltp: t.lastPrice, bid, ask, volume: t.volume, oi: t.oi, depth: { buy: t.bidDepth, sell: t.askDepth }, receivedAt };
  }
  if (p.length === 44) return { token, ltp, bid: null, ask: null, volume: p.readInt32BE(16), oi: null, depth: null, receivedAt };
  // 8 (LTP) / 28, 32 (index): last price only.
  return { token, ltp, bid: null, ask: null, volume: null, oi: null, depth: null, receivedAt };
}

export function decodeFrame(frame: Buffer, receivedAt: number): LiveQuote[] {
  if (frame.length < 2) return []; // 1-byte heartbeat
  return splitPackets(frame).map((p) => decodePacket(p, receivedAt)).filter((q): q is LiveQuote => q !== null && q.ltp > 0);
}

type Creds = { apiKey: string; accessToken: string };

const SUPERVISE_MS = 3_000;
const INTEREST_TTL_MS = 120_000;
const SILENCE_LIMIT_MS = 10_000; // Kite heartbeats every ~1 s
const OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 45;

class MarketStream {
  private quotes = new Map<number, LiveQuote>();
  private interest = new Map<number, number>(); // token -> expiresAt
  private subscribed = new Set<number>();
  private ws: WebSocket | null = null;
  private wsToken: string | null = null;
  private openedAt = 0;
  private lastMessageAt = 0;
  private reconnects = 0;
  private lastError: string | null = null;
  private creds: Creds | null = null;
  private credsAt = 0;
  private started = false;

  /** Register interest; new tokens are subscribed on the next supervisor pass (≤3 s) or immediately if open. */
  want(tokens: number[], ttlMs = INTEREST_TTL_MS): void {
    const exp = Date.now() + ttlMs;
    const fresh: number[] = [];
    for (const t of tokens) {
      if (!(t > 0)) continue;
      if (!this.interest.has(t)) fresh.push(t);
      this.interest.set(t, exp);
    }
    if (fresh.length && this.isHealthy()) this.subscribe(fresh);
  }

  /** Current price for a token, or null if the stream can't vouch for it right now. */
  get(token: number): LiveQuote | null {
    if (!this.isHealthy()) return null;
    const q = this.quotes.get(token);
    return q && q.receivedAt >= this.openedAt ? q : null;
  }

  isHealthy(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < SILENCE_LIMIT_MS;
  }

  status() {
    return {
      connected: this.isHealthy(),
      subscribed: this.subscribed.size,
      wanted: this.interest.size,
      lastMessageAgoMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  start(loadCreds: () => Promise<Creds | null>): void {
    if (this.started || process.env.MARKET_STREAM === 'off') return;
    this.started = true;
    setInterval(() => { this.supervise(loadCreds).catch((e) => { this.lastError = String(e?.message ?? e); }); }, SUPERVISE_MS).unref();
  }

  private async supervise(loadCreds: () => Promise<Creds | null>) {
    const now = Date.now();
    for (const [t, exp] of this.interest) if (exp < now) this.interest.delete(t);

    const ist = new Date(now + 330 * 60_000);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const weekday = ist.getUTCDay() >= 1 && ist.getUTCDay() <= 5;
    const shouldRun = weekday && minute >= OPEN_MIN && minute <= CLOSE_MIN && this.interest.size > 0;
    if (!shouldRun) { this.close('idle'); return; }

    if (!this.creds || now - this.credsAt > 60_000) { this.creds = await loadCreds(); this.credsAt = now; }
    if (!this.creds) { this.close('no kite session'); return; }

    if (this.ws && this.wsToken !== this.creds.accessToken) this.close('access token changed');
    if (this.ws && this.ws.readyState === WebSocket.OPEN && now - this.lastMessageAt > SILENCE_LIMIT_MS) this.close('silent socket');
    if (!this.ws) { this.connect(this.creds); return; }

    if (this.ws.readyState === WebSocket.OPEN) {
      const add = [...this.interest.keys()].filter((t) => !this.subscribed.has(t));
      const drop = [...this.subscribed].filter((t) => !this.interest.has(t));
      if (add.length) this.subscribe(add);
      if (drop.length) {
        this.ws.send(JSON.stringify({ a: 'unsubscribe', v: drop }));
        for (const t of drop) { this.subscribed.delete(t); this.quotes.delete(t); }
      }
    }
  }

  private connect(c: Creds) {
    const ws = new WebSocket(`wss://ws.kite.trade?api_key=${encodeURIComponent(c.apiKey)}&access_token=${encodeURIComponent(c.accessToken)}`);
    this.ws = ws;
    this.wsToken = c.accessToken;
    this.subscribed.clear();
    ws.on('open', () => {
      this.openedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.reconnects++;
      this.lastError = null;
      this.subscribe([...this.interest.keys()]);
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const at = Date.now();
      this.lastMessageAt = at;
      if (!isBinary) {
        try { const m = JSON.parse(data.toString()); if (m?.type === 'error') this.lastError = String(m.data); } catch { /* ignore */ }
        return;
      }
      for (const q of decodeFrame(data, at)) this.quotes.set(q.token, q);
    });
    ws.on('error', (e: Error) => { this.lastError = e.message; });
    ws.on('close', (code: number) => {
      if (this.ws === ws) { this.ws = null; this.subscribed.clear(); }
      if (code !== 1000) this.lastError = this.lastError ?? `closed (${code})`;
    });
  }

  private subscribe(tokens: number[]) {
    if (!tokens.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ a: 'subscribe', v: tokens }));
    this.ws.send(JSON.stringify({ a: 'mode', v: ['full', tokens] }));
    for (const t of tokens) this.subscribed.add(t);
  }

  private close(reason: string) {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    this.subscribed.clear();
    this.quotes.clear();
    if (reason !== 'idle') this.lastError = reason;
    try { ws.close(1000); } catch { /* ignore */ }
    setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 2_000).unref();
  }
}

export const marketStream = new MarketStream();
