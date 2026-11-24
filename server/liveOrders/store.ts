/**
 * LIVE ORDERS — database persistence (tables from src/live-orders/migrations/001_live_orders.sql).
 * Service role, server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DONE, type AuditRow, type LivePosition, type LiveStorePort, type Strategy } from '../../src/live-orders/runner.ts';
import { defaultControl, type LiveControlPort, type LiveControlState } from '../../src/live-orders/control.ts';

const MISSING = /does not exist|PGRST205|42P01|schema cache/i;

export class SupabaseLiveStore implements LiveStorePort {
  private sb: SupabaseClient<any>;
  migration: boolean | null = null;
  lastError: string | null = null;
  constructor(sb: SupabaseClient<any>) { this.sb = sb; }

  private async run<T>(label: string, p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T | null> {
    const { data, error } = await p;
    if (error) {
      if (MISSING.test(`${error.code ?? ''} ${error.message}`)) this.migration = false;
      this.lastError = `${label}: ${error.message}`;
      throw new Error(this.lastError);
    }
    this.migration = true;
    return data;
  }

  async save(p: LivePosition) {
    await this.run('live_positions save', this.sb.from('live_positions').upsert({
      id: p.id, strategy: p.strategy, session_date: p.date, status: p.status, tradingsymbol: p.tradingsymbol, net: p.net, data: p, updated_at: new Date().toISOString(),
    }));
  }
  async get(id: string) {
    const r = await this.run<any>('live_positions get', this.sb.from('live_positions').select('data').eq('id', id).maybeSingle());
    return (r?.data as LivePosition) ?? null;
  }
  async active(strategy: Strategy) {
    const rows = await this.run<any[]>('live_positions active', this.sb.from('live_positions').select('data').eq('strategy', strategy).not('status', 'in', `(${[...DONE].join(',')})`));
    return (rows ?? []).map((r) => r.data as LivePosition);
  }
  async forDate(strategy: Strategy, date: string) {
    const rows = await this.run<any[]>('live_positions day', this.sb.from('live_positions').select('data').eq('strategy', strategy).eq('session_date', date).order('created_at'));
    return (rows ?? []).map((r) => r.data as LivePosition);
  }
  async recent(strategy: Strategy, limit: number) {
    const rows = await this.run<any[]>('live_positions recent', this.sb.from('live_positions').select('data').eq('strategy', strategy).order('created_at', { ascending: false }).limit(limit));
    return (rows ?? []).map((r) => r.data as LivePosition);
  }
  async audit(a: AuditRow) {
    await this.run('live_order_audit', this.sb.from('live_order_audit').insert({ at: new Date(a.at).toISOString(), strategy: a.strategy, position_id: a.positionId, action: a.action, request: a.request, result: a.result, ok: a.ok }));
  }

  async load(strategy: Strategy): Promise<LiveControlState> {
    const r = await this.run<any>('live_control', this.sb.from('live_control').select('*').eq('strategy', strategy).maybeSingle());
    const d = defaultControl(strategy);
    if (!r) return d;
    return { strategy, armed: !!r.armed, armedAt: r.armed_at ?? null, settings: { ...d.settings, ...(r.settings ?? {}) }, updatedAt: r.updated_at ?? null };
  }
  async save_(strategy: Strategy, patch: Record<string, unknown>) {
    await this.run('live_control save', this.sb.from('live_control').upsert({ strategy, ...patch, updated_at: new Date().toISOString() }));
  }
}

/** Adapter so the store satisfies both ports without a name clash on save(). */
export function controlPort(s: SupabaseLiveStore): LiveControlPort {
  return {
    load: (st) => s.load(st),
    async save(st, patch) {
      const row: Record<string, unknown> = {};
      if (patch.armed !== undefined) row.armed = patch.armed;
      if (patch.armedAt !== undefined) row.armed_at = patch.armedAt;
      if (patch.settings !== undefined) row.settings = patch.settings;
      await s.save_(st, row);
      return s.load(st);
    },
  };
}
