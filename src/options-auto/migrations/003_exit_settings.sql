-- Incremental migration: adds the exit-engine's configurable thresholds
-- to the existing options_autotrade_settings row. Safe to run once
-- against a database that already has this table — every ADD COLUMN
-- below is a no-op if already applied (IF NOT EXISTS), and the exit
-- engine already defaults these in code if a column happened to read
-- null, so nothing breaks even before this runs.
--
-- options_autotrade_positions.exit_date/exit_reason/realized_pnl already
-- exist (migration 002) — this only adds the settings knobs, since
-- nothing wrote to those position columns until the exit engine did.

alter table options_autotrade_settings add column if not exists profit_target_pct numeric not null default 50;
alter table options_autotrade_settings add column if not exists stop_loss_credit_multiple numeric not null default 2;
alter table options_autotrade_settings add column if not exists time_exit_dte integer not null default 2;
alter table options_autotrade_settings add column if not exists strike_breach_buffer_pct numeric not null default 0;
