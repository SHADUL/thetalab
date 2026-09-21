-- Incremental migration: adds the settings/positions/legs/log/daily-stats
-- tables for the paper-execution orchestrator. Safe to run once against
-- the existing production database — every table here is brand new,
-- nothing touches options_instruments (created in 001) or any other
-- existing data.

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
  updated_at timestamptz not null default now(),
  constraint options_autotrade_settings_singleton check (id = 1)
);
insert into options_autotrade_settings (id) values (1);

create table options_autotrade_positions (
  id bigint generated always as identity primary key,
  symbol text not null,
  strategy_label text not null,
  expiry date not null,
  status text not null default 'ACTIVE',
  execution_state text not null,
  protection text not null,
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index options_autotrade_positions_status_idx on options_autotrade_positions (status);

create table options_autotrade_legs (
  id bigint generated always as identity primary key,
  position_id bigint not null references options_autotrade_positions(id),
  side text not null,
  option_right text not null,
  strike numeric not null,
  tradingsymbol text not null,
  quantity integer not null,
  fill_price numeric not null,
  status text not null
);
create index options_autotrade_legs_position_idx on options_autotrade_legs (position_id);

create table options_autotrade_log (
  id bigint generated always as identity primary key,
  level text not null default 'info',
  message text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create table options_autotrade_daily_stats (
  trade_date date primary key,
  trades_taken integer not null default 0,
  realized_pnl numeric not null default 0,
  consecutive_losses integer not null default 0,
  locked boolean not null default false,
  lock_reason text
);

alter table options_autotrade_settings enable row level security;
alter table options_autotrade_positions enable row level security;
alter table options_autotrade_legs enable row level security;
alter table options_autotrade_log enable row level security;
alter table options_autotrade_daily_stats enable row level security;
