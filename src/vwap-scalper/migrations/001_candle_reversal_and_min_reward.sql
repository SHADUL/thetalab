-- Adds the CANDLE_REVERSAL entry mode's supporting settings column.
-- entry_mode itself is a plain text column with no DB-level check
-- constraint (validated in the API layer instead — see
-- handleVwapScalperSettings), so no migration is needed there; setting
-- it to 'CANDLE_REVERSAL' just works once the app code recognizes it.
--
-- min_reward_risk_multiple: the effective target becomes whichever is
-- FARTHER from entry between VWAP and entry ± this-many × riskPerUnit
-- (see targetAndStop.ts's computeEffectiveTarget). 0 falls back to a pure
-- VWAP target (the original behavior) — this only has an effect when a
-- real stop is also configured, same discipline as position sizing.

alter table vwap_scalper_settings add column if not exists min_reward_risk_multiple numeric not null default 2;
