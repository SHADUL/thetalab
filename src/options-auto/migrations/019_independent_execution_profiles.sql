-- Independent PAPER/SHADOW/AUTO execution-profile toggles, replacing the
-- old mutually-exclusive `execution_mode` enum. Fully additive:
-- `execution_mode` is left in place, unused by new code once the toggle
-- columns are populated, so this migration can be rolled back (drop the
-- new columns/constraint) without touching anything else.
--
-- Backfills the three new booleans from the CURRENT execution_mode value,
-- so applying this migration does not silently change what's running right
-- now (e.g. if execution_mode is currently 'AUTO', only auto_enabled
-- becomes true — PAPER/SHADOW stay off until someone explicitly turns them
-- on from the dashboard).

alter table options_autotrade_settings
  add column if not exists paper_enabled boolean,
  add column if not exists shadow_enabled boolean,
  add column if not exists auto_enabled boolean;

update options_autotrade_settings set
  paper_enabled = coalesce(paper_enabled, execution_mode = 'PAPER'),
  shadow_enabled = coalesce(shadow_enabled, execution_mode = 'SHADOW'),
  auto_enabled = coalesce(auto_enabled, execution_mode = 'AUTO')
where id = 1;

-- options_autotrade_daily_stats gets an execution_mode dimension so
-- PAPER/SHADOW/AUTO each track separate daily P&L / consecutive-loss risk
-- locks (previously ONE row per day shared across every mode — a bad PAPER
-- day could freeze real AUTO trading and vice versa). Existing rows are
-- tagged 'PAPER' as a one-time legacy default (an approximation for
-- history predating this column, not a retroactive re-attribution of what
-- actually ran that day) — every row written from this point forward
-- carries its true execution_mode.
alter table options_autotrade_daily_stats
  add column if not exists execution_mode text not null default 'PAPER';

alter table options_autotrade_daily_stats drop constraint if exists options_autotrade_daily_stats_pkey;
alter table options_autotrade_daily_stats add primary key (trade_date, execution_mode);
