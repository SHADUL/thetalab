-- Broker-reconciliation allowlist for known, deliberately-manual positions.
-- Additive only.
--
-- Without this, ANY position placed manually at the broker (outside this
-- codebase) shows up as an ORPHAN_HEDGE/ORPHAN_SHORT finding during
-- pre-entry reconciliation and blocks EVERY new AUTO entry account-wide
-- until the human closes it back out (see brokerReconciliation.ts). This
-- lets a human explicitly say "I know about this one, it's mine" for a
-- specific tradingsymbol, so reconciliation stops treating it as an
-- unexplained state — never auto-detected or inferred, only ever set by
-- an explicit human action.
alter table options_autotrade_settings
  add column if not exists manually_allowed_tradingsymbols text[] not null default '{}';
