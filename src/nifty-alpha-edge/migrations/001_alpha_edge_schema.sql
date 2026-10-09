-- Nifty Alpha Edge (hedged131) — own settings, positions, legs and event log.
-- The weekly order-flow signal itself is read from the shared
-- alpha_ladder_signals table (same engine); nothing here writes to it.

create table if not exists alpha_edge_settings (
  id bigint primary key default 1,
  shadow_enabled boolean not null default true,
  auto_enabled boolean not null default false,          -- real orders: off until explicitly enabled
  kill_switch boolean not null default false,
  shadow_capital numeric not null default 500000,        -- fixed SHADOW allocation (never the real balance)
  auto_capital numeric not null default 0,               -- AUTO allocation; 0 = sizes to zero units
  active_broker text not null default 'KITE' check (active_broker in ('KITE', 'GROWW')),
  unit_budget numeric not null default 125000,           -- θ39, ₹ per structure unit
  updated_at timestamptz not null default now(),
  constraint alpha_edge_settings_singleton check (id = 1)
);
insert into alpha_edge_settings (id) values (1) on conflict (id) do nothing;

create table if not exists alpha_edge_positions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  mode text not null check (mode in ('SHADOW', 'AUTO')),
  week_key date not null,
  signal_id bigint,
  signal_date date,
  direction smallint not null check (direction in (-1, 1)),
  base_direction smallint,
  vix numeric,
  vix_available boolean,
  variation_c_acted boolean,
  structure text,
  expiry date,
  atm numeric,
  strike_step numeric,
  wing_points numeric,
  units integer,
  lot_size integer,
  quantity integer,
  credit_points numeric,
  max_gain numeric,
  max_loss numeric,
  breakeven numeric,
  future_symbol text,
  f0 numeric,
  last_future numeric,
  status text not null check (status in ('ENTERING', 'ACTIVE', 'EXITING', 'CLOSED', 'FAILED', 'CLOSE_FAILED', 'RECONCILIATION_REQUIRED')),
  exit_reason text,
  exit_attempts integer not null default 0,
  realized_pnl numeric,
  unrealized_pnl numeric,
  marked_at timestamptz,
  closed_at timestamptz,
  broker text,
  strategy_version text,
  unique (week_key, mode)                               -- one position per week per mode, claimed before any order
);
alter table alpha_edge_positions enable row level security;

create table if not exists alpha_edge_legs (
  id bigint generated always as identity primary key,
  position_id bigint not null references alpha_edge_positions(id),
  leg_index smallint not null,
  side text not null check (side in ('BUY', 'SELL')),
  option_right text not null check (option_right in ('CE', 'PE')),
  strike numeric not null,
  kite_symbol text not null,
  broker_symbol text not null,
  quantity integer not null,
  entry_limit numeric, entry_fill numeric, entry_order_id text,
  exit_limit numeric, exit_fill numeric, exit_order_id text,
  last_price numeric,
  updated_at timestamptz not null default now()
);
create index if not exists alpha_edge_legs_position_idx on alpha_edge_legs (position_id);
alter table alpha_edge_legs enable row level security;

create table if not exists alpha_edge_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  level text not null,
  mode text,
  position_id bigint,
  kind text not null,
  message text not null,
  detail jsonb
);
create index if not exists alpha_edge_events_time_idx on alpha_edge_events (created_at desc);
alter table alpha_edge_events enable row level security;
