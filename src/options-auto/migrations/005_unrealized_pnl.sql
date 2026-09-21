-- position-monitor's exit engine already computes a real, live
-- mark-to-market cost-to-close for every ACTIVE position on its 5-minute
-- cron (re-quoting every leg via Kite) — but until now that number only
-- existed transiently in memory to decide whether to CLOSE the position,
-- and was discarded otherwise. The dashboard's positions table had
-- nothing to show for an open position but "—" under Realized P&L, which
-- is correct (realized_pnl is only ever set on close) but left genuinely
-- no P&L visible for anything still open.
--
-- unrealized_pnl_updated_at is stored alongside the number itself so the
-- UI can show how stale the figure is (it's only as fresh as the last
-- 5-minute position-monitor run, and stops updating entirely once
-- execution_mode is OFF or Kite session is missing) rather than implying
-- a live tick.

alter table options_autotrade_positions add column if not exists unrealized_pnl numeric;
alter table options_autotrade_positions add column if not exists unrealized_pnl_updated_at timestamptz;
