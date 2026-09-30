-- Nifty Alpha Ladder (hedged133) — Milestone 3 schema. Fully isolated:
-- every table is prefixed alpha_ladder_, none reuse or modify
-- options_autotrade_* or vwap_scalper_* tables. NOT applied automatically —
-- per your instruction, run this manually in the Supabase SQL editor and
-- confirm before the worker/API depend on it.

-- Own settings row, own execution_mode (SHADOW/AUTO only — see A6/§1 of the
-- implementation plan; there is no PAPER for this strategy at all).
create table alpha_ladder_settings (
  id bigint primary key default 1,
  execution_mode text not null default 'SHADOW' check (execution_mode in ('SHADOW', 'AUTO')),
  active_broker text not null default 'KITE' check (active_broker in ('KITE', 'GROWW')),
  allocated_capital numeric not null default 0,
  sizing_mode text not null default 'unit' check (sizing_mode in ('unit', 'quantity')),
  configured_unit_quantity integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint alpha_ladder_settings_singleton check (id = 1)
);
alter table alpha_ladder_settings enable row level security;

-- Worker process health — one row per worker instance/connection
-- generation, so a restart is visible as a NEW row, never silently
-- overwriting the previous instance's terminal state.
create table alpha_ladder_worker_health (
  id bigint generated always as identity primary key,
  worker_instance text not null,
  connection_generation integer not null,
  status text not null check (status in (
    'STARTING', 'CONNECTING', 'WARMING_UP', 'HEALTHY', 'DEGRADED',
    'STALE', 'RECONNECTING', 'FAILED', 'MARKET_CLOSED'
  )),
  current_instrument_token bigint,
  current_future_symbol text,
  last_socket_message_at timestamptz,
  last_depth_snapshot_at timestamptz,
  last_valid_depth_at timestamptz,
  last_g1_event_at timestamptz,
  last_g2_snapshot_at timestamptz,
  worker_started_at timestamptz not null,
  reconnect_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create index alpha_ladder_worker_health_lookup_idx on alpha_ladder_worker_health (worker_instance, connection_generation, updated_at desc);
alter table alpha_ladder_worker_health enable row level security;

-- Every feed gap, persisted — never silently interpolated over.
create table alpha_ladder_feed_gaps (
  id bigint generated always as identity primary key,
  connection_generation integer not null,
  gap_start timestamptz not null,
  gap_end timestamptz,
  duration_ms bigint,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table alpha_ladder_feed_gaps enable row level security;

-- Definition 13.3's reference-threshold state — one row per side, updated
-- in place as completed windows fold in (this IS the durable, cross-
-- invocation state the estimator needs; a worker restart resumes from here
-- rather than re-warming from zero).
create table alpha_ladder_large_order_reference (
  side text primary key check (side in ('b', 'a')),
  cumulative_count bigint not null default 0,
  running_threshold numeric not null default 0,
  updated_at timestamptz not null default now()
);
alter table alpha_ladder_large_order_reference enable row level security;

-- Merged large-order events (Definition 2.2) — the durable knot series G1
-- is built from. Minute-stamped, per side.
create table alpha_ladder_large_order_events (
  id bigint generated always as identity primary key,
  side text not null check (side in ('b', 'a')),
  event_minute timestamptz not null,
  quantity numeric not null,
  order_count integer not null,
  created_at timestamptz not null default now(),
  unique (side, event_minute)
);
create index alpha_ladder_large_order_events_time_idx on alpha_ladder_large_order_events (event_minute);
alter table alpha_ladder_large_order_events enable row level security;

-- Completed G2 aggregate-imbalance snapshots (Definition 2.6) — one row per
-- theta4 interval.
create table alpha_ladder_imbalance_snapshots (
  id bigint generated always as identity primary key,
  snapshot_time timestamptz not null unique,
  bid_qty numeric not null,
  ask_qty numeric not null,
  rho numeric not null,
  cumulative_g2 numeric not null,
  created_at timestamptz not null default now()
);
create index alpha_ladder_imbalance_snapshots_time_idx on alpha_ladder_imbalance_snapshots (snapshot_time);
alter table alpha_ladder_imbalance_snapshots enable row level security;

-- One row per fired weekly signal — Gate 5.4's idempotency key is the
-- unique constraint on week_key, enforced by the DB, not by an in-memory
-- lock (this codebase's own established idempotency pattern).
create table alpha_ladder_signals (
  id bigint generated always as identity primary key,
  week_key date not null unique,
  signal_date date not null,
  signal_instant timestamptz not null,
  path text not null check (path in ('crossing', 'cutoff')),
  d1 smallint not null check (d1 in (-1, 0, 1)),
  d2 smallint not null check (d2 in (-1, 0, 1)),
  alpha smallint not null check (alpha in (0, 1)),
  base_direction smallint not null check (base_direction in (-1, 1)),
  final_direction smallint not null check (final_direction in (-1, 1)),
  area1 numeric not null,
  area2 numeric not null,
  g1_at_signal numeric not null,
  g2_at_signal numeric not null,
  crossing_time timestamptz,
  crossing_g2_value numeric,
  vix_value numeric,
  vix_available boolean not null,
  variation_c_acted boolean not null,
  depth_source text not null default 'NIFTY_NEAREST_FUTURE',
  depth_source_mode text not null default 'FUTURES_DEPTH_FALLBACK_MODE',
  strategy_version text not null,
  created_at timestamptz not null default now()
);
alter table alpha_ladder_signals enable row level security;

-- One row per published structure call (spec's "call" concept) — the
-- monitor leg is call kind='MONITOR', the option ladder is kind='STRUCTURE'.
create table alpha_ladder_calls (
  id bigint generated always as identity primary key,
  signal_id bigint not null references alpha_ladder_signals(id),
  kind text not null check (kind in ('MONITOR', 'STRUCTURE')),
  status text not null default 'PUBLISHED' check (status in (
    'PUBLISHED', 'LIVE', 'EXIT_REQUESTED', 'EXITING', 'CLOSED', 'LEFTOVER_ALERT'
  )),
  direction smallint not null check (direction in (-1, 1)),
  execution_mode text not null check (execution_mode in ('SHADOW', 'AUTO')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (signal_id, kind)
);
alter table alpha_ladder_calls enable row level security;

-- The monitor futures leg's own state (logical/simulated in SHADOW — no
-- real futures order is ever placed for the monitor per your instruction).
create table alpha_ladder_monitor_state (
  call_id bigint primary key references alpha_ladder_calls(id),
  future_symbol text not null,
  future_token bigint not null,
  f0 numeric not null,
  direction smallint not null check (direction in (-1, 1)),
  target_hit_at timestamptz,
  target_hit_price numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table alpha_ladder_monitor_state enable row level security;

-- The resolved option structure (one row per STRUCTURE call).
create table alpha_ladder_positions (
  id bigint generated always as identity primary key,
  call_id bigint not null references alpha_ladder_calls(id) unique,
  symbol text not null default 'NIFTY',
  direction smallint not null check (direction in (-1, 1)),
  spot_at_resolution numeric not null,
  expiry date not null,
  strike_step numeric not null,
  atm_strike numeric not null,
  units integer not null,
  lot_size integer not null,
  sizing_source_balance numeric,
  net_debit_points numeric,
  max_loss numeric,
  max_gain numeric,
  tail_value numeric,
  break_evens numeric[],
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CLOSED', 'CLOSE_FAILED', 'STRUCTURE_RESOLUTION_FAILED')),
  exit_reason text,
  realized_pnl numeric,
  execution_mode text not null check (execution_mode in ('SHADOW', 'AUTO')),
  strategy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table alpha_ladder_positions enable row level security;

-- The 3 declared legs of one position, in placement order.
create table alpha_ladder_legs (
  id bigint generated always as identity primary key,
  position_id bigint not null references alpha_ladder_positions(id),
  placement_order smallint not null,
  side text not null check (side in ('BUY', 'SELL')),
  option_right text not null check (option_right in ('CE', 'PE')),
  strike numeric not null,
  ratio smallint not null,
  quantity integer not null,
  tradingsymbol text,
  instrument_token bigint,
  reference_ltp numeric,
  reference_bid numeric,
  reference_ask numeric,
  calculated_marketable_limit numeric,
  status text not null default 'IDLE' check (status in (
    'IDLE', 'SIZED', 'PLACING', 'GATING', 'COMPLETE', 'ROLLBACK', 'ABANDONED'
  )),
  unique (position_id, placement_order)
);
alter table alpha_ladder_legs enable row level security;

-- Every SHADOW-simulated order (entry, rollback compensation, and exit) —
-- one row per simulated order object, mirroring Definition 16.1's ledger
-- primary/exit-row concept. broker_order_id is ALWAYS null in Milestone 3
-- (SHADOW never places anything); the column exists for Milestone 5 parity,
-- not populated yet.
create table alpha_ladder_shadow_orders (
  id bigint generated always as identity primary key,
  leg_id bigint not null references alpha_ladder_legs(id),
  order_kind text not null check (order_kind in ('ENTRY', 'ROLLBACK_EXIT', 'EXIT')),
  side text not null check (side in ('BUY', 'SELL')),
  quantity integer not null,
  reference_ltp numeric,
  bid numeric,
  ask numeric,
  submitted_limit numeric,
  submission_time_simulated timestamptz,
  fill_time_simulated timestamptz,
  fill_price_simulated numeric,
  slippage_vs_reference numeric,
  fill_status text not null default 'PLACEMENT' check (fill_status in (
    'PLACEMENT', 'ACKNOWLEDGED', 'OPEN', 'COMPLETE', 'REJECTED', 'CANCELLED', 'TIMEOUT'
  )),
  execution_quality text check (execution_quality in (
    'TOUCH_FILL', 'DEPTH_FILL', 'DELAYED_FILL', 'LIMIT_NOT_MARKETABLE', 'TIMEOUT'
  )),
  broker_order_id text, -- always null in Milestone 3 — see header comment
  reprice_iteration integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index alpha_ladder_shadow_orders_leg_idx on alpha_ladder_shadow_orders (leg_id, order_kind);
alter table alpha_ladder_shadow_orders enable row level security;

-- Full audit trail — every signal/direction/VIX/depth-source/ATM/expiry/
-- order/rollback/exit event, per your §39 telemetry list.
create table alpha_ladder_activity_log (
  id bigint generated always as identity primary key,
  level text not null default 'info' check (level in ('info', 'error')),
  message text not null,
  detail jsonb,
  call_id bigint references alpha_ladder_calls(id),
  position_id bigint references alpha_ladder_positions(id),
  created_at timestamptz not null default now()
);
create index alpha_ladder_activity_log_time_idx on alpha_ladder_activity_log (created_at desc);
alter table alpha_ladder_activity_log enable row level security;

-- Post-entry/post-exit reconciliation passes (theta34-timed) — internal
-- consistency checks in SHADOW (no broker to reconcile against yet).
create table alpha_ladder_reconciliation (
  id bigint generated always as identity primary key,
  call_id bigint not null references alpha_ladder_calls(id),
  pass_number smallint not null check (pass_number in (1, 2)),
  status text not null check (status in ('OK', 'INCOMPLETE_STRUCTURE', 'LEFTOVER_ALERT')),
  detail jsonb,
  created_at timestamptz not null default now()
);
alter table alpha_ladder_reconciliation enable row level security;
