# BACKTEST_LIVE_PARITY.md

**Status: verification only, per Task 7. No refactoring done.** The prior audit
(QUANT_AUDIT.md) speculated the backtester "may be a parallel implementation" of
the live scoring logic. That speculation was **wrong** — verified by reading
`src/options-auto/backtest/simulate.ts` in full and tracing every import. The
backtest **does** call into the exact same production functions for the
core decision pipeline. It does **not** call the position-sizing, pre-trade
validation, or execution/order-placement layers at all — those are simply
absent from the backtest, not reimplemented differently. Below is the exact
mapping, verified line-by-line.

## Mapping

| Live function (used by `handlePaperScan`/`handlePositionMonitor`) | Backtest function (`simulate.ts`) | Relationship |
|---|---|---|
| `normalise` (`data/adapter.ts`) | Same import, `simulate.ts:30` | **SHARED** |
| `enrichChain` (`enrich.ts`) | Same import, `simulate.ts:31` | **SHARED** |
| `evaluateExpiries` (`expirySelector.ts`) — internally runs `classifyBias` → `generateCandidates` (`strikeOptimizer.ts`, which calls `buildIronCondor`/`buildCreditSpread`) → `scoreTradeQuality` | Same import, `simulate.ts:32`, called directly at `simulate.ts:211` | **SHARED** (transitively pulls in `regimeSelect.ts`, `strikeOptimizer.ts`, `ironCondor.ts`/`creditSpread.ts`, `tradeQualityScore.ts` — none of these are reimplemented) |
| `decideTrade` (`decisionGate.ts`) | Same import, `simulate.ts:33`, called at `simulate.ts:218` | **SHARED** |
| `evaluateExit` (`execution/exitEngine.ts`) | Same import, `simulate.ts:34`, called at `simulate.ts:173` | **SHARED** |
| `computeRoundTripLegCharges` (`backtest/costs.ts`) | Same import, `simulate.ts:35`, called at `simulate.ts:136` | **SHARED** (this is backtest-only code in the first place — there is no live equivalent, since AUTO's real fills already include real charges implicitly) |
| `positionSizing.ts` (`computePositionSize`, 10 risk caps) | **not called anywhere in `simulate.ts`** | **ABSENT** — backtest trades exactly 1 lot's worth (scaled by `day.lotSize`) every time a signal fires; it never applies risk-per-trade/daily-loss/portfolio/correlated-group/Greek-exposure caps. |
| `preTradeValidation.ts` (10-check gate) | **not called anywhere in `simulate.ts`** | **ABSENT** |
| `dailyRiskLock.ts` (daily-loss / consecutive-loss lock) | **not called anywhere in `simulate.ts`** | **ABSENT** — the backtest can open a new position the very next day after a losing exit; live PAPER/AUTO cannot, once locked. |
| `execution/liveFill.ts` / `paperFill.ts` (fill simulation, BUY-before-SELL sequencing) | **not called** — `simulate.ts` computes `currentCostToClose` directly from `row.settle` (`simulate.ts:166`) and entry/exit prices directly from `best.result.legs[].price` | **ABSENT / DIFFERENT** — the backtest has its own minimal fill assumption (fills exactly at the priced candidate's leg price / at that day's settlement on exit), which is the *same* zero-slippage optimism as `paperFill.ts`, just implemented as a second, smaller piece of code rather than importing `paperFill.ts` itself. |
| `legFailureHandler.ts` / `stateMachine.ts` (partial fill / reconciliation states) | **not called** | **ABSENT** — backtest has no concept of a partially-filled leg; every entry is treated as fully filled. |
| `ivRank`/`premiumEdge`/`independentEv` wiring (`ivRankAndPercentile`, `computeIvRvEdge`, `computeIndependentExpectedValue`) | **not wired** — `simulate.ts:216` passes `ivRank: null` explicitly, and no `historicalCloses` is passed to `evaluateExpiries` at all | **ABSENT** — the backtest's Trade Quality Score is computed with `premiumEdge` and `independentEv` **excluded** (renormalized around the remaining 7 components) on every single trade, because neither an IV-rank archive nor an underlying-close history is threaded through `simulateSymbol`. This means the backtest never actually exercises 40 of the 100 score-weight points the live system uses, and any research conclusion drawn about "the effect of premium edge / independent EV" (your Phase 4-8 program) **cannot use this backtester as-is** — it needs `historicalCloses`/`ivRank` wired through before that research is meaningful. |
| `handleMargin` (live `/margins/basket`) → per-lot margin, `marginEfficiency` score component | **not called** | **ABSENT** — `marginEfficiency` is also excluded from every backtest score for the same renormalization reason. |
| Market regime (`marketRegime.ts`, diagnostic-only in live) | **not called** | **ABSENT** (consistent with live: it's diagnostic-only there too, so its absence here doesn't change trade selection either way — but it does mean Phase 5's regime-filter research needs this wired in from scratch, not adapted from something already there.) |

## What this means for the research phases you outlined

- Phases 6-8 (DTE segmentation, delta/wing research, exit research) **can**
  be trusted as testing the actual live entry/exit/scoring logic, since
  `evaluateExpiries`/`decideTrade`/`evaluateExit` are the literal same
  functions — genuinely a replay, not a parallel model, for the parts that
  are wired in.
- Phases 4 (skew normalization) and 5 (regime experiment) test signals that
  **are** computed live (skew via `classifyBias`, called transitively) but
  the backtest's Trade Quality Score currently can't reflect their full
  live weight, because premiumEdge/independentEv/ivRank/marginEfficiency are
  structurally excluded today (renormalized around what's left) — a
  DTE-bucketed comparison run today would be scoring/ranking candidates
  under a genuinely different (7-component, not 9-component) weighting than
  what's live, not just missing some historical color.
- Phase 3 (net EV) is *partially* already possible — `costs.ts` is already
  wired in and computing real net P&L per trade (`simulate.ts:121-147`) —
  but there's no slippage/partial-fill model at all (fills are exact,
  §"ABSENT / DIFFERENT" row above), so "net EV" today means "gross minus
  real transaction costs," not "gross minus real costs minus realistic
  execution slippage." Phase 1's fill-simulation modes need to be wired
  into `simulate.ts` (not just `paperFill.ts`) before Phase 3's net-EV
  ranking can be considered representative of live AUTO performance.
- Phase 9 (portfolio correlation across symbols) is not just unimplemented
  in scoring — it's structurally impossible in the current backtest, which
  holds **at most one position at a time, for one symbol at a time**
  (`simulate.ts` header, line 10-18, explicitly documented as a deliberate
  simplification). Testing cross-symbol correlated exposure requires a
  genuinely different backtest driver that runs NIFTY/BANKNIFTY/SENSEX
  concurrently against a shared capital pool — a new module, not a
  parameter change to `simulateSymbol`.

## Recommendation (not implemented — awaiting your sequencing decision)

Before Phase 4+ research produces trustworthy comparisons, `simulate.ts`
needs, in order of how much they currently distort scoring:
1. `historicalCloses` threaded through (enables `premiumEdge`/
   `independentEv` — currently the two highest-weighted, entirely absent
   components).
2. A real `ivRank` source (the existing IV-history archive is per-session,
   near-term-only per `expirySelector.ts`'s own documented limitation — may
   need its own backtest-specific historical IV series, since the archive
   likely doesn't extend far enough back for a multi-year backtest).
3. Position sizing / daily risk lock wired in, so a backtested equity curve
   reflects the same risk controls a live account actually has (currently
   every signal trades a full, unconstrained 1 lot regardless of
   account state or daily losses already taken).
4. A fill-simulation layer (Phase 1), replacing the current exact-settlement-
   price assumption.

None of this has been implemented — flagging it here so it's sequenced
deliberately rather than discovered later as a surprise in a research
result.
