-- Real order placement (AUTO mode) — see src/quant/execution/liveFill.ts
-- and api/options-autotrade.ts's makeLiveOrderPlacer. execution_mode is
-- recorded once, at open, from settings.execution_mode at that moment —
-- a position's own lifecycle must not silently become "live" or "paper"
-- retroactively just because the setting changed after it opened.
--
-- CLOSE_FAILED (a status value, not a new column) means a real closing
-- order for an AUTO position didn't confirm — deliberately excluded from
-- position-monitor's own `status = 'ACTIVE'` query so a failed unwind can
-- never be silently retried into double-closing a leg that already
-- filled; it waits for a human to reconcile against the broker directly.

alter table options_autotrade_positions add column if not exists execution_mode text not null default 'PAPER';

alter table options_autotrade_legs add column if not exists order_id text;
alter table options_autotrade_legs add column if not exists exit_order_id text;
alter table options_autotrade_legs add column if not exists exit_fill_price numeric;
