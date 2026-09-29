-- Dual-broker connect scaffolding: Groww alongside the existing Kite
-- integration. Additive only, no effect on any existing row.
--
-- One active broker at a time for REAL order execution (a setting, not a
-- per-position choice) — Kite stays wired in regardless for market data/
-- historical, which Groww's API cannot replace (its own 1-minute candle
-- history is capped at 3 months total, vs. Kite's multi-year depth this
-- app already backfills). See VWAP_STORAGE_MIGRATION_PLAN.md-adjacent
-- research on this — not repeated here.
alter table options_autotrade_settings
  add column if not exists active_broker text not null default 'KITE'
    check (active_broker in ('KITE', 'GROWW'));

-- Mirrors kite_session exactly (id, access_token, obtained_at) — Groww's
-- token also expires daily, just via a server-to-server mint (POST
-- /v1/token/api/access with a checksum) rather than Kite's browser OAuth
-- redirect, so no cookie is needed here; this table is the only place the
-- token lives.
create table groww_session (
  id integer primary key default 1,
  access_token text,
  obtained_at timestamptz,
  constraint groww_session_singleton check (id = 1)
);
insert into groww_session (id) values (1);
alter table groww_session enable row level security;
