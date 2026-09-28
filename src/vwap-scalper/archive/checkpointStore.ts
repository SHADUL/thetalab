/**
 * Production `CheckpointStore` adapter, reusing the same
 * `vwap_backfill_checkpoints` table the old Postgres-persisted backfill
 * used, now including `storage_backend` (migration 005) so a checkpoint
 * written by this archive-backed path is never confused with the
 * pre-migration Postgres-only coverage it may be resuming from.
 */
import type { CheckpointStore } from './archiveBackfill.ts';

/** Typed loosely, same reason as every other Supabase adapter in this codebase (see orderIntent.ts's own header comment). */
export function supabaseCheckpointStore(supabase: any): CheckpointStore {
  return {
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
        backfill_status: patch.status, last_error: patch.lastError ?? null, storage_backend: patch.storageBackend,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'symbol' });
      if (error) return { error: error.message };
      return { ok: true };
    },
  };
}
