/**
 * NIFTY PULSE durable state in Supabase (service role, server only).
 * Best-effort: if the migration (src/nifty-pulse/migrations/001_nifty_pulse.sql)
 * hasn't been applied, every call is a no-op and status() says so; the live
 * paper engine keeps running in memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StorePort } from '../src/nifty-pulse/live/service.ts';
import type { PulseConfig } from '../src/nifty-pulse/core/config.ts';
import type { TimelineEvent } from '../src/nifty-pulse/core/engine.ts';

function isMissingTable(err: any) {
  return !!err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message ?? ''));
}

const RETRY_MISSING_MS = 10 * 60_000;
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

export class SupabasePulseStore implements StorePort {
  private sb: SupabaseClient<any>;
  private missingSince: number | null = null;
  private lastError: string | null = null;
  private tradesSaved = 0;
  private eventsSaved = 0;
  private everOk = false;

  constructor(sb: SupabaseClient<any>) { this.sb = sb; }

  private skip() { return this.missingSince != null && Date.now() - this.missingSince < RETRY_MISSING_MS; }

  private async run<T>(fn: () => PromiseLike<{ data: T | null; error: any }>): Promise<T | null> {
    if (this.skip()) return null;
    const { data, error } = await fn();
    if (error) {
      if (isMissingTable(error)) { this.missingSince = Date.now(); return null; }
      this.lastError = String(error.message ?? error);
      throw new Error(this.lastError);
    }
    this.missingSince = null;
    this.everOk = true;
    return data;
  }

  async loadControl() {
    const row = await this.run<any>(() => this.sb.from('nifty_pulse_control').select('config_id,config').eq('id', 1).maybeSingle());
    return row ? { configId: String(row.config_id), config: row.config as PulseConfig } : null;
  }

  async saveControl(c: { configId: string; config: PulseConfig; running: boolean; killSwitch: boolean; at: number }) {
    await this.run(() => this.sb.from('nifty_pulse_control').upsert({
      id: 1, config_id: c.configId, config: c.config, running: c.running, kill_switch: c.killSwitch, updated_at: iso(c.at),
    }));
  }

  async saveTrade(t: any) {
    if (t?.dataMode !== 'LIVE_PAPER') return; // simulation trades are never stored
    await this.run(() => this.sb.from('nifty_pulse_trades').upsert({
      session_day: t.sessionDay, trade_id: t.id, data_mode: t.dataMode, config_key: t.configKey, direction: t.direction, kind: t.kind,
      expiry: t.expiry, short_symbol: t.short.tradingsymbol, long_symbol: t.long.tradingsymbol, qty: t.qty,
      entry_at: iso(t.entryAt), exit_at: iso(t.exitAt), credit_pts: t.creditPts, realized_net: t.realizedNet, exit_reason: t.exitReason, detail: t,
    }, { onConflict: 'session_day,trade_id' }));
    this.tradesSaved++;
  }

  async saveEvents(events: Array<TimelineEvent & { sessionDay?: string }>) {
    if (!events.length) return;
    await this.run(() => this.sb.from('nifty_pulse_events').insert(events.map((e) => ({
      session_day: e.sessionDay, seq: e.seq, at: iso(e.at), kind: e.kind, title: e.title, detail: e.detail ?? null, direction: e.direction ?? null, trade_id: e.tradeId ?? null,
    }))));
    this.eventsSaved += events.length;
  }

  /** Closed live paper trades, newest first (for Analytics across sessions). */
  async history(limit = 500): Promise<unknown[]> {
    const rows = await this.run<any[]>(() => this.sb.from('nifty_pulse_trades').select('session_day,detail').order('entry_at', { ascending: false }).limit(limit));
    return (rows ?? []).map((r) => ({ ...r.detail, sessionDay: r.session_day }));
  }

  status() {
    return { enabled: true, migrationApplied: this.missingSince != null ? false : this.everOk ? true : null, tradesSaved: this.tradesSaved, eventsSaved: this.eventsSaved, lastError: this.lastError };
  }
}

export function makePulseStore(): SupabasePulseStore | null {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return new SupabasePulseStore(createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (input: any, init?: any) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  }));
}
