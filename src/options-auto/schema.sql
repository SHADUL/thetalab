-- Options Auto-Trader — fresh-install schema (source of truth for a brand
-- new deploy). Grows incrementally alongside src/options-auto/migrations/,
-- which is what actually gets run against the existing production
-- database — see that directory's numbered files for the safe, one-at-a-
-- time equivalent of everything below.
--
-- Orders/risk-events/performance-journal/backtest-runs tables land in
-- later slices per the architecture plan — this covers the instrument
-- master, margin wrapper, and the paper-execution orchestrator's own
-- settings/positions/legs/log/daily-stats.

create table options_instruments (
  id bigint generated always as identity primary key,
  symbol text not null,              -- NIFTY | BANKNIFTY | SENSEX
  exchange text not null,            -- NFO | BFO
  expiry date not null,
  strike numeric not null,
  option_right text not null,        -- CE | PE ("right" is a reserved word in Postgres — RIGHT JOIN)
  tradingsymbol text not null,
  instrument_token bigint not null,
  lot_size integer,
  tick_size numeric,
  last_synced_at timestamptz not null default now(),
  unique (exchange, tradingsymbol)
);
create index options_instruments_lookup_idx on options_instruments (symbol, expiry, strike, option_right);

alter table options_instruments enable row level security;

-- Singleton settings row. execution_mode starts and stays 'PAPER' until a
-- human explicitly changes it — no deploy of this feature ever places a
-- real order by default, same convention as auto_trade_settings.enabled
-- and intraday_settings.execution_mode.
--
-- reserved_fund stands in for BOTH account equity and available funds in
-- computePositionSize()'s risk-percentage math (a deliberate simplification
-- for this slice, matching how auto_trade_settings.reserved_fund already
-- works for the swing auto-trader — a user-declared capital allocation,
-- not a live pull of the whole broker account balance via Kite's
-- /user/margins, which this system does not call anywhere yet).
create table options_autotrade_settings (
  id integer primary key default 1,
  execution_mode text not null default 'PAPER',  -- OFF | PAPER | ALERT_ONLY | SEMI_AUTO | AUTO
  reserved_fund numeric not null default 0,
  max_risk_per_trade_pct numeric not null default 2,
  max_daily_loss_pct numeric not null default 4,
  max_weekly_loss_pct numeric not null default 8,
  max_portfolio_risk_pct numeric not null default 10,
  max_margin_utilization_pct numeric not null default 60,
  max_positions integer not null default 5,
  max_underlying_delta numeric not null default 300,
  max_gamma numeric not null default 50,
  max_vega numeric not null default 5000,
  max_correlated_group_risk_pct numeric not null default 6,
  no_trade_below numeric not null default 70,
  watch_below numeric not null default 80,
  high_conviction_at_or_above numeric not null default 90,
  min_dte integer not null default 2,
  max_dte integer not null default 60,
  profit_target_pct numeric not null default 50,
  stop_loss_credit_multiple numeric not null default 2,
  time_exit_dte integer not null default 2,
  strike_breach_buffer_pct numeric not null default 0,
  max_consecutive_losses integer not null default 3,
  updated_at timestamptz not null default now(),
  constraint options_autotrade_settings_singleton check (id = 1)
);
insert into options_autotrade_settings (id) values (1);

