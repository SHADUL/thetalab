-- Additive to 001 (not a change to it) — a durable checkpoint of the live
-- session accumulator's in-progress state, so a worker restart during a
-- theta4 (3-minute) G2 interval does not silently lose that partial
-- interval, and never fabricates missing observations to fill the gap.
--
-- Single row per trading day (session_date is the key); the worker loads
-- the row for today's date on startup and resumes exactly where it left
-- off, or starts fresh (with a feed gap logged, see alpha_ladder_feed_gaps)
-- if no row exists yet or today's data is missing.
create table alpha_ladder_accumulator_checkpoint (
  session_date date primary key,
  session_origin_ms bigint not null,
  -- Already-completed G2 snapshots for today (Definition 2.6) — so a
  -- restart doesn't lose the whole day's imbalance history, not just the
  -- in-progress bucket.
  aggregate_snapshots jsonb not null default '[]',
  -- The CURRENT, still-open theta4 interval's raw observations — the
  -- specific "partial bucket" this migration exists to protect.
  pending_interval_observations jsonb not null default '[]',
  last_interval_end_ms bigint not null,
  -- Definition 13.3's reference-threshold recursion state, per side —
  -- restored so classification never silently resets to "inactive."
  reference_threshold_bid jsonb not null default '{"cumulativeCount":0,"runningThreshold":0}',
  reference_threshold_ask jsonb not null default '{"cumulativeCount":0,"runningThreshold":0}',
  -- The current theta3 window's not-yet-folded observation sizes, per side.
  pending_window_observations_bid jsonb not null default '[]',
  pending_window_observations_ask jsonb not null default '[]',
  last_window_folded_at_ms bigint not null,
  updated_at timestamptz not null default now()
);
alter table alpha_ladder_accumulator_checkpoint enable row level security;
