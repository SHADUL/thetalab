-- Position <-> forward-validation-ledger link (SHADOW lifecycle completion
-- phase, Task 1). Smallest safe addition: one nullable column, no
-- destructive change, no effect on AUTO/PAPER rows (which never populate
-- it — recordSignal() is only ever called from the SHADOW code path).
-- options_forward_validation_ledger.id is `bigint generated always as
-- identity` (migration 010) — NOT uuid. forward_ledger_id must match that
-- type for the foreign key to be creatable at all.
alter table options_autotrade_positions
  add column if not exists forward_ledger_id bigint references options_forward_validation_ledger(id);

-- valid_for_forward_validation defaults NULL (meaning "not a SHADOW
-- position, not applicable") rather than false — a PAPER/AUTO row is
-- neither eligible nor ineligible, it's simply out of scope for this
-- column entirely. Only SHADOW positions ever get true/false here.
alter table options_autotrade_positions
  add column if not exists valid_for_forward_validation boolean;
alter table options_autotrade_positions
  add column if not exists forward_validation_ineligibility_reasons jsonb;

create index if not exists options_autotrade_positions_forward_ledger_idx
  on options_autotrade_positions (forward_ledger_id) where forward_ledger_id is not null;

-- Richer outcome columns (Task 6) — additive, existing
-- realized_hypothetical_pnl/max_adverse_excursion/max_favorable_excursion/
-- exit_reason/observed_execution_cost_estimate/outcome_recorded_at columns
-- from migration 010 are UNCHANGED and still written; these are new,
-- narrower breakdowns alongside them, never a replacement.
alter table options_forward_validation_ledger add column if not exists gross_pnl numeric;
alter table options_forward_validation_ledger add column if not exists holding_period_days numeric;
alter table options_forward_validation_ledger add column if not exists entry_execution_cost numeric;
alter table options_forward_validation_ledger add column if not exists exit_execution_cost numeric;
alter table options_forward_validation_ledger add column if not exists total_execution_cost numeric;
alter table options_forward_validation_ledger add column if not exists daily_lock_state jsonb;
alter table options_forward_validation_ledger add column if not exists data_quality jsonb;
-- The idempotency/completion guard (Task 9/10): recordOutcome only ever
-- succeeds when this is still false, via an atomic
-- `UPDATE ... WHERE completed = false` — never a SELECT-then-UPDATE check.
alter table options_forward_validation_ledger add column if not exists completed boolean not null default false;

-- Execution-quality telemetry gains the phase/eligibility columns Task 3/5
-- require (the table itself already existed from migration 009).
alter table options_execution_quality add column if not exists phase text check (phase in ('ENTRY', 'EXIT'));
alter table options_execution_quality add column if not exists scan_id uuid;
alter table options_execution_quality add column if not exists forward_ledger_id bigint references options_forward_validation_ledger(id);
alter table options_execution_quality add column if not exists candidate_id text;
alter table options_execution_quality add column if not exists trading_session_horizon integer;
alter table options_execution_quality add column if not exists mid numeric;
alter table options_execution_quality add column if not exists spread_absolute numeric;
alter table options_execution_quality add column if not exists spread_capture numeric;
alter table options_execution_quality add column if not exists data_quality jsonb;
alter table options_execution_quality add column if not exists valid_for_forward_validation boolean;
