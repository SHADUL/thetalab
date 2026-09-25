-- Durable protocol start marker (live-data-capture wiring phase, Task 13).
-- The official 3-month forward-validation clock (FORWARD_VALIDATION_PROTOCOL.md)
-- must use THIS recorded timestamp, never an inferred deployment time.
--
-- Deliberately NOT auto-inserted by this migration or by any code in this
-- phase — per the task's own "the official NIFTY sample starts only AFTER
-- this wiring has passed tests and SHADOW has been explicitly activated,"
-- a row here is a genuine, explicit, separate action for later, not a
-- byproduct of shipping this schema.
create table forward_validation_runs (
  id bigint generated always as identity primary key,
  protocol_id text not null unique,
  baseline_version text not null,
  fill_model text not null,
  symbol text not null,
  started_at timestamptz not null default now(),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'STOPPED')),
  stopped_at timestamptz,
  notes text
);
alter table forward_validation_runs enable row level security;
