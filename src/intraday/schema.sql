-- Intraday Trader — a completely separate module from the Swing Scanner
-- (own tables, own section), sharing only the Kite session (kite_session,
-- already in src/swing/schema.sql) and the stocks/daily_ohlcv liquidity
-- data already backfilled for swing, per the instruction not to duplicate
-- existing infrastructure.

-- Singleton settings — execution mode defaults to PAPER and stays there
-- until explicitly changed; nothing here can silently enable live orders.
create table intraday_settings (
  id integer primary key default 1,
  enabled boolean not null default false,
  execution_mode text not null default 'PAPER', -- 'PAPER' | 'ALERT' | 'SEMI_AUTO' | 'AUTO'
  capital numeric not null default 0,
  risk_pct_per_trade numeric not null default 0.5,
  max_capital_pct_per_trade numeric not null default 20,
  max_daily_loss_pct numeric not null default 2,
  max_trades_per_day integer not null default 5,
  max_consecutive_losses integer not null default 3,
  max_open_positions integer not null default 3,
  max_positions_per_sector integer not null default 1,
  min_score numeric not null default 70,
  auto_execute_min_score numeric not null default 85,
  min_risk_reward numeric not null default 1.5,
  min_rvol numeric not null default 1.0,
  max_extension_atr numeric not null default 2.5,
  square_off_time text not null default '15:15',
  updated_at timestamptz not null default now(),
  constraint intraday_settings_singleton check (id = 1)
);
insert into intraday_settings (id) values (1);

-- Per-trading-day counters the Risk Engine reads to enforce §28's daily
-- limits — a separate row per date so history isn't overwritten.
create table intraday_daily_stats (
  date date primary key,
  trades_taken integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  gross_pnl numeric not null default 0,
  consecutive_losses integer not null default 0,
  locked boolean not null default false,
  lock_reason text
);

-- Every signal the engine produced, confirmed or not — the audit trail
-- (spec §38/§55): "signal_components" holds the full factor breakdown so
-- "why did/didn't this fire" is never a guess after the fact.
create table intraday_signals (
  id bigint generated always as identity primary key,
  symbol text not null,
  sector text,
  direction text not null,               -- 'LONG' | 'SHORT'
  status text not null,                  -- 'WATCH' | 'FORMING' | 'SIGNAL_CONFIRMED' | 'MISSED' | ...
  score numeric not null,
  confidence text not null,              -- 'A_PLUS' | 'A' | 'B' | 'WATCH' | 'IGNORE'
  setup_type text,
  entry numeric,
  stop numeric,
  target1 numeric,
  target2 numeric,
  risk_reward numeric,
  market_regime text,
  signal_components jsonb,               -- full factor/checklist breakdown
  created_at timestamptz not null default now()
);
create index intraday_signals_created_idx on intraday_signals(created_at desc);

-- Paper (or, later, real) positions. protection/exit fields mirror the
-- Swing Auto-Trade positions table's shape deliberately, for the same
-- reasons documented there — this is a different concept (intraday,
-- square-off same day) but the same "one row per position, full
-- lifecycle" pattern.
create table intraday_positions (
  id bigint generated always as identity primary key,
  signal_id bigint references intraday_signals(id),
  symbol text not null,
  sector text,
  direction text not null,
  status text not null default 'OPEN',   -- 'OPEN' | 'CLOSED'
  mode text not null,                    -- 'PAPER' | 'LIVE'
  entry_time timestamptz not null default now(),
  entry_price numeric not null,
  shares numeric not null,
  stop numeric,
  target1 numeric,
  target2 numeric,
  score_at_entry numeric,
  setup_type text,
  market_regime_at_entry text,
  exit_time timestamptz,
  exit_price numeric,
  exit_reason text,                      -- 'TARGET1' | 'TARGET2' | 'STOP' | 'TRAIL' | 'EOD_SQUAREOFF' | 'MANUAL' | 'MOMENTUM_FAILURE'
  r_multiple numeric,
  pnl numeric
);
create index intraday_positions_status_idx on intraday_positions(status);

-- One row per run of src/intraday/scripts/runBacktest.ts (spec §46) —
-- optional: the script writes this best-effort and degrades gracefully
-- if this table doesn't exist yet, so it isn't required to use the
-- backtest engine itself, only to keep a history of past runs.
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

alter table intraday_settings enable row level security;
alter table intraday_daily_stats enable row level security;
alter table intraday_signals enable row level security;
alter table intraday_positions enable row level security;
alter table intraday_backtest_runs enable row level security;
