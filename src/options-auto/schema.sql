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

alter table options_autotrade_settings enable row level security;
alter table options_autotrade_positions enable row level security;
alter table options_autotrade_legs enable row level security;
alter table options_autotrade_log enable row level security;
alter table options_autotrade_daily_stats enable row level security;
