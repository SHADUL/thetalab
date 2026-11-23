/**
 * Persistence port for NIFTY ASCENT live paper (Phase 4). The server provides
 * a Supabase implementation; tests use MemoryAscentStore. Paper data only.
 */
import type { AuditEvent, EngineSnapshot, PaperOrder, Trade } from '../core/engine.ts';

export interface AscentControl { autoStart: boolean; killSwitch: boolean }
export interface StoreStatus { ok: boolean; migrationApplied: boolean | null; lastError: string | null }

export interface AscentStorePort {
  /** Atomically take or renew the single-engine lease. False = another live instance holds it. */
  acquireLease(holder: string, ttlMs: number, nowMs: number): Promise<boolean>;
  loadControl(): Promise<AscentControl>;
  saveControl(patch: Partial<AscentControl>): Promise<void>;
  loadSession(date: string): Promise<EngineSnapshot | null>;
  saveSession(date: string, mode: 'OBSERVE' | 'LIVE_PAPER', snap: EngineSnapshot): Promise<void>;
  /** Idempotent by (date, seq). */
  saveEvents(date: string, events: AuditEvent[]): Promise<void>;
  /** Upsert by (date, purpose). */
  saveOrder(date: string, order: PaperOrder, tradingsymbol: string | null): Promise<void>;
  /** Insert; the database allows one trade per date. */
  saveTrade(trade: Trade): Promise<void>;
  history(limit: number): Promise<Trade[]>;
  status(): StoreStatus;
}

/** In-memory store with the same semantics (lease expiry, one trade per day). */
export class MemoryAscentStore implements AscentStorePort {
  control: AscentControl = { autoStart: false, killSwitch: false };
  lease: { holder: string | null; expires: number } = { holder: null, expires: 0 };
  sessions = new Map<string, EngineSnapshot>();
  events = new Map<string, AuditEvent>();
  orders = new Map<string, PaperOrder & { tradingsymbol: string | null }>();
  trades = new Map<string, Trade>();
  fail = false;
  private lastError: string | null = null;
  private check() { if (this.fail) { this.lastError = 'simulated database failure'; throw new Error(this.lastError); } }

  async acquireLease(holder: string, ttlMs: number, nowMs: number) {
    this.check();
    if (this.lease.holder && this.lease.holder !== holder && this.lease.expires > nowMs) return false;
    this.lease = { holder, expires: nowMs + ttlMs };
    return true;
  }
  async loadControl() { this.check(); return { ...this.control }; }
  async saveControl(p: Partial<AscentControl>) { this.check(); this.control = { ...this.control, ...p }; }
  async loadSession(date: string) { this.check(); const s = this.sessions.get(date); return s ? JSON.parse(JSON.stringify(s)) : null; }
  async saveSession(date: string, _mode: 'OBSERVE' | 'LIVE_PAPER', snap: EngineSnapshot) { this.check(); this.sessions.set(date, JSON.parse(JSON.stringify(snap))); }
  async saveEvents(date: string, events: AuditEvent[]) { this.check(); for (const e of events) if (!this.events.has(`${date}|${e.seq}`)) this.events.set(`${date}|${e.seq}`, e); }
  async saveOrder(date: string, o: PaperOrder, sym: string | null) { this.check(); this.orders.set(`${date}|${o.purpose}`, { ...JSON.parse(JSON.stringify(o)), tradingsymbol: sym }); }
  async saveTrade(t: Trade) { this.check(); if (this.trades.has(t.date)) throw new Error('duplicate key: one trade per day'); this.trades.set(t.date, t); }
  async history(limit: number) { this.check(); return [...this.trades.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit); }
  status(): StoreStatus { return { ok: !this.fail, migrationApplied: true, lastError: this.lastError }; }
}
