-- Direction confirmation (RR + trend). Additive; safe to apply while the
-- app runs — the code treats a missing column as RR_TREND_OBSERVE and a
-- missing table as "telemetry not persisted", never as ENFORCED.

alter table options_autotrade_settings
  add column if not exists direction_confirmation_mode text not null default 'RR_TREND_OBSERVE'
  check (direction_confirmation_mode in ('RR_ONLY', 'RR_TREND_OBSERVE', 'RR_TREND_ENFORCED'));

create table if not exists options_direction_confirmation_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- one row per (symbol, expiry, minute): the scan runs every ~30s
  symbol text not null,
  expiry date not null,
  bucket_start timestamptz not null,
  scan_id text,
  mode text not null,
  dte integer,
  raw_risk_reversal numeric,          -- call IV - put IV at 25 delta, as a fraction (0.02 = 2 vol points)
  rr_direction text,                  -- bullish | bearish | neutral | UNAVAILABLE
  trend_state text,                   -- STRONG_BULLISH..STRONG_BEARISH | UNKNOWN
  trend_stale boolean,
  trend_age_days integer,
  trend_as_of date,
  trend_value jsonb,
  trend_source text,
  alignment text,
  original_structure text,            -- what the RR-only rule chose
  proposed_structure text,            -- Version C (full matrix) — what ENFORCED would do
  proposed_structure_b text,          -- Version B (no strong-trend veto) — comparison only
  decision text,                      -- CONFIRMED | IC_CANDIDATE | NO_TRADE
  reason_code text,
  reason text,
  optimizer_original jsonb,
  optimizer_proposed jsonb,
  score_original numeric,
  score_proposed numeric,
  entry_eligible_original boolean,
  entry_eligible_proposed boolean,
  unique (symbol, expiry, bucket_start)
);
create index if not exists options_direction_confirmation_log_time_idx on options_direction_confirmation_log (created_at desc);
alter table options_direction_confirmation_log enable row level security;
