/** Test doubles for the hedged131 engine: in-memory store, scripted market, scripted broker. */
import type { EdgeBroker, EdgeLeg, EdgeMarket, EdgePosition, EdgeSettings, EdgeStore, NewPosition } from '../engine.ts';
import type { SharedSignal, VixBar } from '../decision.ts';
import type { Quote, EdgeMode, PositionStatus } from '../lifecycle.ts';
import type { LiveOrderPlacer } from '../../quant/execution/liveFill.ts';

/** Epoch ms for an IST wall-clock time. */
export const IST = (date: string, h: number, m: number, s = 0) => {
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, h, m, s) - 330 * 60_000;
};

export const SIGNAL_DATE = '2026-10-14'; // Wednesday
export const EXPIRY = '2026-10-20'; // the following Tuesday

export function makeSignal(over: Partial<SharedSignal> = {}): SharedSignal {
  return {
    id: 7, weekKey: SIGNAL_DATE, signalDate: SIGNAL_DATE, signalInstantMs: IST(SIGNAL_DATE, 10, 12), path: 'crossing',
    d1: 1, d2: -1, alpha: 0, baseDirection: 1, g2AtSignal: -9.13, area1: 7_707_000, area2: -20_000, g1AtSignal: 3426.67,
    createdAtMs: IST(SIGNAL_DATE, 10, 13), ...over,
  };
}

export const WORKED_VIX: VixBar[] = [
  { startMs: IST(SIGNAL_DATE, 9, 15), close: 12.31 }, { startMs: IST(SIGNAL_DATE, 9, 30), close: 12.08 },
  { startMs: IST(SIGNAL_DATE, 9, 45), close: 11.94 }, { startMs: IST(SIGNAL_DATE, 10, 0), close: 11.87 },
];

export function defaultSettings(over: Partial<EdgeSettings> = {}): EdgeSettings {
  return { shadowEnabled: true, autoEnabled: false, killSwitch: false, shadowCapital: 300_000, autoCapital: 0, activeBroker: 'KITE', unitBudget: 125_000, ...over };
}

export class MemoryStore implements EdgeStore {
  positions: EdgePosition[] = [];
  events: Array<{ level: string; mode: string | null; positionId: number | null; kind: string; message: string }> = [];
  private nextId = 1;
  private nextLegId = 100;
  settings: EdgeSettings;
  signal: SharedSignal | null;
  constructor(settings: EdgeSettings, signal: SharedSignal | null) { this.settings = settings; this.signal = signal; }
  async getSettings() { return this.settings; }
  async getSignalForDate(d: string) { return this.signal && this.signal.signalDate === d ? this.signal : null; }
  async listOpenPositions() { return this.positions.filter((p) => p.status === 'ACTIVE' || p.status === 'EXITING').map((p) => structuredClone(p)); }
  async getPositionForWeek(w: string, m: EdgeMode) { const p = this.positions.find((x) => x.weekKey === w && x.mode === m); return p ? structuredClone(p) : null; }
  async getPosition(id: number) { const p = this.positions.find((x) => x.id === id); return p ? structuredClone(p) : null; }
  async createPosition(n: NewPosition) {
    if (this.positions.some((p) => p.weekKey === n.weekKey && p.mode === n.mode)) return { ok: false as const, reason: 'duplicate' as const };
    const legs: EdgeLeg[] = n.legs.map((l) => ({ ...l, id: this.nextLegId++ }));
    const pos: EdgePosition & Record<string, unknown> = {
      id: this.nextId++, mode: n.mode, weekKey: n.weekKey, signalId: n.signalId, direction: n.decision.direction, structure: n.structure,
      expiry: n.expiry, atm: n.atm, quantity: n.quantity, creditPoints: n.creditPoints, f0: n.f0, futureSymbol: n.futureSymbol,
      status: n.status, exitReason: n.exitReason, exitAttempts: 0, broker: n.broker, legs,
      maxGain: n.maxGain, maxLoss: n.maxLoss, breakeven: n.breakeven, units: n.units,
    };
    this.positions.push(pos);
    return { ok: true as const, position: structuredClone(pos) };
  }
  async updatePosition(id: number, patch: Record<string, unknown>, expect?: PositionStatus) {
    const p = this.positions.find((x) => x.id === id) as any;
    if (!p || (expect && p.status !== expect)) return false;
    for (const [k, v] of Object.entries(patch)) {
      const key = ({ exit_reason: 'exitReason', exit_attempts: 'exitAttempts', credit_points: 'creditPoints', realized_pnl: 'realizedPnl', unrealized_pnl: 'unrealizedPnl', max_loss: 'maxLoss', max_gain: 'maxGain' } as Record<string, string>)[k] ?? k;
      p[key] = v;
    }
    return true;
  }
  async updateLeg(id: number, patch: Partial<EdgeLeg>) {
    for (const p of this.positions) for (const l of p.legs) if (l.id === id) Object.assign(l, patch);
  }
  async logEvent(level: 'info' | 'warn' | 'error', mode: EdgeMode | null, positionId: number | null, kind: string, message: string) {
    this.events.push({ level, mode, positionId, kind, message });
  }
}

