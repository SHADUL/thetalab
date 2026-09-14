-- Swing Scanner — v1 schema (Supabase / Postgres).
--
-- Date-keyed on every table, even where v1 only ever reads "today's" row —
-- that's what makes score history (spec §38, "65 -> 71 -> 76 -> 83 -> 91")
-- and the backtest engine (spec §31) possible later without a migration.
-- Nothing here is NSE/BSE-specific beyond the `exchange` column, so a second
-- universe is just more rows, not a new table.

create table stocks (
  symbol text primary key,              -- Kite trading symbol, e.g. 'RELIANCE'
  exchange text not null default 'NSE',
  name text,
  sector text,
  instrument_token bigint,              -- Kite's numeric id, needed for historical-candle calls
  isin text,
  market_cap numeric,
  active boolean not null default true, -- false once delisted/suspended — never deleted, so
                                         -- historical rows referencing it stay valid
  last_synced_at timestamptz
);

create table daily_ohlcv (
  symbol text not null references stocks(symbol),
  date date not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume bigint not null,
  primary key (symbol, date)
);
create index daily_ohlcv_date_idx on daily_ohlcv(date);

create table weekly_ohlcv (
  symbol text not null references stocks(symbol),
  week_start date not null,             -- Monday of the week
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume bigint not null,
  primary key (symbol, week_start)
);

-- One row per symbol per trading day — the full indicator readout for that
-- day. Populated by the nightly job; the scanner UI reads only the latest
-- date, the backtest engine reads the whole history.
create table indicators (
  symbol text not null references stocks(symbol),
  date date not null,
  ema20 numeric, ema50 numeric, ema100 numeric, sma200 numeric,
  rsi14 numeric,
  adx14 numeric, plus_di numeric, minus_di numeric,
  atr14 numeric, atr_pct numeric,
  macd numeric, macd_signal numeric, macd_histogram numeric,
  bb_upper numeric, bb_lower numeric, bb_bandwidth_pct numeric,
  vol_avg20 numeric, vol_avg50 numeric, vol_ratio numeric,
  high_52w numeric, low_52w numeric, high_ath numeric,
  dist_52w_high_pct numeric, dist_ath_pct numeric,
  rs_vs_nifty_5d numeric, rs_vs_nifty_20d numeric, rs_vs_nifty_60d numeric, rs_vs_nifty_120d numeric,
  rs_vs_sector_20d numeric,
  primary key (symbol, date)
);

-- The composite score, factor breakdown, and setup classification for one
-- symbol on one day. This table IS the score-history feature (spec §38) —
-- reading every row for a symbol, ordered by date, is "65 -> 71 -> 76 -> 83".
create table swing_scores (
  symbol text not null references stocks(symbol),
  date date not null,
  trend_score numeric not null,
  momentum_score numeric not null,
  relative_strength_score numeric not null,
  setup_score numeric not null,
  volume_score numeric not null,
  sector_score numeric not null,
  volatility_score numeric not null,
  risk_reward_score numeric not null,
  swing_score numeric not null,
  setup_type text,                      -- 'BREAKOUT' | 'MOMENTUM' | 'PULLBACK' | ...
  entry_status text,                    -- 'BUY_ZONE' | 'NEAR_ENTRY' | 'EXTENDED' | ...
  extension_risk text,                  -- 'LOW' | 'MEDIUM' | 'HIGH'
  entry numeric,                        -- the trade plan (spec §20) — persisted here, not
  stop numeric,                         -- recomputed per API request, since that would mean
  target numeric,                       -- re-fetching full price history for every symbol on
  risk_reward numeric,                  -- every page load just to redisplay numbers already known
  preset text not null default 'balanced', -- which weighting produced this row (spec §22/§57)
  primary key (symbol, date, preset)
);
create index swing_scores_date_score_idx on swing_scores(date, swing_score desc);

-- Sector-level rollup, one row per sector per day (spec §15).
create table sector_strength (
  sector text not null,
  date date not null,
  return_5d numeric, return_20d numeric, return_60d numeric,
  pct_above_20ema numeric, pct_above_50ema numeric,
  breadth_score numeric,
  primary key (sector, date)
);

-- Market regime (spec §3), one row per day.
create table market_regime (
  date date primary key,
  nifty_close numeric,
  nifty_above_20ema boolean, nifty_above_50ema boolean, nifty_above_200sma boolean,
  india_vix numeric,
  pct_stocks_above_20ema numeric, pct_stocks_above_50ema numeric, pct_stocks_above_200sma numeric,
  -- Nullable, not required: this table is filled in multiple passes
  -- (nifty_close first, from existing options data; breadth/EMA/regime
  -- classification later, once there's a reason to compute them daily
  -- rather than backfill once) — a row mid-backfill legitimately has this
  -- unset, and that's a different thing from a data error.
  regime text                           -- 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'CAUTIOUS' | 'BEARISH'
);

