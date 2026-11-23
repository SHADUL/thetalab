-- NIFTY ASCENT — live paper persistence (Phase 4). PAPER ONLY: nothing here
-- relates to real orders. Apply manually in the Supabase SQL editor.
-- Every table has RLS enabled with no policies: only the server's service
-- role can read or write; the browser never touches these tables.

-- Single control row: lease (one engine instance), owner's auto-start switch, kill switch.
create table if not exists nifty_ascent_control (
  id               int primary key default 1 check (id = 1),
  auto_start       boolean not null default false,   -- owner approval: START the PAUSED engine automatically each trading day
  kill_switch      boolean not null default false,
  lease_holder     text,
  lease_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);
insert into nifty_ascent_control (id) values (1) on conflict (id) do nothing;

-- One row per trading day: the engine snapshot used for restart recovery.
create table if not exists nifty_ascent_sessions (
  session_date   date primary key,
  mode           text not null check (mode in ('OBSERVE', 'LIVE_PAPER')),
  config_version text not null,
  state          text not null,
  outcome        jsonb,
  snapshot       jsonb not null,
  updated_at     timestamptz not null default now()
);

-- Audit trail: every state transition and engine event, idempotent by (day, seq).
create table if not exists nifty_ascent_events (
  id             bigint generated always as identity primary key,
  session_date   date not null,
  seq            int not null,
  at             timestamptz not null,
  kind           text not null,
  bot            text,
  trigger        text not null,
  from_state     text,
  to_state       text,
  bar            int,
  reason         text not null,
  prices         jsonb,
  levels         jsonb,
  config_version text not null,
  unique (session_date, seq)
);
create index if not exists nifty_ascent_events_day_idx on nifty_ascent_events (session_date, seq);

-- Paper orders: at most one ENTRY and one EXIT per trading day (primary key).
create table if not exists nifty_ascent_orders (
  session_date  date not null,
  purpose       text not null check (purpose in ('ENTRY', 'EXIT')),
  bot           text not null,
  token         bigint not null,
  tradingsymbol text,
  status        text not null check (status in ('PENDING', 'FILLED', 'REJECTED', 'UNRESOLVED')),
  reason        text,
  reject_reason text,
  fill          jsonb,
  skipped       jsonb,
  created_at    timestamptz not null,
  updated_at    timestamptz not null default now(),
  primary key (session_date, purpose)
);

-- Filled paper trades: ONE per trading day across both bots (primary key).
create table if not exists nifty_ascent_trades (
  session_date     date primary key,
  data_mode        text not null check (data_mode = 'LIVE_PAPER'),
  bot              text not null check (bot in ('GAP_AND_GO', 'WILLIAMS')),
  option_right     text not null check (option_right in ('CE', 'PE')),
  tradingsymbol    text not null,
  strike           numeric not null,
  expiry           date not null,
  lot_size         int not null,
  qty              int not null,
  gap_pct          numeric,
  gap_direction    text,
  signal_bar       int,
  signal_close     numeric,
  entry_at         timestamptz not null,
  entry_premium    numeric not null,
  exit_at          timestamptz not null,
  exit_premium     numeric not null,
  exit_reason      text not null check (exit_reason in ('FIXED_STOP', 'TRAILING_STOP', 'TIME_EXIT', 'KILL_FLATTEN')),
  exit_signal_bar  int,
  highest          numeric,
  trail_activated  boolean not null,
  gross            numeric not null,
  costs            numeric not null,
  net              numeric not null,
  return_pct       numeric,
  strategy_version text not null,
  cost_model       text not null,
  created_at       timestamptz not null default now()
);

alter table nifty_ascent_control  enable row level security;
alter table nifty_ascent_sessions enable row level security;
alter table nifty_ascent_events   enable row level security;
alter table nifty_ascent_orders   enable row level security;
alter table nifty_ascent_trades   enable row level security;
