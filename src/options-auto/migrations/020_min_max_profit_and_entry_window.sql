-- Two risk/timing guards the user asked for directly after spotting a
-- real GROWW AUTO entry whose max profit (~Rs853) wasn't worth the
-- round-trip charges once sized for a 50% profit-target exit:
--
-- 1. min_max_profit_rupees: a new entry is skipped outright if its SIZED
--    (post-lot-scaling) max profit falls below this floor — the economic
--    reality is that a 50% profit-target exit on a tiny max-profit
--    structure barely covers brokerage/STT/charges, let alone being worth
--    the risk and margin tied up.
-- 2. entry_window_start_minutes_ist: no NEW entries before this time
--    (minutes since IST midnight; 585 = 09:45) — explicitly scoped to new
--    entries only, never to managing or closing existing positions,
--    which keep running on their own exit logic regardless.
alter table options_autotrade_settings
  add column if not exists min_max_profit_rupees numeric not null default 2000,
  add column if not exists entry_window_start_minutes_ist integer not null default 585;
