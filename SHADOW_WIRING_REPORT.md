# SHADOW_WIRING_REPORT.md

**Number of actual broker orders placed during this phase's testing: 0.** No AUTO code path was
exercised against a live Kite session; every test in this report runs against in-memory mocks.

## 1. Exact files changed

**Modified**: `api/options-autotrade.ts` (SHADOW branch wired to real execution/persistence — see
§5-9), `src/quant/execution/fillSimulator.ts` (added `SHADOW_EXECUTION_V1`), `src/quant/execution/orderIntent.ts`
(widened `executionMode` type to include `'SHADOW'`).

**New**: `src/quant/execution/shadowExecution.ts`, `shadowRepository.ts`, `shadowScan.ts`,
`src/quant/analytics/dataQualityHealth.ts`, `rollingMetrics.ts`, migrations `010_shadow_and_forward_ledger.sql`,
`011_protocol_start_marker.sql`. 12 new test files, **57 new tests** (350 total quant tests, up from
293 at the start of this phase; 35 options-auto tests unchanged).

## 2. Exact DB tables written

`options_chain_snapshots`, `options_iv_history`, `options_forward_validation_ledger` — all written
from the live SHADOW path in `handlePaperScan`, batched (one insert per table per scan, not per
contract). `options_execution_quality` — **schema exists, application code to write per-leg rows
was NOT wired this phase** (see §16 limitations).

## 3. Scan snapshot path

`handlePaperScan` (SHADOW branch) → the *exact* `winningSlice.quotes` object the decision engine
already enriched → mapped straight to `OptionChainSnapshotRow[]` → `supabaseShadowRepository().insertChainSnapshots()`.
No second Kite fetch.

## 4. IV-history path

Same `winningSlice` → `atmIvOf()` (already-imported, existing function) → one row per (symbol,
expiry), deduplicated within the batch via `dedupeIvHistoryRows()` before insert.

## 5. SHADOW entry fill path

`runShadowExecutionForLegs(scaledLegs, validation, winningSlice.quotes)` — a drop-in replacement for
`runPaperExecution` used only when `isShadow`, verified to produce the **identical** `PaperFillResult`
shape and state-machine transitions (`afterSubmission`/`deriveProtectionState`/`afterProtectionConfirmed`/
`beginMonitoring` — the same real functions PAPER calls, not reimplemented), differing only in where
each leg's `fillPrice` comes from: `SHADOW_EXECUTION_V1` via `simulateStructureFill`, fed the real
live bid/ask already present in the enriched quotes.

## 6. SHADOW exit fill path

**Designed and unit/integration-tested (`runShadowExitScan` in `shadowScan.ts`) but NOT wired into
`handlePositionMonitor` this phase.** Doing so requires linking a ledger row back to its position
(a `forward_ledger_id` column + migration not yet written) — scoped out explicitly rather than
rushed; see §16.

## 7. Execution telemetry path

**Not wired this phase.** `options_execution_quality`'s schema and repository-insert method exist
and are typed/tested at the module level, but no call site in `handlePaperScan`/`handlePositionMonitor`
inserts a row yet.

## 8. Forward ledger signal path

`handlePaperScan` (SHADOW branch, post-fill) builds a `ForwardSignal` from the already-computed
`best`/`decision`/`sizing` objects (no re-derivation) → `recordSignal(supabaseForwardLedgerStore(supabase), signal)`
→ inserted with every outcome column null, before any outcome is known.

## 9. Forward ledger outcome path

**Not wired this phase** — see §6/§16. The write-discipline guarantee itself
(`recordOutcome` structurally cannot touch a pre-trade field — `ForwardSignal`/`ForwardOutcome`
share zero keys, asserted by a dedicated test) is proven and ready for when the exit wiring lands.

## 10. Official-sample eligibility rules

`isEligibleForForwardValidation()` — pure function, 8 unit tests + exercised across all 8 integration
tests. Checks baseline/fill-model drift, real bid/ask on every leg, quote freshness, snapshot/ledger
write success, no known ingestion bug, no broker order placed. A failing signal is never deleted —
`handlePaperScan` computes and logs `eligibleForForwardValidation`/`eligibilityReasons` for every
SHADOW signal (`SHADOW_SIGNAL_RECORDED` event).

## 11. Protocol start mechanism

