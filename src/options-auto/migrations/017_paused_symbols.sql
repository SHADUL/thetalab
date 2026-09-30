-- Per-symbol NEW-entry pause, independent of execution_mode. Additive only.
--
-- execution_mode ('OFF') is account-wide and already the kill switch for
-- everything; this is a lighter, narrower control — "stop opening NEW
-- BANKNIFTY positions, but keep NIFTY/SENSEX scanning and keep managing
-- (re-quoting/closing) any BANKNIFTY position already open" — a real,
-- explicit request (paused symbols, not a hard stop), so it gets its own
-- column rather than overloading execution_mode or a symbol-specific
-- kill switch neither of which can express "just this one symbol, just
-- new entries."
alter table options_autotrade_settings
  add column if not exists paused_symbols text[] not null default '{}';
