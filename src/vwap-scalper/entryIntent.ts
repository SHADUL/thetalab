/**
 * The concurrency/idempotency lock for VWAP Scalper entries — VWAP_SCALPER_AUDIT.md
 * §2.17: two overlapping `handleVwapScalperScan` invocations could both read
 * "no active position for SYMBOL," both compute the same signal, and both
 * insert a position before either write lands. Same class of bug the
 * Options Auto-Trader's `order_intents` (src/quant/execution/orderIntent.ts)
 * already fixes there — this is the direct port for the VWAP side, same
 * architecture, same discipline: a single INSERT relying on the
 * database's own partial unique index to be the actual concurrency
 * authority, never a SELECT-then-INSERT check.
 *
 * Deliberately a thin wrapper over a minimal `EntryIntentStore` interface
 * rather than the Supabase client directly, so the concurrency behavior
 * itself is testable with a real in-memory race — see entryIntent.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';

export type Direction = 'LONG' | 'SHORT';
export type EntryMode = 'TOUCH' | 'REJECTION' | 'CANDLE_REVERSAL';

/**
 * The full identity two concurrent attempts collide on: same symbol, same
 * trading session (date), the EXACT SAME signal candle (by its own
 * timestamp — this is what makes it "the same signal," not just "the same
 * symbol today"), same direction, same entry mode. A later, genuinely new
 * signal on the same symbol/session (a different candle timestamp) is a
 * different intent_key and is never blocked by this one.
 */
export interface IntentIdentity {
  symbol: string;
  /** "YYYY-MM-DD" IST trading session date. */
  tradeDate: string;
  /** epoch ms of the signal candle (the bar the signal fired on) — the actual per-signal discriminator. */
  signalTimestampMs: number;
  direction: Direction;
  entryMode: EntryMode;
}

export function computeIntentKey(identity: IntentIdentity): string {
  const raw = `${identity.symbol}|${identity.tradeDate}|${identity.signalTimestampMs}|${identity.direction}|${identity.entryMode}`;
  return createHash('sha256').update(raw).digest('hex');
}

export type EntryIntentStatus = 'CLAIMED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
/** Non-terminal — a live/still-open claim; the partial unique index is scoped to exactly these. */
export const NON_TERMINAL_STATUSES: EntryIntentStatus[] = ['CLAIMED', 'EXECUTING'];

export interface ClaimEntryIntentParams extends IntentIdentity {
  ownerToken?: string;
  metadata?: Record<string, unknown>;
}

export type ClaimEntryIntentResult =
  | { claimed: true; intentId: string; intentKey: string; ownerToken: string }
  | { claimed: false; reason: 'CONFLICT'; intentKey: string }
  | { claimed: false; reason: 'STORE_ERROR'; message: string };

export interface EntryIntentUpdatePatch {
  status: EntryIntentStatus;
  positionId?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The minimal storage surface — deliberately NOT the Supabase client's own
 * shape, so a real concurrency race can be tested against a plain
 * in-memory implementation (see entryIntent.test.ts), independent of any
 * Supabase mock's fidelity.
 */
export interface EntryIntentStore {
  /** Must be an atomic insert-or-conflict at the storage layer. Returns
      `{ conflict: true }` when a non-terminal row already exists for this
      intentKey (mirrors Postgres unique_violation, code 23505, on the
      partial unique index) — the expected "someone else already claimed
      this" outcome, not a storage failure. */
  insertClaim(row: {
    intentKey: string; symbol: string; tradeDate: string; signalTimestampMs: number;
    direction: Direction; entryMode: EntryMode; ownerToken: string; metadata: Record<string, unknown>;
  }): Promise<{ id: string } | { conflict: true } | { error: string }>;
  updateStatus(intentId: string, patch: EntryIntentUpdatePatch): Promise<{ ok: true } | { error: string }>;
}

export async function claimEntryIntent(store: EntryIntentStore, params: ClaimEntryIntentParams): Promise<ClaimEntryIntentResult> {
  const identity: IntentIdentity = {
    symbol: params.symbol, tradeDate: params.tradeDate,
    signalTimestampMs: params.signalTimestampMs, direction: params.direction, entryMode: params.entryMode,
  };
  const intentKey = computeIntentKey(identity);
  const ownerToken = params.ownerToken ?? randomUUID();

  const result = await store.insertClaim({
    intentKey, symbol: params.symbol, tradeDate: params.tradeDate,
    signalTimestampMs: params.signalTimestampMs, direction: params.direction, entryMode: params.entryMode,
    ownerToken, metadata: params.metadata ?? {},
  });

  if ('conflict' in result) return { claimed: false, reason: 'CONFLICT', intentKey };
  if ('error' in result) return { claimed: false, reason: 'STORE_ERROR', message: result.error };
  return { claimed: true, intentId: result.id, intentKey, ownerToken };
}

/** Production adapter — typed loosely for the same reason orderIntent.ts's own adapter is (see that file's header comment); the real safety is in EntryIntentStore's shape and the in-memory concurrency tests, not in narrowing the Supabase client's type here. */
export function supabaseEntryIntentStore(supabase: any): EntryIntentStore {
  return {
    async insertClaim(row) {
      const { data, error } = await supabase
        .from('vwap_scalper_entry_intents')
        .insert({
          intent_key: row.intentKey, symbol: row.symbol, trade_date: row.tradeDate,
          signal_timestamp: new Date(row.signalTimestampMs).toISOString(),
          direction: row.direction, entry_mode: row.entryMode,
          status: 'CLAIMED', owner_token: row.ownerToken, metadata: row.metadata,
        })
        .select('id')
        .single();
      if (error) {
        if (error.code === '23505') return { conflict: true };
        return { error: error.message };
      }
      return { id: data!.id };
    },
    async updateStatus(intentId, patch) {
      const { error } = await supabase
        .from('vwap_scalper_entry_intents')
        .update({
          status: patch.status,
          ...(patch.positionId !== undefined ? { position_id: patch.positionId } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', intentId);
      if (error) return { error: error.message };
      return { ok: true };
    },
  };
}
