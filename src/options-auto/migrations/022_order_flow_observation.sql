-- Order-flow OBSERVE-ONLY experiment. Additive; nothing here can affect an
-- order. A missing column is read as OBSERVE and a missing table as
-- "observation not persisted" — never as an enforced behavior.

alter table options_autotrade_settings
  add column if not exists order_flow_confirmation_mode text not null default 'OBSERVE'
  check (order_flow_confirmation_mode in ('OFF', 'OBSERVE'));

create table if not exists options_order_flow_confirmation_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  symbol text not null,
  expiry date not null,
  bucket_start timestamptz not null,      -- one row per (symbol, expiry, minute)
  scan_id text,
  mode text not null,
  raw_risk_reversal numeric,
  rr_direction text,                      -- bullish | bearish | neutral | UNAVAILABLE
  trend_regime text,                      -- existing trend classifier state at scan time
  g1 numeric, a1 numeric, d1 smallint,
  g2 numeric, a2 numeric, d2 smallint,
  d2_basis text,                          -- crossing | cutoff_area | running_area (provisional)
  alignment text,                         -- Alpha Ladder: ALIGNED | DIVERGENT | null
  flow_raw text,                          -- variant A: raw d1/d2 -> bullish | bearish | mixed | unavailable
  flow_alpha_d text,                      -- variant B: Alpha Ladder final D, as a feature
  match_raw text,                         -- MATCH | CONFLICT | NOT_COMPARABLE (RR vs variant A)
  match_alpha_d text,                     -- RR vs variant B
  current_structure text,                 -- what the RR-only rule chose (and the bot traded)
  hypothetical_structure_raw text,        -- recorded only; never acted on
  hypothetical_structure_alpha_d text,
  feature_available boolean,
  feature_reason text,                    -- OK | NO_FEATURE_ROW | STALE | WRONG_SESSION_DATE | G1_NOT_ACTIVE
  feature_age_sec integer,
  feature_session_valid boolean,
  feature_created_at timestamptz,
  unique (symbol, expiry, bucket_start)
);
create index if not exists options_order_flow_confirmation_log_time_idx on options_order_flow_confirmation_log (created_at desc);
alter table options_order_flow_confirmation_log enable row level security;

-- Links an opened position to its observation so final P&L can be joined
-- once the position closes (positions table itself is untouched).
create table if not exists options_order_flow_position_link (
  position_id bigint primary key,
  scan_id text,
  symbol text not null,
  expiry date not null,
  execution_mode text,
  created_at timestamptz not null default now()
);
alter table options_order_flow_position_link enable row level security;
