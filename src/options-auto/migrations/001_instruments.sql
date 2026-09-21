-- Incremental migration: creates options_instruments, the first table for
-- the new Options Auto-Trader module. Safe to run once against the
-- existing production database — this is a brand-new table, nothing here
-- touches any existing data. Numbered 001 because this is genuinely the
-- first migration for this module (unlike src/intraday/migrations, which
-- starts at 002 because its first four tables were folded directly into
-- its initial schema.sql before migrations existed for it).

create table options_instruments (
  id bigint generated always as identity primary key,
  symbol text not null,              -- NIFTY | BANKNIFTY | SENSEX
  exchange text not null,            -- NFO | BFO
  expiry date not null,
  strike numeric not null,
  option_right text not null,        -- CE | PE ("right" is a reserved word in Postgres — RIGHT JOIN)
  tradingsymbol text not null,
  instrument_token bigint not null,
  lot_size integer,
  tick_size numeric,
  last_synced_at timestamptz not null default now(),
  unique (exchange, tradingsymbol)
);
create index options_instruments_lookup_idx on options_instruments (symbol, expiry, strike, option_right);

alter table options_instruments enable row level security;
