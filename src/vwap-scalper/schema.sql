-- VWAP 3σ Mean Reversion Scalper — fresh-install schema. A standalone
-- strategy (own settings/positions/log), NOT part of src/intraday/'s
-- composite-score system — see src/vwap-scalper/types.ts's own header for
-- why. NSE/India side only; the Nasdaq/Alpaca side gets its own separate
-- tables once that integration exists.
--
-- PAPER is the only execution mode this ships with, same convention as
-- options_autotrade_settings.execution_mode and intraday_settings — no
-- deploy of this feature ever places a real order by default.

create table vwap_scalper_settings (
  id integer primary key default 1,
  execution_mode text not null default 'PAPER',  -- OFF | PAPER | ALERT_ONLY | SEMI_AUTO | AUTO
  account_equity numeric not null default 0,
  max_risk_per_trade_pct numeric not null default 1,
  max_daily_loss_pct numeric not null default 3,
  max_open_positions integer not null default 3,
  max_consecutive_losses integer not null default 3,

  -- Strategy parameters — see src/vwap-scalper/types.ts's VwapScalperParams,
  -- which these map onto directly.
  stdev_multiplier numeric not null default 1.0,
  entry_mode text not null default 'REJECTION',   -- TOUCH | REJECTION | CANDLE_REVERSAL
  -- Target floor: the effective target becomes whichever is FARTHER from
  -- entry between VWAP and entry ± this-many × riskPerUnit (see
  -- targetAndStop.ts's computeEffectiveTarget). 0/null falls back to a
  -- pure VWAP target (the original behavior) — this requires a real stop
  -- to mean anything, same "excluded, not fabricated" discipline as
  -- position sizing itself.
  min_reward_risk_multiple numeric not null default 2,
  slope_filter_enabled boolean not null default false,
  slope_filter_lookback_bars integer not null default 10,
  slope_filter_threshold_sigma numeric not null default 1.0,
  trend_filter_enabled boolean not null default false,
  trend_filter_ema_length integer not null default 200,
  stop_loss_enabled boolean not null default false,
  stop_loss_mode text not null default 'BEYOND_3SIGMA', -- PERCENTAGE | BEYOND_3SIGMA
  stop_loss_percent numeric not null default 0.5,
  stop_loss_sigma_buffer numeric not null default 0.5,

  updated_at timestamptz not null default now()
);
insert into vwap_scalper_settings (id) values (1) on conflict (id) do nothing;

create table vwap_scalper_positions (
  id bigint generated always as identity primary key,
  symbol text not null,              -- NSE tradingsymbol, e.g. RELIANCE
  status text not null default 'ACTIVE',   -- ACTIVE | CLOSED
  direction text not null,           -- LONG | SHORT
  quantity integer not null,
  entry_price numeric not null,
  vwap_at_entry numeric not null,
  stop_price numeric,
  entry_bar_time timestamptz not null,
  exit_price numeric,
  exit_reason text,                 -- TARGET | STOP | SESSION_END | KILL_SWITCH
  exit_bar_time timestamptz,
  realized_pnl numeric,
  unrealized_pnl numeric,
  unrealized_pnl_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vwap_scalper_positions_status_idx on vwap_scalper_positions (status);

create table vwap_scalper_daily_stats (
  trade_date date primary key,
  trades_taken integer not null default 0,
  realized_pnl numeric not null default 0,
  consecutive_losses integer not null default 0,
  locked boolean not null default false,
  lock_reason text
);

create table vwap_scalper_log (
  id bigint generated always as identity primary key,
  level text not null,               -- info | error
  message text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index vwap_scalper_log_created_idx on vwap_scalper_log (created_at desc);

alter table vwap_scalper_settings enable row level security;
alter table vwap_scalper_positions enable row level security;
alter table vwap_scalper_daily_stats enable row level security;
alter table vwap_scalper_log enable row level security;