export const STRIKES = Array.from({ length: 41 }, (_, i) => 23_150 + i * 50); // 23150..25150
export const sym = (strike: number, right: string) => `NIFTY26O20${strike}${right}`;

export class FakeMarket implements EdgeMarket {
  spot = 24_137.4;
  futureLtp = 24_211.8;
  quotes = new Map<string, Quote>();
  vix: VixBar[] = WORKED_VIX;
  constructor() {
    // Worked-example premiums for the bearish legs; anything else defaults to a liquid quote.
    this.setQuote(sym(24350, 'CE'), 36.8, 36.75, 36.95);
    this.setQuote(sym(24150, 'CE'), 118.6, 118.45, 118.7);
  }
  setQuote(s: string, ltp: number, bid: number | null, ask: number | null) { this.quotes.set(s, { ltp, bid, ask }); }
  isTradingDay(d: string) { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return wd !== 0 && wd !== 6; }
  async getVixBars() { return this.vix; }
  async getSpot() { return this.spot; }
  async getNearestFuture() { return { tradingsymbol: 'NIFTY26OCTFUT', ltp: this.futureLtp }; }
  async getFutureLtp() { return this.futureLtp; }
  async listExpiries() { return [EXPIRY, '2026-10-27']; }
  async listStrikes() { return STRIKES; }
  async kiteSymbol(_e: string, strike: number, right: 'CE' | 'PE') { return sym(strike, right); }
  async lotSize() { return 75; }
  async getQuotes(symbols: string[]) {
    const m = new Map<string, Quote>();
    for (const s of symbols) m.set(s, this.quotes.get(s) ?? { ltp: 50, bid: 49.9, ask: 50.1 });
    return m;
  }
}

/** Scripted broker: records every order in sequence; fill outcomes are per-symbol overridable. */
export class FakeBroker {
  calls: Array<{ op: string; symbol: string; type?: string; limit?: number }> = [];
  fillPrice = new Map<string, number>();
  reject = new Set<string>();
  holds: boolean | null = false;
  funds: number | null = 1_000_000;
  private n = 0;
  private orderSymbol = new Map<string, string>();
  quotes: FakeMarket;
  constructor(quotes: FakeMarket) { this.quotes = quotes; }
  get placer(): LiveOrderPlacer {
    return {
      getQuote: async (s) => { const q = this.quotes.quotes.get(s) ?? { ltp: 50, bid: 49.9, ask: 50.1 }; return { bid: q.bid ?? q.ltp, ask: q.ask ?? q.ltp, lastPrice: q.ltp }; },
      placeOrder: async (leg, _ex, type, limit) => {
        const id = `O${++this.n}`; this.orderSymbol.set(id, leg.tradingsymbol);
        this.calls.push({ op: 'place', symbol: leg.tradingsymbol, type, limit });
        return id;
      },
      awaitFill: async (id) => {
        const s = this.orderSymbol.get(id)!;
        this.calls.push({ op: 'await', symbol: s });
        if (this.reject.has(s)) return { status: 'REJECTED', averagePrice: null };
        return { status: 'COMPLETE', averagePrice: this.fillPrice.get(s) ?? this.quotes.quotes.get(s)?.ltp ?? 50 };
      },
      getOrderStatus: async () => ({ status: 'UNKNOWN', averagePrice: null }),
      closeLeg: async (leg) => {
        const id = `C${++this.n}`; this.orderSymbol.set(id, leg.tradingsymbol);
        this.calls.push({ op: 'close', symbol: leg.tradingsymbol, type: leg.side === 'BUY' ? 'SELL' : 'BUY' });
        return id;
      },
    };
  }
  asBroker(): EdgeBroker {
    return {
      name: 'KITE', exchange: 'NFO', placer: this.placer,
      brokerSymbol: async (_e, _s, _r, kiteSymbol) => kiteSymbol,
      holdsAny: async () => this.holds,
      availableFunds: async () => this.funds,
    };
  }
}
