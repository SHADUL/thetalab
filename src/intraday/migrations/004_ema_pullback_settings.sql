-- Incremental migration: adds the 200/20 EMA Trend Pullback strategy's
-- settings columns to the existing intraday_settings row. Safe to run
-- once against a database that already has intraday_settings — every
-- ADD COLUMN below is a no-op if already applied, and api/intraday.js
-- already defaults these in code (settings.x ?? default) so nothing
-- breaks even before this runs.

alter table intraday_settings add column if not exists ema_pullback_enabled boolean not null default true;
alter table intraday_settings add column if not exists ema_pullback_interval text not null default '5minute';
alter table intraday_settings add column if not exists ema_pullback_history_days integer not null default 25;
alter table intraday_settings add column if not exists ema_pullback_min_rr numeric not null default 1.5;
