-- Incremental migration: adds intraday_backtest_runs only (the other 4
-- intraday tables already exist from the first migration). Safe to run
-- once against the same database that already has intraday_settings/
-- intraday_daily_stats/intraday_signals/intraday_positions.

create table intraday_backtest_runs (
  id bigint generated always as identity primary key,
  symbols text[] not null,
  from_date date not null,
  to_date date not null,
  capital numeric not null,
  params jsonb,
  summary jsonb,
  created_at timestamptz not null default now()
);

alter table intraday_backtest_runs enable row level security;
