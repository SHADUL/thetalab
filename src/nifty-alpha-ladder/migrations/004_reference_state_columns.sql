-- Additive to the existing alpha_ladder_large_order_reference table (one row
-- per side, upserted in place). Adds the source identity and bookkeeping
-- needed to carry Definition 13.3's reference state across trading days
-- safely. A row written before this migration has null source columns and is
-- treated as malformed (=> reset), never trusted.
alter table alpha_ladder_large_order_reference
  add column if not exists source_instrument_token bigint,
  add column if not exists source_tradingsymbol text,
  add column if not exists last_window_folded_at_ms bigint,
  add column if not exists strategy_version text,
  add column if not exists source_mode text;
