-- Forward-validation readiness phase. Additive only, no destructive
-- change, no effect on AUTO/PAPER rows (none of these columns are ever
-- populated for a non-SHADOW row).

-- Task 2/3: the canonical execution-cost/P&L breakdown needs a place to
-- persist the statutory-charge estimate SEPARATELY from slippage cost
-- (entry_execution_cost/exit_execution_cost/total_execution_cost already
-- exist from migration 012 and remain slippage-only) — see
-- src/quant/execution/executionCost.ts for the full definition.
alter table options_forward_validation_ledger add column if not exists transaction_charges_estimate numeric;
alter table options_forward_validation_ledger add column if not exists cost_model_version text;

-- Task 13: version fingerprint, stored at SIGNAL time (not outcome time)
-- so every trade in the eventual sample can be proven to have come from
-- the same frozen baseline/fill-model/protocol/code revision. Nullable —
-- a signal recorded before a protocol run exists (PRE_PROTOCOL) has no
-- protocol_id yet, and that is a valid, honest state, not an error.
alter table options_forward_validation_ledger add column if not exists baseline_version text;
alter table options_forward_validation_ledger add column if not exists fill_model_version text;
alter table options_forward_validation_ledger add column if not exists protocol_id text;
alter table options_forward_validation_ledger add column if not exists code_version text;

-- Task 6/12: the protocol-start endpoint needs to record which protocol
-- spec version and which deployed code revision started a run, and Task
-- 12 needs a THIRD status ('INVALIDATED', for "code/baseline/fill-model
-- changed mid-run, this run's sample is no longer comparable") alongside
-- the existing ACTIVE/STOPPED from migration 011. Never DELETEs a run —
-- STOPPED/INVALIDATED are terminal states on the same row, preserving the
-- full history of every protocol attempt.
alter table forward_validation_runs add column if not exists protocol_version text;
alter table forward_validation_runs add column if not exists code_version text;
alter table forward_validation_runs drop constraint if exists forward_validation_runs_status_check;
alter table forward_validation_runs add constraint forward_validation_runs_status_check
  check (status in ('ACTIVE', 'STOPPED', 'INVALIDATED'));

-- Task 6: "prevent a second ACTIVE run for the same symbol+baseline+
-- protocol using a DB constraint or atomic claim — no check-then-act
-- race." protocol_id is already globally unique (migration 011); this
-- partial unique index additionally makes it impossible for the SAME
-- symbol+baseline to ever have two DIFFERENT protocol_ids both ACTIVE at
-- once — the start endpoint's INSERT itself fails on a unique violation
-- rather than racing a SELECT-then-INSERT check.
create unique index if not exists forward_validation_runs_one_active_per_symbol_baseline_idx
  on forward_validation_runs (symbol, baseline_version) where status = 'ACTIVE';
