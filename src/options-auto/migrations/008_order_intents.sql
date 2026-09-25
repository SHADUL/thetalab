-- Concurrency/idempotency gate for AUTO entries (QUANT_AUDIT.md finding:
-- no idempotency key, no distributed lock, no reconciliation before a live
-- order — a genuine duplicate-order risk under an overlapping/retried
-- cron invocation). See src/quant/execution/orderIntent.ts.
--
-- What makes two entry attempts "the same trade" (the deduplication
-- semantics this table enforces): the SAME symbol, expiry, strategy label,
-- trade date, AND the exact same selected strikes/sides (candidate_hash —
-- a deterministic hash of the priced candidate's own legs, e.g.
-- "BUY:24000:CE|BUY:23200:PE|SELL:23700:CE|SELL:23400:PE"). Two scans that
-- land on genuinely different strikes (because the market moved between
-- them) are NOT the same trade and must NOT collide here.
--
-- Deliberately NOT unique on (symbol, expiry, strategy_label, trade_date)
-- alone: that would incorrectly block a legitimate SECOND, later entry on
-- the same symbol/expiry/strategy/day after an earlier position of that
-- exact shape has already closed (a real, intended scenario — e.g. an
-- early PROFIT_TARGET close followed by a fresh signal later the same
-- session). Instead, uniqueness on intent_key is scoped to NON-TERMINAL
-- intents only (the partial unique index below) — once an intent reaches
-- a terminal status, its key is free to be reused by a later, distinct
-- attempt. This is what actually resolves the tension the task called out:
-- concurrent duplicate SUBMISSION is blocked; a legitimate LATER trade of
-- the identical shape is not.
--
-- The unique constraint is the ACTUAL concurrency authority: two
-- concurrent invocations both attempt a plain INSERT with the same
-- intent_key; Postgres's own MVCC guarantees at most one succeeds, no
-- matter how close in time the two INSERTs are. The caller must NOT
-- check-then-insert (SELECT to see if a row exists, then INSERT if not) —
-- that is exactly the check-then-act race this table exists to close.
-- Attempt the INSERT directly and treat a unique_violation (Postgres error
-- 23505) as "another invocation already claimed this candidate" — zero
-- broker calls follow that path.

create table if not exists options_autotrade_order_intents (
  id uuid primary key default gen_random_uuid(),
  intent_key text not null,
  symbol text not null,
  expiry date not null,
  strategy_label text not null,
  trade_date date not null,
  -- Deterministic hash of the exact priced candidate's legs (side/strike/
  -- right, sorted) — see src/quant/execution/orderIntent.ts's
  -- computeCandidateHash(). Stored alongside intent_key (which already
  -- embeds it) for human-readable debugging without decoding the hash.
  candidate_hash text not null,
  execution_mode text not null,               -- PAPER | AUTO — recorded even for PAPER, so the same claim/lock path is exercised in both modes (see Task 8's "PAPER behavior remains operational" invariant)
  -- CLAIMED: intent inserted, no broker call made yet.
  -- EXECUTING: live order placement in progress (AUTO only).
  -- COMPLETED: position opened successfully (position_id set).
  -- FAILED: execution failed cleanly, nothing left open at the broker
  --         (or PAPER's equivalent no-op/rejection).
  -- ABANDONED: claimed but never reached a terminal state before this
  --            process ended (e.g. a crash) — treated the SAME as a live,
  --            still-blocking non-terminal status until a human or a
  --            reconciliation pass explicitly resolves it; never
  --            auto-expired into re-claimable purely by elapsed time.
  status text not null default 'CLAIMED'
    check (status in ('CLAIMED', 'EXECUTING', 'COMPLETED', 'FAILED', 'ABANDONED')),
  owner_token text not null,                  -- opaque per-invocation identifier (see orderIntent.ts) — lets a human see which invocation holds/held a still-open intent
  broker_order_ids jsonb not null default '[]'::jsonb,
  position_id bigint references options_autotrade_positions(id),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The actual concurrency lock: at most one NON-TERMINAL intent may exist
-- for a given intent_key at any moment. Terminal intents (COMPLETED /
-- FAILED) are excluded from the constraint, so a later, distinct attempt
-- at the identical candidate shape is never permanently blocked by
-- history — only by another attempt still genuinely in flight.
create unique index if not exists options_autotrade_order_intents_active_key_idx
  on options_autotrade_order_intents (intent_key)
  where status in ('CLAIMED', 'EXECUTING', 'ABANDONED');

create index if not exists options_autotrade_order_intents_lookup_idx
  on options_autotrade_order_intents (symbol, trade_date, status);

alter table options_autotrade_order_intents enable row level security;