`src/options-auto/migrations/011_protocol_start_marker.sql` — `forward_validation_runs` table.
**Deliberately not auto-populated by this phase** — inserting the first row (starting the official
3-month clock) is an explicit, separate action for after you've reviewed this wiring, per the
phase's own stop condition (§20: "Do NOT claim forward validation has begun until... the protocol
start marker has been explicitly created").

## 12. Failure behavior

| Failure | Behavior | Consequence |
|---|---|---|
| Snapshot insert fails | SOFT_FAIL, caught, logged | Signal still recorded; marked ineligible for official sample |
| IV-history insert fails | SOFT_FAIL, caught | Signal still recorded; does not by itself affect eligibility |
| Ledger signal insert fails | Propagates (not caught in the orchestrator's own test; the API's `try/catch` around it does swallow it, logging `ledgerOk=false`) | Signal marked ineligible; no position/log corruption |
| Leg missing bid or ask | `hasRealBidAsk=false`; a diagnostic fill is still produced, never discarded | Ineligible for official sample, stored for inspection |
| Stale quote | Fails `runPreTradeValidation` | `DATA_INVALID`/`NO_TRADE` — nothing recorded at all |
| Duplicate scan invocation | Handled by the EXISTING order-intent lock (unchanged this phase) — `shadowScan.ts`'s own orchestrator has no dedup of its own by design | Second invocation gets `CONFLICT`, zero further action, exactly as AUTO already does |
| Handler timeout/retry | Not separately tested this phase (inherits the existing order-intent/reconciliation machinery, unchanged) | — |

In every case: **zero broker order calls** — structurally impossible, since no dependency in the
SHADOW path is shaped like a `placeOrder` function.

## 13. Test results

**350 quant tests pass, 35 options-auto tests pass** (up from 293/24 at the start of this multi-
phase effort). 57 new tests this phase across 12 files, including a full entry→exit round-trip
integration test and 8 dedicated failure-injection tests.

## 14. Typecheck/build results

`quant:typecheck` clean. `options-auto:typecheck` clean. `vite build` clean (pre-existing chunk-size
warning only). `api/options-autotrade.ts` checked with matching compiler flags — zero new errors (3
pre-existing, unrelated `.js`-import warnings only).

## 15. AUTO regression result

Re-ran `orderIntent.test.ts`, `brokerReconciliation.test.ts`, `liveFill.test.ts`, `ironCondor.test.ts`,
`paperFill.test.ts` explicitly — **49/49 pass, unchanged.** `runLiveExecution`, broker reconciliation,
order-intent locking, position sizing, exit logic, and the daily lock were not touched by this phase
— every SHADOW addition is gated behind `execution_mode === 'SHADOW'`, a mode AUTO/PAPER never enter.

## 16. Unresolved limitations (read before treating SHADOW data as complete)

- **Execution-quality telemetry (§7) and exit-side ledger outcome recording (§6/§9) are not wired.**
  A SHADOW position currently opens with a full, real, live-bid/ask-based entry fill and a recorded
  pre-trade signal — but its eventual close does not yet write a per-leg execution-quality row or
  append the ledger's outcome fields. **This means no SHADOW trade can complete its full lifecycle
  in the forward-validation ledger yet** — entries are captured, exits are not. This is the next,
  clearly-scoped piece of work, requiring one small migration (linking a position to its ledger row)
  plus a `handlePositionMonitor` addition mirroring the entry-side wiring pattern already proven here.
- Data-quality health panel (`dataQualityHealth.ts`) exists and is tested but is not exposed via any
  API resource/dashboard endpoint yet.
- `trading_session_horizon` is hard-coded to `0` in the API wiring's snapshot/IV-history/ledger rows
  (rather than the real `approxTradingSessionsFromCalendarDays(dte)` conversion `shadowScan.ts`'s own
  orchestrator correctly computes) — a shortcut taken to keep the API-layer diff minimal; cosmetic
  only (does not affect trading decisions, only this one stored column), but should be fixed before
  relying on that specific field for research.
- Given §16's limitations, **no official forward-validation clock should be started yet** — doing so
  now would count entries whose exits are invisible to the ledger, which is worse than not starting
  at all.

Per this phase's stop condition: no strategy parameter changed, `USE_NET_EV_RANKING` remains false,
AUTO was not enabled, `BASELINE_V1` unchanged, and `FORWARD_VALIDATION_REPORT.md` was not generated.
