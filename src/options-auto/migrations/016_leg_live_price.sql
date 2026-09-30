-- Per-leg live price, so the dashboard can show each leg's OWN P&L in the
-- position-detail dropdown, not just the combined position-level number
-- already in unrealized_pnl. Additive only.
--
-- Written by position-monitor's own re-quote pass (now running every ~8s,
-- see handlePositionMonitor) using the SAME live quote it already fetches
-- to compute currentCostToClose — never a second/separate price source,
-- and never fabricated when no quote was available this pass (stays null).
alter table options_autotrade_legs
  add column if not exists last_quoted_price numeric,
  add column if not exists last_quoted_at timestamptz;
