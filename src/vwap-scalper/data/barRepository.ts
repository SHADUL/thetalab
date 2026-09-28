/**
 * Idempotent persistence for vwap_minute_bars (VWAP_SCALPER_DATA_FOUNDATION
 * Task 3/4) — upserts on the (symbol, timestamp) unique constraint, so
 * re-running a backfill or forward-capture cycle over an already-persisted
 * window never duplicates a bar; it just re-writes the same row.
 */
import type { Bar } from '../types.ts';

export interface BarRow extends Bar {
  symbol: string;
  instrumentToken: number;
  source: 'KITE_HISTORICAL' | 'KITE_FORWARD_CAPTURE';
}

export interface BarRepository {
  upsertBars(rows: BarRow[]): Promise<{ ok: true; count: number } | { error: string }>;
  getCheckpoint(symbol: string): Promise<{ earliestPersistedMs: number | null; latestPersistedMs: number | null; status: string } | null>;
  upsertCheckpoint(symbol: string, patch: {
    instrumentToken: number; earliestPersistedMs: number | null; latestPersistedMs: number | null;
    status: 'IN_PROGRESS' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'NO_DATA'; lastError?: string | null;
  }): Promise<{ ok: true } | { error: string }>;
}

/** Production adapter — typed loosely, same reason as every other Supabase adapter in this codebase (see orderIntent.ts's own header comment). */
export function supabaseBarRepository(supabase: any): BarRepository {
  return {
    async upsertBars(rows) {
      if (rows.length === 0) return { ok: true, count: 0 };
      const { error } = await supabase.from('vwap_minute_bars').upsert(
        rows.map((r) => ({
          symbol: r.symbol, instrument_token: r.instrumentToken, timestamp: new Date(r.t).toISOString(),
          open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, source: r.source,
        })),
        { onConflict: 'symbol,timestamp' },
      );
      if (error) return { error: error.message };
      return { ok: true, count: rows.length };
    },
    async getCheckpoint(symbol) {
      const { data } = await supabase.from('vwap_backfill_checkpoints').select('*').eq('symbol', symbol).maybeSingle();
      if (!data) return null;
      return {
        earliestPersistedMs: data.earliest_persisted_timestamp ? Date.parse(data.earliest_persisted_timestamp) : null,
        latestPersistedMs: data.latest_persisted_timestamp ? Date.parse(data.latest_persisted_timestamp) : null,
        status: data.backfill_status,
      };
    },
    async upsertCheckpoint(symbol, patch) {
      const { error } = await supabase.from('vwap_backfill_checkpoints').upsert({
        symbol, instrument_token: patch.instrumentToken,
        earliest_persisted_timestamp: patch.earliestPersistedMs !== null ? new Date(patch.earliestPersistedMs).toISOString() : null,
        latest_persisted_timestamp: patch.latestPersistedMs !== null ? new Date(patch.latestPersistedMs).toISOString() : null,
        backfill_status: patch.status, last_error: patch.lastError ?? null, updated_at: new Date().toISOString(),
      }, { onConflict: 'symbol' });
      if (error) return { error: error.message };
      return { ok: true };
    },
  };
}
