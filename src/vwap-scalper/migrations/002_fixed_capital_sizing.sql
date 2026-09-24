-- Adds fixed-capital-per-trade sizing as an alternative to the existing
-- risk-based sizing — see positionSizing.ts's computeFixedCapitalPositionSize
-- and this migration's own schema.sql comment for why these are two
-- genuinely different philosophies, not variants of one.

alter table vwap_scalper_settings add column if not exists sizing_mode text not null default 'RISK_BASED';
alter table vwap_scalper_settings add column if not exists capital_per_trade numeric not null default 20000;
