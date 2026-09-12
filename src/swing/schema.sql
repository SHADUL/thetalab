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
  entry_swing_score numeric
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
alter table alert_rules enable row level security;
alter table alert_events enable row level security;