-- User-facing state — watchlist and alerts (spec §37/§39). No multi-user
-- concept anywhere else in this app, so no user_id column; add one only if
-- that ever changes.
create table watchlist (
  symbol text primary key references stocks(symbol),
  added_at timestamptz not null default now(),
  note text,
  -- Captured at add time so performance-since-added (spec §46's "ACTIVE
  -- SWINGS" view) has something to measure from — without these, "how has
  -- this done since I added it" has no starting point to compare against.
  entry_date date,
  entry_price numeric,
  entry_swing_score numeric,
  -- How many shares this position was sized at, computed client-side at
  -- add time from swing_settings' fund + risk% and this stock's stop
  -- distance (never a guessed flat count) — captured once, same as the
  -- other entry_* columns.
  shares numeric
);

-- Singleton: one fund, one risk-per-trade %, read by the position-sizing
-- calculation before a stock is added to the watchlist. Not per-symbol —
-- deliberately global, same "no multi-user concept" reasoning as every
-- other table here.
create table swing_settings (
  id integer primary key default 1,
  total_fund numeric not null default 0,
  risk_pct numeric not null default 5,
  updated_at timestamptz not null default now(),
  constraint swing_settings_singleton check (id = 1)
);
insert into swing_settings (id) values (1);

-- Auto-trade: a separate reserved pool of capital and risk %, deliberately
-- not the same as swing_settings' fund — manual "Add to Portfolio" adds
-- and bot-placed trades must not compete for the same money. `enabled` is
-- the master kill switch: defaults false, so a deploy of this feature
-- never starts placing real orders until a human flips it on.
create table auto_trade_settings (
  id integer primary key default 1,
  enabled boolean not null default false,
  reserved_fund numeric not null default 0,
  risk_pct numeric not null default 5,
  max_positions integer not null default 5,
  preset text not null default 'balanced',
  updated_at timestamptz not null default now(),
  constraint auto_trade_settings_singleton check (id = 1)
);
insert into auto_trade_settings (id) values (1);

-- Kite's access_token normally lives ONLY in the browser's HttpOnly cookie
-- (kite-callback.js) so the server never holds it. The auto-trader is a
-- cron-driven backend job with no browser attached, so it needs its own
-- copy — persisted here after each morning login, same short daily
-- lifetime as the cookie. This is a materially smaller exposure than
-- storing a password/TOTP (already ruled out elsewhere in this schema's
-- history): the token already exists in plaintext in the browser, expires
-- same-day, and this table is only ever touched by service_role.
create table kite_session (
  id integer primary key default 1,
  access_token text,
  obtained_at timestamptz,
  constraint kite_session_singleton check (id = 1)
);
insert into kite_session (id) values (1);

-- One row per bot-placed position. Separate from `watchlist` (manual,
-- no broker order/GTT ids, no protection state) — different lifecycle,
-- different concept, same "don't overload one table" reasoning as every
-- other portfolio-shaped table here.
create table auto_trade_positions (
  id bigint generated always as identity primary key,
  symbol text not null references stocks(symbol),
  status text not null default 'OPEN',      -- 'OPEN' | 'CLOSED'
  entry_order_id text,
  gtt_id bigint,                             -- set when the two-leg GTT (stop+target) placed cleanly
  stop_order_id text,                        -- set only on the SL-M fallback path, when GTT placement failed
  protection text not null default 'NONE',   -- 'GTT' | 'SL_ONLY' | 'NONE' — what's actually guarding this position
  entry_date date not null,
  entry_price numeric not null,
  entry_swing_score numeric,
  shares numeric not null,
  stop numeric,
  target numeric,
  exit_date date,
  exit_price numeric,
  exit_reason text,                          -- 'TARGET' | 'STOP' | 'MANUAL' | 'GTT_TRIGGERED' | ...
  created_at timestamptz not null default now()
);
create index auto_trade_positions_status_idx on auto_trade_positions(status);

-- Append-only audit trail — every order placed, every skip, every
-- failure. This IS the transparency mechanism for a system placing real
-- money orders unattended: the UI's activity log is a straight read of
-- this table, nothing summarized away.
create table auto_trade_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  level text not null default 'info',        -- 'info' | 'error'
  message text not null,
  detail jsonb
);

-- One row per run of src/swing/scripts/runBacktest.ts (spec §31-34) — the
-- aggregate result (overall + by score bucket + by regime + by setup
-- type, per preset), not per-trade rows. Trade-level storage can be added
-- later if drill-down into individual signals is wanted; the summary is
-- what the UI/reporting needs today.
create table backtest_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  params jsonb not null,
  summary jsonb not null
);

create table alert_rules (
  id bigint generated always as identity primary key,
  symbol text references stocks(symbol),   -- null = applies to every scanned symbol
  kind text not null,                      -- 'SCORE' | 'BREAKOUT' | 'ATH' | 'VOLUME' | 'ENTRY' | 'SCORE_ACCEL'
  threshold numeric,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table alert_events (
  id bigint generated always as identity primary key,
  rule_id bigint references alert_rules(id),
  symbol text not null references stocks(symbol),
  fired_at timestamptz not null default now(),
  detail jsonb
);

-- RLS, enabled everywhere, with zero policies attached — deliberately.
-- Every table Supabase creates is reachable over its public REST API using
-- the anon key unless RLS says otherwise; this app has no legitimate
-- client-side Supabase access at all (every read/write goes through Vercel
-- functions using the service_role key, which bypasses RLS regardless of
-- this setting). So this costs the planned architecture nothing today, and
-- means the anon key structurally can't touch these tables if it ever ends
-- up somewhere it shouldn't — no policy has to be remembered later, because
-- "no policy" already means "no access."
alter table stocks enable row level security;
alter table daily_ohlcv enable row level security;
alter table weekly_ohlcv enable row level security;
alter table indicators enable row level security;
alter table swing_scores enable row level security;
alter table sector_strength enable row level security;
alter table market_regime enable row level security;
alter table watchlist enable row level security;
alter table swing_settings enable row level security;
alter table auto_trade_settings enable row level security;
alter table kite_session enable row level security;
alter table auto_trade_positions enable row level security;
alter table auto_trade_log enable row level security;
alter table backtest_runs enable row level security;
alter table alert_rules enable row level security;
alter table alert_events enable row level security;