create table options_autotrade_positions (
  id bigint generated always as identity primary key,
  symbol text not null,
  strategy_label text not null,
  expiry date not null,
  status text not null default 'ACTIVE',    -- ACTIVE | CLOSED | FAILED | CLOSE_FAILED
  -- Recorded once, at open, from execution_mode at that moment — a
  -- position's own lifecycle must not silently become "live" or "paper"
  -- retroactively just because the setting changed after it opened.
  -- CLOSE_FAILED (status, not this column) means a real closing order for
  -- an AUTO position didn't confirm — deliberately excluded from this
  -- monitor's own `status = 'ACTIVE'` query so a failed unwind can never
  -- be silently retried into double-closing a leg that already filled;
  -- it waits for a human to reconcile against the broker directly.
  execution_mode text not null default 'PAPER', -- PAPER | AUTO
  execution_state text not null,             -- mirrors execution/types.ts's ExecutionState
  protection text not null,                  -- mirrors execution/types.ts's ProtectionState
  lots integer not null,
  net_credit numeric not null,
  max_profit numeric not null,
  max_loss numeric not null,
  margin_required numeric,
  net_delta numeric,
  net_gamma numeric,
  net_theta numeric,
  net_vega numeric,
  quality_score numeric,
  decision_explanation text,
  entry_date date not null,
  exit_date date,
  exit_reason text,
  realized_pnl numeric,
  -- Live mark-to-market P&L while still ACTIVE, refreshed every position-monitor
  -- cron run (5 min) — see migration 005. Null until the first monitor cycle
  -- runs against this position; never backfilled/estimated.
  unrealized_pnl numeric,
  unrealized_pnl_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index options_autotrade_positions_status_idx on options_autotrade_positions (status);

create table options_autotrade_legs (
  id bigint generated always as identity primary key,
  position_id bigint not null references options_autotrade_positions(id),
  side text not null,           -- BUY | SELL
  option_right text not null,   -- CE | PE
  strike numeric not null,
  tradingsymbol text not null,
  quantity integer not null,
  fill_price numeric not null,
  status text not null,          -- FILLED | REJECTED | CANCELLED
  -- Null for every PAPER leg. Populated only by makeLiveOrderPlacer's real
  -- Kite order calls — order_id at entry, exit_order_id/exit_fill_price
  -- once a real closing order confirms FILLED (see handlePositionMonitor).
  order_id text,
  exit_order_id text,
  exit_fill_price numeric
);
create index options_autotrade_legs_position_idx on options_autotrade_legs (position_id);

-- Append-only audit trail — the UI's activity log is a straight read of
-- this table, same convention as auto_trade_log.
create table options_autotrade_log (
  id bigint generated always as identity primary key,
  level text not null default 'info',
  message text not null,
  detail jsonb,
  -- PAPER | AUTO | null. Null for batch-level messages not tied to a
  -- single position/mode (e.g. a quote-batch failure spanning both).
  -- Position-specific entries carry THAT position's own mode, since one
  -- monitor run evaluates PAPER and AUTO positions side by side — lets
  -- the dashboard filter old PAPER chatter out of the AUTO view exactly
  -- like it already filters positions themselves.
  execution_mode text,
  created_at timestamptz not null default now()
);

-- One row per calendar date. `locked`/`lock_reason` are read by
-- computePositionSize() (via realized_pnl) but not yet WRITTEN by any
-- enforcement logic in this codebase — that's the daily risk controller
-- (a later phase), not this slice.
create table options_autotrade_daily_stats (
  trade_date date primary key,
  trades_taken integer not null default 0,
  realized_pnl numeric not null default 0,
  consecutive_losses integer not null default 0,
  locked boolean not null default false,
  lock_reason text
);

-- Concurrency/idempotency gate for AUTO entries — see
-- migrations/008_order_intents.sql for the full design rationale
-- (deduplication semantics, why the unique index is scoped to non-terminal
-- statuses only, and why this is the actual concurrency authority rather
-- than an application-level check-then-act read).
create table options_autotrade_order_intents (
  id uuid primary key default gen_random_uuid(),
  intent_key text not null,
  symbol text not null,
  expiry date not null,
  strategy_label text not null,
  trade_date date not null,
  candidate_hash text not null,
  execution_mode text not null,
  status text not null default 'CLAIMED'
    check (status in ('CLAIMED', 'EXECUTING', 'COMPLETED', 'FAILED', 'ABANDONED')),
  owner_token text not null,
  broker_order_ids jsonb not null default '[]'::jsonb,
  position_id bigint references options_autotrade_positions(id),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index options_autotrade_order_intents_active_key_idx
  on options_autotrade_order_intents (intent_key)
  where status in ('CLAIMED', 'EXECUTING', 'ABANDONED');
create index options_autotrade_order_intents_lookup_idx
  on options_autotrade_order_intents (symbol, trade_date, status);

alter table options_autotrade_settings enable row level security;
alter table options_autotrade_positions enable row level security;
alter table options_autotrade_legs enable row level security;
alter table options_autotrade_log enable row level security;
alter table options_autotrade_daily_stats enable row level security;
alter table options_autotrade_order_intents enable row level security;
-- Live data capture infrastructure (out-of-sample validation phase, Tasks
-- 8/9/11). SCHEMA ONLY in this phase — no scan/monitor code has been wired
-- to WRITE into these tables yet (that wiring is the next, not-yet-done
-- step; see OUT_OF_SAMPLE_VALIDATION_REPORT.md §17 for what's still
-- missing). Creating these now means the moment wiring lands, real data
-- starts accumulating immediately rather than waiting for a second
-- migration round-trip.
--
-- All three tables are APPEND-ONLY by convention (no UPDATE/DELETE path is
-- defined anywhere in this codebase for them) — a later row never
-- overwrites an earlier one; a bad row is superseded by a corrected NEW
-- row, never edited in place, preserving a genuine research history.

-- Task 8: real Kite option-chain microstructure, one row per instrument
-- observed during a real live scan or monitor pass.
create table options_chain_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  symbol text not null,
  spot numeric,
  india_vix numeric,
  expiry date not null,
  dte integer not null,
  strike numeric not null,
  option_right text not null,
  bid numeric,
  bid_qty integer,
  ask numeric,
  ask_qty integer,
  ltp numeric,
  volume integer,
  open_interest integer,
  iv numeric,
  delta numeric,
  gamma numeric,
  theta numeric,
  vega numeric
);
create index options_chain_snapshots_lookup_idx on options_chain_snapshots (symbol, expiry, captured_at);
alter table options_chain_snapshots enable row level security;

-- Task 9: real execution-quality telemetry for every PAPER/SHADOW/AUTO
-- order attempt (not just successful fills) — decision/quote/submission/
-- fill timestamps and prices, so slippage can eventually be measured
-- rather than assumed (feeds Task 10's calibration once enough real rows
-- exist).
create table options_execution_quality (
  id bigint generated always as identity primary key,
  position_id bigint references options_autotrade_positions(id),
  leg_id bigint references options_autotrade_legs(id),
  execution_mode text not null, -- PAPER | SHADOW | AUTO
  strategy_label text,
  symbol text not null,
  dte integer,
  delta numeric,
  india_vix numeric,
  open_interest integer,
  volume integer,
  decision_at timestamptz not null,
  quote_at timestamptz,
  submitted_at timestamptz,
  filled_at timestamptz,
  decision_mid numeric,
  bid numeric,
  ask numeric,
  submitted_limit numeric,
  actual_fill numeric,
  spread_pct numeric,
  slippage_rupees numeric,
  slippage_bps numeric,
  latency_ms integer,
  leg_sequence integer, -- position within the multi-leg execution order (0 = first leg placed)
  quantity integer,
  broker_order_id text, -- null for PAPER/SHADOW
  -- For SHADOW/PAPER, actual_fill is a SIMULATED price — this column makes
  -- that explicit rather than letting it look indistinguishable from a
  -- real AUTO fill when the two are queried together.
  fill_is_simulated boolean not null default true
);
create index options_execution_quality_lookup_idx on options_execution_quality (execution_mode, symbol, decision_at);
alter table options_execution_quality enable row level security;

-- Task 11: historical ATM IV archive, per symbol AND per expiry tenor (NOT
-- one generic symbol-level number — the existing buildIvHistory.ts archive
-- is explicitly a single near-term reading per session; this table is
-- additive, more granular, and does not replace it).
create table options_iv_history (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  symbol text not null,
  expiry date not null,
  atm_strike numeric not null,
  atm_iv numeric not null,
  calendar_dte integer not null,
  trading_session_horizon integer not null, -- see analytics/timeConventions.ts — stored pre-converted so later research never has to re-derive it
  spot numeric,
  india_vix numeric
);
create unique index options_iv_history_symbol_expiry_time_idx on options_iv_history (symbol, expiry, captured_at);
alter table options_iv_history enable row level security;
-- Durable protocol start marker (live-data-capture wiring phase, Task 13).
-- The official 3-month forward-validation clock (FORWARD_VALIDATION_PROTOCOL.md)
-- must use THIS recorded timestamp, never an inferred deployment time.
--
-- Deliberately NOT auto-inserted by this migration or by any code in this
-- phase — per the task's own "the official NIFTY sample starts only AFTER
-- this wiring has passed tests and SHADOW has been explicitly activated,"
-- a row here is a genuine, explicit, separate action for later, not a
-- byproduct of shipping this schema.
create table forward_validation_runs (
  id bigint generated always as identity primary key,
  protocol_id text not null unique,
  baseline_version text not null,
  fill_model text not null,
  symbol text not null,
  started_at timestamptz not null default now(),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'STOPPED')),
  stopped_at timestamptz,
  notes text
);
alter table forward_validation_runs enable row level security;
-- Position <-> forward-validation-ledger link (SHADOW lifecycle completion
-- phase, Task 1). Smallest safe addition: one nullable column, no
-- destructive change, no effect on AUTO/PAPER rows (which never populate
-- it — recordSignal() is only ever called from the SHADOW code path).
-- options_forward_validation_ledger.id is `bigint generated always as
-- identity` (see above) — NOT uuid. forward_ledger_id must match that
-- type for the foreign key to be creatable at all (production originally
-- rejected this as `uuid`/`bigint` type-mismatch; fixed here and in
-- migrations/012_shadow_exit_link.sql to bigint).
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

-- Forward-validation readiness phase (migrations/013_forward_validation_readiness.sql).
alter table options_forward_validation_ledger add column if not exists transaction_charges_estimate numeric;
alter table options_forward_validation_ledger add column if not exists cost_model_version text;
alter table options_forward_validation_ledger add column if not exists baseline_version text;
alter table options_forward_validation_ledger add column if not exists fill_model_version text;
alter table options_forward_validation_ledger add column if not exists protocol_id text;
alter table options_forward_validation_ledger add column if not exists code_version text;

alter table forward_validation_runs add column if not exists protocol_version text;
alter table forward_validation_runs add column if not exists code_version text;
alter table forward_validation_runs drop constraint if exists forward_validation_runs_status_check;
alter table forward_validation_runs add constraint forward_validation_runs_status_check
  check (status in ('ACTIVE', 'STOPPED', 'INVALIDATED'));

-- Atomic claim: no two ACTIVE runs for the same symbol+baseline_version at once.
create unique index if not exists forward_validation_runs_one_active_per_symbol_baseline_idx
  on forward_validation_runs (symbol, baseline_version) where status = 'ACTIVE';
