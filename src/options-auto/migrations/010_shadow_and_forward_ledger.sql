-- SHADOW mode + forward-validation ledger (FORWARD_VALIDATION_PROTOCOL.md).
-- SHADOW runs the exact live pipeline and records what AUTO would have
-- done, but sends zero broker orders — see api/options-autotrade.ts's
-- handlePaperScan for how execution_mode is branched.

-- execution_mode's set of valid values was previously enforced only by a
-- SQL comment (-- OFF | PAPER | ALERT_ONLY | SEMI_AUTO | AUTO), never a
-- real constraint. Adding SHADOW as an actual allowed value now that code
-- consumes it, without retroactively constraining the OTHER historically-
-- commented-but-never-implemented values (ALERT_ONLY/SEMI_AUTO) — this
-- migration does not add a CHECK constraint at all, matching the existing
-- column's own (deliberately permissive, comment-only) convention, so
-- adding this one real value doesn't accidentally start enforcing a
-- stricter contract than the column has ever actually had.
comment on column options_autotrade_settings.execution_mode is 'OFF | PAPER | SHADOW | AUTO — ALERT_ONLY/SEMI_AUTO were never implemented and are not currently dispatched anywhere in code.';

-- Forward-validation ledger (Task 7): one row per SHADOW signal, inserted
-- BEFORE the outcome is known (pre-trade fields only), appended with
-- outcome fields once the hypothetical position's lifecycle completes.
-- Convention (enforced at the application layer, see
-- src/quant/execution/forwardLedger.ts): after insert, the ONLY columns a
-- later write may ever set are the *_outcome-suffixed ones below — every
-- pre-trade field is written exactly once, at signal time, and never
-- touched again.
create table options_forward_validation_ledger (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  symbol text not null,
  strategy_label text not null,
  expiry date not null,
  calendar_dte integer not null,
  trading_session_horizon integer not null,
  short_delta_target numeric,
  wing_width numeric,
  net_credit numeric not null,
  estimated_max_loss numeric not null,
  estimated_pop numeric,
  expected_value numeric,
  premium_edge_pct numeric,
  independent_ev_per_unit_risk numeric,
  iv_rank numeric, -- null when unavailable at signal time — never fabricated
  liquidity_tier text,
  market_regime text,
  sizing_lots integer,
  expected_costs_rupees numeric,
  intent_id uuid references options_autotrade_order_intents(id),

  -- Outcome fields — all null at insert time, appended exactly once when
  -- the hypothetical position's lifecycle completes.
  realized_hypothetical_pnl numeric,
  max_adverse_excursion numeric,
  max_favorable_excursion numeric,
  exit_reason text,
  observed_execution_cost_estimate numeric,
  outcome_recorded_at timestamptz
);
create index options_forward_validation_ledger_lookup_idx on options_forward_validation_ledger (symbol, recorded_at);
alter table options_forward_validation_ledger enable row level security;
