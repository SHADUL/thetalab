/**
 * Supabase persistence for NIFTY ASCENT live paper (tables from
 * src/nifty-ascent/migrations/001_nifty_ascent.sql). Service role, server
 * only. Paper data only — nothing here relates to real orders.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AscentStorePort, AscentControl, StoreStatus } from '../src/nifty-ascent/live/store.ts';
import type { AuditEvent, EngineSnapshot, PaperOrder, Trade } from '../src/nifty-ascent/core/engine.ts';

const MISSING = /does not exist|PGRST205|42P01|schema cache/i;

export class SupabaseAscentStore implements AscentStorePort {
  private sb: SupabaseClient<any>;
  private migration: boolean | null = null;
  private lastError: string | null = null;
  private ok = true;
  constructor(sb: SupabaseClient<any>) { this.sb = sb; }

  private async run<T>(label: string, p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T | null> {
    const { data, error } = await p;
    if (error) {
      const msg = `${label}: ${error.message}`;
      if (MISSING.test(`${error.code ?? ''} ${error.message}`)) this.migration = false;
      this.ok = false; this.lastError = msg;
      throw new Error(msg);
    }
    this.migration = true; this.ok = true;
    return data;
  }

  async acquireLease(holder: string, ttlMs: number, nowMs: number): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(holder)) throw new Error('invalid lease holder id');
    const nowIso = new Date(nowMs).toISOString();
    const rows = await this.run<any[]>('lease', this.sb.from('nifty_ascent_control')
      .update({ lease_holder: holder, lease_expires_at: new Date(nowMs + ttlMs).toISOString(), updated_at: nowIso })
      .eq('id', 1)
      .or(`lease_holder.is.null,lease_holder.eq.${holder},lease_expires_at.lt.${nowIso}`)
      // PostgREST re-applies or() to the returned rows, so every column it references must be selected.
      .select('lease_holder,lease_expires_at'));
    return !!rows?.length;
  }

  async loadControl(): Promise<AscentControl> {
    const row = await this.run<any>('control', this.sb.from('nifty_ascent_control').select('auto_start,kill_switch').eq('id', 1).maybeSingle());
    return { autoStart: !!row?.auto_start, killSwitch: !!row?.kill_switch };
  }

  async saveControl(p: Partial<AscentControl>) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (p.autoStart !== undefined) patch.auto_start = p.autoStart;
    if (p.killSwitch !== undefined) patch.kill_switch = p.killSwitch;
    await this.run('control save', this.sb.from('nifty_ascent_control').update(patch).eq('id', 1));
  }

  async loadSession(date: string): Promise<EngineSnapshot | null> {
    const row = await this.run<any>('session', this.sb.from('nifty_ascent_sessions').select('snapshot').eq('session_date', date).maybeSingle());
    return (row?.snapshot as EngineSnapshot) ?? null;
  }

  async saveSession(date: string, mode: 'OBSERVE' | 'LIVE_PAPER', snap: EngineSnapshot) {
    await this.run('session save', this.sb.from('nifty_ascent_sessions').upsert({
      session_date: date, mode, config_version: snap.configVersion, state: snap.state, outcome: snap.outcome, snapshot: snap, updated_at: new Date().toISOString(),
    }, { onConflict: 'session_date' }));
  }

  async saveEvents(date: string, events: AuditEvent[]) {
    if (!events.length) return;
    await this.run('events', this.sb.from('nifty_ascent_events').upsert(events.map((e) => ({
      session_date: date, seq: e.seq, at: new Date(e.at).toISOString(), kind: e.kind, bot: e.bot, trigger: e.trigger,
      from_state: e.from ?? null, to_state: e.to ?? null, bar: e.bar, reason: e.reason, prices: e.prices ?? null, levels: e.levels ?? null, config_version: e.configVersion,
    })), { onConflict: 'session_date,seq', ignoreDuplicates: true }));
  }

  async saveOrder(date: string, o: PaperOrder, tradingsymbol: string | null) {
    await this.run('order', this.sb.from('nifty_ascent_orders').upsert({
      session_date: date, purpose: o.purpose, bot: o.bot, token: o.token, tradingsymbol, status: o.status, reason: o.reason,
      reject_reason: o.rejectReason ?? null, fill: o.fill ?? null, skipped: o.skipped, created_at: new Date(o.createdAt).toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'session_date,purpose' }));
  }

  async saveTrade(t: Trade) {
    await this.run('trade', this.sb.from('nifty_ascent_trades').insert({
      session_date: t.date, data_mode: 'LIVE_PAPER', bot: t.bot, option_right: t.right, tradingsymbol: t.tradingsymbol, strike: t.strike,
      expiry: t.expiry, lot_size: t.lotSize, qty: t.qty, gap_pct: t.gapPct, gap_direction: t.gapDirection, signal_bar: t.signalBar,
      signal_close: t.signalClose, entry_at: new Date(t.entryAt).toISOString(), entry_premium: t.entryPremium, exit_at: new Date(t.exitAt).toISOString(),
      exit_premium: t.exitPremium, exit_reason: t.exitReason, exit_signal_bar: t.exitSignalBar, highest: t.highest, trail_activated: t.trailActivated,
      gross: t.gross, costs: t.costs, net: t.net, return_pct: t.returnPct, strategy_version: t.strategyVersion, cost_model: t.costModel,
    }));
  }

  async history(limit: number): Promise<Trade[]> {
    const rows = await this.run<any[]>('history', this.sb.from('nifty_ascent_trades').select('*').order('session_date', { ascending: false }).limit(limit));
    // Sessions rebuilt after a late start (marker in the session snapshot).
    const late = new Map<string, string>();
    if (rows?.length) {
      const { data } = await this.sb.from('nifty_ascent_sessions').select('session_date,recovery:snapshot->recovery').in('session_date', rows.map((r) => r.session_date));
      for (const s of (data as any[] | null) ?? []) if (s.recovery?.note) late.set(String(s.session_date), String(s.recovery.note));
    }
    return (rows ?? []).map((r) => ({
      date: String(r.session_date), bot: r.bot, right: r.option_right, tradingsymbol: r.tradingsymbol, strike: Number(r.strike), expiry: String(r.expiry),
      lotSize: r.lot_size, qty: r.qty, gapPct: Number(r.gap_pct), gapDirection: r.gap_direction, signalBar: r.signal_bar, signalClose: Number(r.signal_close),
      entryAt: Date.parse(r.entry_at), entryPremium: Number(r.entry_premium), exitAt: Date.parse(r.exit_at), exitPremium: Number(r.exit_premium),
      exitReason: r.exit_reason, exitSignalBar: r.exit_signal_bar, highest: r.highest == null ? null : Number(r.highest), trailActivated: r.trail_activated,
      gross: Number(r.gross), costs: Number(r.costs), net: Number(r.net), returnPct: Number(r.return_pct), strategyVersion: r.strategy_version, costModel: r.cost_model,
      lateStart: late.get(String(r.session_date)) ?? null,
    }));
  }

  status(): StoreStatus { return { ok: this.ok, migrationApplied: this.migration, lastError: this.lastError }; }
}

export function makeAscentStore(): SupabaseAscentStore | null {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return new SupabaseAscentStore(createClient(url, key, { auth: { persistSession: false } }));
}
