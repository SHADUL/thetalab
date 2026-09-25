# BASELINE_V1 — Frozen Strategy Configuration

**Every number below is the current, unmodified production default**, sourced directly from
`src/options-auto/schema.sql`, `src/quant/strategies/regimeSelect.ts`,
`src/quant/strategies/strikeOptimizer.ts`, `src/quant/strategies/decisionGate.ts`,
`src/quant/execution/exitEngine.ts`, and `src/quant/strategies/positionSizing.ts`, as of this phase.
**Nothing here has been changed or tuned by any phase of this work.** Any future research result
must cite this exact file (or a later, explicitly-versioned `BASELINE_V2` etc.) rather than assume
"the current defaults," so a result stays interpretable even after production defaults eventually
do change.

| Parameter | Value | Source |
|---|---|---|
| Skew threshold (25-delta risk reversal) | ±1.5 vol points (0.015) | `regimeSelect.ts: DEFAULT_SKEW_THRESHOLD` |
| Short-strike delta targets explored | 0.10, 0.16, 0.20, 0.25, 0.30 | `strikeOptimizer.ts: DEFAULT_DELTA_TARGETS` |
| Wing widths explored | 2×, 4×, 6× the chain's own strike step | `strikeOptimizer.ts` (used via `expirySelector`/`simulate.ts`) |
| Min DTE | 2 | `options_autotrade_settings.min_dte` |
| Max DTE | 60 | `options_autotrade_settings.max_dte` |
| NO_TRADE threshold | score < 70 | `options_autotrade_settings.no_trade_below` |
| WATCH threshold | score < 80 | `options_autotrade_settings.watch_below` |
| HIGH_CONVICTION threshold | score ≥ 90 | `options_autotrade_settings.high_conviction_at_or_above` |
| Profit target | 50% of max credit captured | `options_autotrade_settings.profit_target_pct` |
| Stop loss (credit multiple) | 2× credit collected | `options_autotrade_settings.stop_loss_credit_multiple` |
| Time exit | ≤ 2 DTE | `options_autotrade_settings.time_exit_dte` |
| Strike-breach buffer | 0% | `options_autotrade_settings.strike_breach_buffer_pct` |
| Max risk per trade | 2% of equity | `options_autotrade_settings.max_risk_per_trade_pct` |
| Max daily loss | 4% of equity | `options_autotrade_settings.max_daily_loss_pct` |
| Max weekly loss | 8% of equity | `options_autotrade_settings.max_weekly_loss_pct` |
| Max portfolio risk | 10% of equity | `options_autotrade_settings.max_portfolio_risk_pct` |
| Max margin utilization | 60% of available funds | `options_autotrade_settings.max_margin_utilization_pct` |
| Max concurrent positions | 5 | `options_autotrade_settings.max_positions` |
| Max consecutive losses (daily lock) | 3 | `options_autotrade_settings.max_consecutive_losses` |
| Max underlying delta | ±300 | `options_autotrade_settings.max_underlying_delta` |
| Max gamma | ±50 | `options_autotrade_settings.max_gamma` |
| Max vega | ±5000 | `options_autotrade_settings.max_vega` |
| Max correlated-group risk | 6% of equity | `options_autotrade_settings.max_correlated_group_risk_pct` |
| Trade Quality Score weights | premiumEdge 20, independentEv 20, ivRank 12, strikeSafety 13, riskReward 8, dte 8, liquidity 8, pop 7, marginEfficiency 4 | `tradeQualityScore.ts: DEFAULT_TRADE_QUALITY_WEIGHTS` |

## Machine-readable copy

A frozen, importable snapshot of the risk-limit subset of this table (the part actually consumed by
`computePositionSize`/`checkDailyRiskLock` in code) lives at
`src/options-auto/backtest/baselineV1.ts` — imported by this phase's walk-forward runner so the
exact numbers used are guaranteed to match this document, not re-typed by hand into a script.

## Versioning rule

Every research report produced by this or a later phase must state `BASELINE_V1` (or a future
explicitly-named successor) in its own header. No report may say "current defaults" without naming
which frozen file that means.
