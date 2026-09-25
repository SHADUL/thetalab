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
