-- Incremental migration: adds max_consecutive_losses to the existing
-- options_autotrade_settings row. Safe to run once against a database
-- that already has this table — ADD COLUMN IF NOT EXISTS is a no-op if
-- already applied, and the daily risk lock already defaults this in code
-- if the column happened to read null.
--
-- options_autotrade_daily_stats.locked/lock_reason already exist
-- (migration 002) — this is the first migration to actually WRITE them;
-- no schema change needed there.

alter table options_autotrade_settings add column if not exists max_consecutive_losses integer not null default 3;
