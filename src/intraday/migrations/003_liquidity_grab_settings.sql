-- Incremental migration: adds the Liquidity Grab strategy's settings
-- columns to the existing intraday_settings row. Safe to run once
-- against a database that already has intraday_settings — every
-- ADD COLUMN below is a no-op if already applied (IF NOT EXISTS), and
-- api/intraday.js already defaults these in code (settings.x ?? default)
-- so nothing breaks even before this runs.

alter table intraday_settings add column if not exists liquidity_grab_enabled boolean not null default true;
alter table intraday_settings add column if not exists liquidity_grab_interval text not null default '3minute';
alter table intraday_settings add column if not exists liquidity_grab_lookback integer not null default 20;
alter table intraday_settings add column if not exists liquidity_grab_min_rr numeric not null default 2.0;
