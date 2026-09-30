/**
 * KiteAlphaLadderDepthSource — the real AlphaLadderDepthSource
 * implementation for Kite's WebSocket ticker. The WebSocket itself is
 * injected (a `WebSocketLike` factory), so this class is fully unit
 * testable against a fake socket without ever opening a real connection —
 * per your instruction, "test it with mocks/fixtures where possible."
 *
 * HONEST LIMITATION (see kiteTickerProtocol.ts's own header): the binary
 * parsing this depends on has not been exercised against a real captured
 * Kite packet. This class's OWN logic (connect/subscribe/reconnect/health/
 * normalization) is tested here against a fake socket that emits
 * hand-built frames; the wire format itself is a separate, disclosed risk.
 */
import { parseFrame, buildSubscribeMessage, buildSetModeFullMessage, type FullModeTick } from './kiteTickerProtocol.ts';
import type { AlphaLadderDepthSource, DepthSourceHealth, NormalizedDepthTick, ResolvedInstrument, WorkerHealthStatus } from './depthSource.ts';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', handler: (...args: any[]) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface KiteDepthSourceConfig {
  apiKey: string;
  accessToken: string;
  wsFactory: WebSocketFactory;
  /** Injectable clock, defaults to Date.now — makes health timestamps testable. */
  now?: () => number;
  wsUrl?: string; // override for tests; defaults to Kite's real endpoint
}

function tickToNormalizedTicks(tick: FullModeTick, receivedAtMs: number): NormalizedDepthTick[] {
  const out: NormalizedDepthTick[] = [];
  const exchangeMs = tick.exchangeTimestampEpochSec > 0 ? tick.exchangeTimestampEpochSec * 1000 : null;
  tick.bidDepth.forEach((level, i) => {
    if (level.quantity === 0 && level.price === 0) return; // an empty depth slot, not a real level
    out.push({
      timestampExchangeMs: exchangeMs,
      timestampReceivedMs: receivedAtMs,
      instrumentToken: tick.instrumentToken,
      side: 'b',
      price: level.price,
      quantity: level.quantity,
      orderCount: level.orders,
      levelIndex: i,
    });
  });
  tick.askDepth.forEach((level, i) => {
    if (level.quantity === 0 && level.price === 0) return;
    out.push({
      timestampExchangeMs: exchangeMs,
      timestampReceivedMs: receivedAtMs,
      instrumentToken: tick.instrumentToken,
      side: 'a',
      price: level.price,
      quantity: level.quantity,
      orderCount: level.orders,
      levelIndex: i,
    });
  });
  return out;
}

export class KiteAlphaLadderDepthSource implements AlphaLadderDepthSource {
  private socket: WebSocketLike | null = null;
  private handlers: Array<(ticks: NormalizedDepthTick[]) => void> = [];
  private status: WorkerHealthStatus = 'STARTING';
  private connectionGeneration = 0;
  private reconnectCount = 0;
  private lastSocketMessageAtMs: number | null = null;
  private subscribedToken: number | null = null;
  private isOpen = false;
  private readonly now: () => number;
  private readonly config: KiteDepthSourceConfig;

  constructor(config: KiteDepthSourceConfig) {
    this.config = config;
    this.now = config.now ?? Date.now;
  }

  async connect(): Promise<void> {
    this.status = 'CONNECTING';
    this.connectionGeneration += 1;
    const url = this.config.wsUrl ?? `wss://ws.kite.trade?api_key=${this.config.apiKey}&access_token=${this.config.accessToken}`;
    const socket = this.config.wsFactory(url);
    this.socket = socket;

    socket.on('open', () => {
      this.isOpen = true;
      this.status = 'WARMING_UP';
      if (this.subscribedToken !== null) this.sendSubscription(this.subscribedToken);
    });
    socket.on('message', (data: Buffer) => {
      this.lastSocketMessageAtMs = this.now();
      if (this.status === 'WARMING_UP') this.status = 'HEALTHY';
      if (!(data instanceof Buffer) || data.length < 2) return; // text control frames (e.g. order postbacks) are not depth frames
      const ticks = parseFrame(data);
      if (ticks.length === 0) return;
      const receivedAtMs = this.lastSocketMessageAtMs;
      const normalized = ticks.flatMap((t) => tickToNormalizedTicks(t, receivedAtMs));
      for (const handler of this.handlers) handler(normalized);
    });
    socket.on('close', () => {
      this.isOpen = false;
      this.status = 'RECONNECTING';
      this.reconnectCount += 1;
    });
    socket.on('error', () => {
      this.status = 'FAILED';
    });
  }

  async disconnect(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    this.isOpen = false;
    this.status = 'STARTING';
  }

  async subscribe(instrument: ResolvedInstrument): Promise<void> {
    this.subscribedToken = instrument.instrumentToken;
    // Only send immediately if the socket is ALREADY open — otherwise the
    // 'open' handler above sends it exactly once, when the connection is
    // actually ready. Sending from both places would double-send on the
    // realistic connect() -> subscribe() -> (later) open ordering.
    if (this.isOpen) this.sendSubscription(instrument.instrumentToken);
  }

  private sendSubscription(token: number): void {
    this.socket?.send(buildSubscribeMessage([token]));
    this.socket?.send(buildSetModeFullMessage([token]));
  }

  getHealth(): DepthSourceHealth {
    return {
      status: this.status,
      connectionGeneration: this.connectionGeneration,
      lastSocketMessageAtMs: this.lastSocketMessageAtMs,
      reconnectCount: this.reconnectCount,
    };
  }

  onDepthSnapshot(handler: (ticks: NormalizedDepthTick[]) => void): void {
    this.handlers.push(handler);
  }
}
