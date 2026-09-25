/**
 * The concurrency/idempotency lock for AUTO entries (QUANT_AUDIT.md finding:
 * no idempotency key, no distributed lock, no reconciliation before a live
 * order — a real duplicate-order risk under an overlapping/retried cron
 * invocation). See migrations/008_order_intents.sql for the full schema
 * rationale, including exactly what makes two entry attempts "the same
 * trade" for deduplication purposes.
 *
 * Deliberately a thin wrapper over a minimal `OrderIntentStore` interface
 * rather than the Supabase client directly — this is what makes the
 * concurrency behavior itself testable with a real in-memory race (two
 * concurrent claims against the SAME store), not just testable against a
 * mock that returns canned responses. `supabaseOrderIntentStore()` is the
 * one production adapter; tests supply their own store implementing the
 * same tiny surface.
 *
 * The claim itself is a single INSERT relying on the database's own unique
 * constraint (options_autotrade_order_intents_active_key_idx) to be the
 * actual concurrency authority — never a SELECT-then-INSERT check, which
 * would just move the race rather than close it. A conflicting insert
 * (Postgres error code 23505, unique_violation) is the expected, first-
 * class "someone else already claimed this" outcome, not an exception to
 * handle defensively — it's the entire mechanism.
 */
import { createHash, randomUUID } from 'node:crypto';

export interface CandidateLeg {
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
}

/** Deterministic, order-independent hash of a candidate's exact legs — two
    candidates with the same strikes/sides in any array order hash identically;
    two candidates differing in even one strike hash differently. */
export function computeCandidateHash(legs: CandidateLeg[]): string {
  const key = legs.map((l) => `${l.side}:${l.strike}:${l.right}`).sort().join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export interface IntentIdentity {
  symbol: string;
  /** "YYYY-MM-DD" expiry date. */
  expiry: string;
  strategyLabel: string;
  /** "YYYY-MM-DD" trade date (IST), NOT a timestamp — one candidate shape
      per calendar trading day is the unit of deduplication. */
  tradeDate: string;
  candidateHash: string;
}

/** The full identity key two concurrent attempts collide on: same symbol,
    expiry, strategy, trade date, AND exact same selected strikes. A later
    attempt with different strikes (because the market moved) is a
    genuinely different intent_key and is never blocked by this one. */
export function computeIntentKey(identity: IntentIdentity): string {
  const raw = `${identity.symbol}|${identity.expiry}|${identity.strategyLabel}|${identity.tradeDate}|${identity.candidateHash}`;
  return createHash('sha256').update(raw).digest('hex');
}

export type IntentStatus = 'CLAIMED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'ABANDONED';

export interface ClaimIntentParams extends Omit<IntentIdentity, 'candidateHash'> {
  legs: CandidateLeg[];
  executionMode: 'PAPER' | 'SHADOW' | 'AUTO';
  /** Opaque per-invocation identifier, purely for human debugging of which
      invocation holds/held a still-open intent — never used for any
      authorization or correctness decision. Defaults to a fresh UUID. */
  ownerToken?: string;
  metadata?: Record<string, unknown>;
}

export type ClaimIntentResult =
  | { claimed: true; intentId: string; intentKey: string; candidateHash: string; ownerToken: string }
  | { claimed: false; reason: 'CONFLICT'; intentKey: string; candidateHash: string }
  | { claimed: false; reason: 'STORE_ERROR'; message: string };

export interface IntentUpdatePatch {
  status: IntentStatus;
  brokerOrderIds?: string[];
  positionId?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The minimal storage surface this module needs — deliberately NOT the
 * Supabase client's own shape, so a real concurrency race can be tested
 * against a plain in-memory implementation of this exact interface (see
 * orderIntent.test.ts), independent of any Supabase mock's fidelity.
 */
export interface OrderIntentStore {
  /** Must be an atomic insert-or-conflict at the storage layer — a
      SELECT-then-INSERT implementation here would defeat the entire
      point of this module. Returns `{ conflict: true }` when a
      non-terminal row already exists for this intentKey (mirrors
      Postgres unique_violation, code 23505, on the partial unique index). */
  insertClaim(row: {
    intentKey: string; symbol: string; expiry: string; strategyLabel: string;
    tradeDate: string; candidateHash: string; executionMode: 'PAPER' | 'SHADOW' | 'AUTO';
    ownerToken: string; metadata: Record<string, unknown>;
  }): Promise<{ id: string } | { conflict: true } | { error: string }>;
  updateStatus(intentId: string, patch: IntentUpdatePatch): Promise<{ ok: true } | { error: string }>;
}

export async function claimOrderIntent(store: OrderIntentStore, params: ClaimIntentParams): Promise<ClaimIntentResult> {
  const candidateHash = computeCandidateHash(params.legs);
  const identity: IntentIdentity = {
    symbol: params.symbol, expiry: params.expiry, strategyLabel: params.strategyLabel,
    tradeDate: params.tradeDate, candidateHash,
  };
  const intentKey = computeIntentKey(identity);
  const ownerToken = params.ownerToken ?? randomUUID();

  const result = await store.insertClaim({
    intentKey, symbol: params.symbol, expiry: params.expiry, strategyLabel: params.strategyLabel,
    tradeDate: params.tradeDate, candidateHash, executionMode: params.executionMode,
    ownerToken, metadata: params.metadata ?? {},
  });

  if ('conflict' in result) return { claimed: false, reason: 'CONFLICT', intentKey, candidateHash };
  if ('error' in result) return { claimed: false, reason: 'STORE_ERROR', message: result.error };
  return { claimed: true, intentId: result.id, intentKey, candidateHash, ownerToken };
}

/** Production adapter over a real Supabase client. Never called by tests —
    tests exercise claimOrderIntent()/the update path against a plain
    in-memory OrderIntentStore instead (see orderIntent.test.ts).

    Typed as `any` deliberately: supabase-js's actual fluent builder return
    types are deeply generic and don't structurally match a hand-written
    minimal interface without fighting the library's own type inference at
    every call site that already works correctly elsewhere in this
    codebase (see e.g. every other `supabase.from(...).insert(...)` call in
    api/options-autotrade.ts, none of which re-declare a narrower type for
    the client either). The actual safety this module provides is in
    OrderIntentStore's shape and in orderIntent.test.ts's real concurrency
    tests against a genuine in-memory implementation of it — not in typing
    this one production adapter's input parameter. */
export function supabaseOrderIntentStore(supabase: any): OrderIntentStore {
  return {
    async insertClaim(row) {
      const { data, error } = await supabase
        .from('options_autotrade_order_intents')
        .insert({
          intent_key: row.intentKey, symbol: row.symbol, expiry: row.expiry,
          strategy_label: row.strategyLabel, trade_date: row.tradeDate,
          candidate_hash: row.candidateHash, execution_mode: row.executionMode,
          status: 'CLAIMED', owner_token: row.ownerToken, metadata: row.metadata,
        })
        .select('id')
        .single();
      if (error) {
        // Postgres unique_violation on the partial index — this IS the
        // expected "someone else already claimed this" signal, not a
        // genuine storage failure.
        if (error.code === '23505') return { conflict: true };
        return { error: error.message };
      }
      return { id: data!.id };
    },
    async updateStatus(intentId, patch) {
      const { error } = await supabase
        .from('options_autotrade_order_intents')
        .update({
          status: patch.status,
          ...(patch.brokerOrderIds !== undefined ? { broker_order_ids: patch.brokerOrderIds } : {}),
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
