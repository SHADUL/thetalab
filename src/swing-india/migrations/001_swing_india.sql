-- Swing Trading (swing-india) — paper-trading tracker state.
-- Run once in the Supabase SQL editor. Service-role access only (RLS on, no policies).

create table if not exists swing_india_state (
  id integer primary key default 1,
  capital numeric not null default 500000,
  risk_pct numeric not null default 1 check (risk_pct > 0 and risk_pct <= 1),
  learnings jsonb,                 -- compiled rules (null until first compile with N >= 10)
  learnings_md text,               -- human-readable learnings file
  changelog jsonb not null default '[]'::jsonb,
  compiled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint swing_india_state_singleton check (id = 1)
);
insert into swing_india_state (id) values (1) on conflict (id) do nothing;

create table if not exists swing_india_positions (
  id bigint generated always as identity primary key,
  symbol text not null,
  sector text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED', 'OPEN', 'CLOSED', 'DISCARDED')),
  verdict text,
  score numeric,
  cmp_at_scan numeric,
  entry numeric not null,
  stop numeric not null,
  initial_stop numeric not null,
  t1 numeric not null,
  t2 numeric not null,
  qty integer not null check (qty > 0),
  atr numeric,
  setup jsonb,                     -- technicals at analysis time (rsi14, adx14, dmaPct, ...)
  created_at timestamptz not null default now(),
  opened_at date,
  closed_at timestamptz,
  exit_price numeric,
  exit_reason text,
  r_multiple numeric,
  pnl_inr numeric,
  days_held integer,
  outcome text,
  postmortem text
);
create index if not exists swing_india_positions_status_idx on swing_india_positions (status);

create table if not exists swing_india_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  type text not null,              -- scan | run | open | close | compile | trail
  ticker text,
  payload jsonb not null
);
create index if not exists swing_india_log_at_idx on swing_india_log (at desc);

alter table swing_india_state enable row level security;
alter table swing_india_positions enable row level security;
alter table swing_india_log enable row level security;
