-- NIFTY PULSE — durable paper-trading state (Phase 4).
-- Brand-new tables only; nothing here touches existing data.
-- Apply manually in the Supabase SQL editor. Until it is applied the live
-- paper engine runs in memory only (trades are lost on restart) and the
-- dashboard shows "storage: migration not applied".
--
-- Per-second samples and raw ticks are NEVER stored here (ticks go to the
-- optional compressed recorder on the VM). Only control state, closed paper
-- trades and decision-level events.

create table if not exists nifty_pulse_control (
  id smallint primary key default 1 check (id = 1),
  config_id text not null,
  config jsonb not null,
  -- Informational only: the engine always starts OFF after a restart or a new day.
  running boolean not null default false,
  kill_switch boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists nifty_pulse_trades (
  id bigint generated always as identity primary key,
  session_day date not null,
  trade_id text not null,
  data_mode text not null check (data_mode = 'LIVE_PAPER'),
  config_key text not null,
  direction text not null,
  kind text not null,
  expiry date not null,
  short_symbol text not null,
  long_symbol text not null,
  qty integer not null,
  entry_at timestamptz not null,
  exit_at timestamptz,
  credit_pts numeric not null,
  realized_net numeric,
  exit_reason text,
  detail jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_day, trade_id)
);
create index if not exists nifty_pulse_trades_day_idx on nifty_pulse_trades (session_day desc);

create table if not exists nifty_pulse_events (
  id bigint generated always as identity primary key,
  session_day date not null,
  seq integer not null,
  at timestamptz not null,
  kind text not null,
  title text not null,
  detail text,
  direction text,
  trade_id text,
  created_at timestamptz not null default now()
);
create index if not exists nifty_pulse_events_day_idx on nifty_pulse_events (session_day desc, seq);
-- server/logRetention.ts prunes this table after 30 days.

-- Server (service role) only; the browser never reads these tables directly.
alter table nifty_pulse_control enable row level security;
alter table nifty_pulse_trades enable row level security;
alter table nifty_pulse_events enable row level security;
