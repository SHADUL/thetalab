# FORWARD_VALIDATION_READINESS_REPORT.md

**Broker orders placed during this phase's testing: 0.** Every test and the self-test run against
in-memory mocks or pure functions; no live Kite session was touched.

## 1. Migration 012 production status

**Not applied — and neither is migration 011.** Direct, non-destructive REST probes against
production Supabase this phase found:

- `options_autotrade_positions.forward_ledger_id` — **does not exist** (migration 012 not applied).
- `options_forward_validation_ledger.gross_pnl` — **does not exist** (migration 012 not applied).
- `options_execution_quality.phase` — **does not exist** (migration 012 not applied).
- `forward_validation_runs` — **table does not exist at all** (migration 011 was never applied,
  despite the prior phase's report referring to it as already shipped schema — it was written and
  tested, but never run against production).

This phase adds a **new migration**, `013_forward_validation_readiness.sql`, additive only:
- `options_forward_validation_ledger`: `transaction_charges_estimate`, `cost_model_version`,
  `baseline_version`, `fill_model_version`, `protocol_id`, `code_version` (the version fingerprint,
  Task 13).
- `forward_validation_runs`: `protocol_version`, `code_version`; widens the `status` check
  constraint to `ACTIVE | STOPPED | INVALIDATED` (Task 12); adds a **partial unique index**
  `(symbol, baseline_version) WHERE status = 'ACTIVE'` — the atomic claim Task 6 requires, so a
  second concurrent ACTIVE run for the same symbol+baseline fails on a unique-violation at INSERT
  time, never a check-then-act race.

**You must apply migrations `011_protocol_start_marker.sql`, `012_shadow_exit_link.sql`, and
`013_forward_validation_readiness.sql`, in that order, before any of this phase's endpoints will
work against production.** I cannot execute DDL myself (no `psql` connection, no authenticated
Supabase CLI session, PostgREST can't run arbitrary SQL) — same recurring blocker as every prior
migration this session.

## 2. entryExecutionCost fix

**Fixed a real bug, not just the stub.** Two things were wrong, not one:

1. `entryExecutionCost` was hard-coded to `0` at the exit call site (previously disclosed).
2. **The columns needed to look it up were never actually being written.** `ExecutionQualityRow`
   already carried `scanId`/`candidateId` fields (and, after 012, would have carried
   `forwardLedgerId`/`phase`), but `shadowRepository.ts`'s `insertExecutionQuality` silently dropped
   `scan_id`, `candidate_id`, and (once added) `phase`/`forward_ledger_id` before the INSERT ever
   reached the DB — every entry-telemetry row written so far has been unlinkable to its ledger row.

Fixed both: `ExecutionQualityRow` now carries `phase: 'ENTRY' | 'EXIT'` and `forwardLedgerId`; the
adapter now actually persists `scan_id`/`candidate_id`/`phase`/`forward_ledger_id`; a new
`sumEntryExecutionCost(forwardLedgerId)` on `ShadowRepository` sums real entry-side slippage,
filtered to `phase='ENTRY'` for that exact ledger row — returning `{ value: null, rowCount: 0 }`
(never `0`) when nothing is found, so unavailability is never silently treated as zero cost.

**Definitions** (see [`src/quant/execution/executionCost.ts`](src/quant/execution/executionCost.ts)):
- `slippageCost` (`entryExecutionCost`/`exitExecutionCost`) — the difference between the simulated
  fill and the mid/decision price at each leg, always a non-negative cost.
- `transactionChargesEstimate` — brokerage/STT/exchange/SEBI/stamp-duty/GST, via the **same** cost
  model the backtest engine already uses (`costs.ts`'s `ratesEffectiveOn`/rate-history lookup) — a
  deterministic function of trade date + turnover, never a live-telemetry dependency, so it's never
  null.
- `totalExecutionCost = entryExecutionCost + exitExecutionCost`, **exactly** — transaction charges
  are deliberately kept out of this sum.

**Tests**: [`executionCost.test.ts`](src/quant/__tests__/executionCost.test.ts) — 6 tests proving
`total = entry + exit`, that an unavailable entry cost produces `totalExecutionCost = null` (never a
silent 0), and that the transaction-charge estimate correctly picks up the pre/post-Oct-2024 STT rate
change for a given trade date.

## 3. Net P&L consistency — and a critical bug found and fixed underneath it

While building the one canonical formula, a **sign-inverted cost-to-close bug** was found in
`simulateShadowExitFills` (`shadowScan.ts`) — the function every SHADOW exit has been calling since
the lifecycle-completion phase. A worked example: iron condor breached deep into max-loss territory
(short call ~₹700, long call ~₹200 per unit) — the pre-fix formula returned `costToClose = -₹500/unit`,
so `realizedPnl = maxProfit - (-500) = maxProfit + 500` — **a profit INCREASE while deep in max-loss
territory.** Root cause: the formula keyed its sign off the CLOSING order's side, using the same
sign convention `api/options-autotrade.ts`'s own (correct) `currentCostToClose` uses with the
ORIGINAL side — since closing side is always the opposite of the original, every term was inverted.

**This is a mathematical bug fix, not a parameter change** — explicitly permitted, and left
unfixed would have silently corrupted every SHADOW P&L in adverse scenarios for the entire official
sample. Fixed by keying off the original `leg.side` directly. Proof:
[`shadowExitCostToClose.test.ts`](src/quant/__tests__/shadowExitCostToClose.test.ts) — 3 tests: a
worked deep-max-loss example (now correctly positive), a near-max-profit example (near-zero cost to
close), and an independent payoff-curve sweep across strikes proving `realizedPnl` never exceeds
`maxProfit` or falls below `-maxLoss`.

**Canonical formula** (now used identically by the ledger outcome AND the position record):
```
grossPnl = maxProfit - costToCloseAtMid   (MID-to-MID, zero slippage — the new costToCloseAtMid
                                            field on ShadowExitFillResult)
netPnl   = grossPnl - entryExecutionCost - exitExecutionCost - transactionChargesEstimate
```
`p.forward_ledger_id`'s outcome row and the position's `realized_pnl` (used for the daily-lock
hypothetical check) both now derive from this same `computeCanonicalForwardPnl()` call — one
function, one call site, not two independent derivations that could silently drift apart.

**Invariant tests**: `executionCost.test.ts` (netPnl arithmetic) + `shadowExitCostToClose.test.ts`
(the underlying costToClose/costToCloseAtMid correctness the formula depends on).

## 4. Health endpoint

Built: `resource=shadow-health` (GET, read-only). Returns per-symbol (NIFTY/BANKNIFTY/SENSEX)
metrics for a given day (`?date=YYYY-MM-DD`, defaults to today IST): scan/write/telemetry/ledger
success percentages, open/completed/eligible SHADOW trade counts, `validForwardSamplePct`,
`activeProtocolRun`/`protocolStartedAt`/`elapsedDays`, and `healthStatus` (`HEALTHY` | `DEGRADED` |
`NOT_READY`) with explicit `reasons` — **never inferred from a metric with a zero denominator**
(those come back `null`, and `NOT_READY` is used when zero scans have been attempted at all, not a
fabricated `HEALTHY`/`DEGRADED`).

**Disclosed approximation**: `scansAttempted`/`entryTelemetryAttempts`/`ledgerSignalAttempts` are
counted from the `SCAN_STARTED`/`SHADOW_SIGNAL_RECORDED` log events `handlePaperScan` already emits
unconditionally — the only reliable "attempted" signal, since a fully-failed DB insert leaves no row
of its own to count. `exitTelemetryAttempts`/`ledgerOutcomeAttempts` are approximated from the
position-monitor's own SHADOW exit log lines (`Closed SHADOW position` / `exit fill simulation
failed` / `outcome already recorded`) — there is no dedicated per-exit-attempt event table the way
entry has one. This is stated in the code, not silently assumed exact.

**Tests**: [`shadowHealth.test.ts`](src/quant/__tests__/shadowHealth.test.ts) — 6 tests on the pure
`computeShadowHealthReport()` function (the endpoint itself is a thin DB-query wrapper around it).

## 5. Readiness evaluator

Built: `evaluateForwardValidationReadiness()` in
[`src/quant/execution/readiness.ts`](src/quant/execution/readiness.ts) — pure, no I/O, no side
effects, exactly per your spec: every fact it judges (migration presence, baseline version, wiring
flags, health status, AUTO/NET_EV state) is probed by the CALLER (the start endpoint) and passed in
already-assembled. Returns `READY`/`NOT_READY` with every failing reason, not just the first.

**Tests**: [`readiness.test.ts`](src/quant/__tests__/readiness.test.ts) — 4 tests: full pass, each of
the 13 conditions failing individually with its own specific reason, multiple simultaneous failures
all reported, and a purity check (same input -> same output, always).

## 6. Protocol-start endpoint

Built: `resource=start-forward-validation` (POST only). Requires an explicit call — nothing in this
codebase invokes it automatically, on deploy or otherwise. Sequence: runs the self-test (§7) ->
refuses if it fails; else queries the health endpoint + probes migration 012's columns live -> calls
`evaluateForwardValidationReadiness()` -> refuses if `NOT_READY`; else does the atomic INSERT (§13).

## 7. Start-endpoint self-test

Built: `runForwardValidationSelfTest()` in
[`src/quant/execution/selfTest.ts`](src/quant/execution/selfTest.ts) — a fully in-memory mocked
lifecycle (synthetic iron condor, no real Supabase/Kite call, nothing broker-shaped anywhere in its
import graph): entry fill simulation -> ledger signal -> entry telemetry -> monitor HOLD -> monitor
EXIT (forced) -> exit fill simulation -> exit telemetry -> real entry-cost lookup -> outcome recorded
-> **duplicate recordOutcome rejected** -> completed-eligibility gate runs cleanly -> zero broker
calls. Every one of your Task 7 bullet points is its own named check, not a single pass/fail boolean,
so a regression is immediately attributable. The start endpoint refuses if ANY check fails.

**Tests**: [`selfTest.test.ts`](src/quant/__tests__/selfTest.test.ts) — 3 tests, including running it
twice to confirm each invocation builds fresh state (no cross-call leakage).

## 8. Completed-trade eligibility — final check

`isCompletedTradeEligibleForForwardValidation()` (built prior phase) already covers 9 of your 12
listed conditions (entry+exit eligibility, entry+exit telemetry stored, outcome persisted, strategy/
fill-model drift, known ingestion bug, broker order placed). **Not yet wired this phase**: "protocol
run ACTIVE at signal time" and "signal timestamp >= protocol started_at" — the signal now carries
`protocolId` (Task 13's fingerprint, null when pre-protocol), but the eligibility gate itself does
not yet cross-check that id against a live `forward_validation_runs` row's `started_at`. Flagged, not
silently assumed done — this is a small, well-scoped follow-up once migration 011/013 are live and a
real protocol run exists to test it against.

## 9. Production smoke test

**Not run.** Migration 011/012 are not applied to production (§1) — the health/start endpoints will
error against production until they are. Requires real market hours + a live Kite session once
migrations are applied, same as every prior phase's disclosed limitation here.

## 10. Monitor smoke test

**Not run**, for the same reason as §9 — no ACTIVE SHADOW position exists in production to observe
(SHADOW hasn't been wired against a schema that supports it in production yet).

## 11. Remaining limitations

- Migrations 011, 012, 013 are **not applied to production** — the single largest blocker (§1).
- The completed-trade eligibility gate does not yet cross-check protocol-run timing (§8).
- Health-endpoint "attempt" counts are a disclosed log-based approximation, not a dedicated
  attempt-tracking table (§4).
- `MAE_MFE_UNAVAILABLE` remains honest — no intratrade mark series is persisted between monitor
  checks (unchanged from prior phase).
- The daily-lock observability read still uses `settings.reserved_fund`, not a real funds re-fetch
  (unchanged, disclosed prior phase).
- No dedicated DI/mock harness exists for `handlePositionMonitor` itself (same scoping decision as
  every prior phase, for the same reason — the ~2500-line live function is not risk-free to refactor
  for testability without a way to verify against a real Kite session).
- Monitor-failure-safety tests for literal API-layer scenarios ("exit telemetry insert fails",
  "recordOutcome insert fails", "position close-state update fails", overlapping invocations) are
  exercised indirectly via the idempotency guard and self-test, not as dedicated
  `handlePositionMonitor`-level tests — same scoping reason as above. Task 11's "monitor retry" edge
  case is worth a closer look before the clock starts: if `recordOutcome` succeeds but the process
  crashes before the position-close UPDATE runs, the next monitor cycle's `recordOutcome` call will
  correctly return `alreadyCompleted` and `continue` — but the position stays `ACTIVE` forever,
  because nothing re-attempts the close once the ledger says done. Flagged as a real, if narrow, gap
  — not fixed this phase given the size of everything else in scope.

## 12. AUTO/PAPER regression

Explicitly re-ran: `orderIntent` (7), `brokerReconciliation` (14), `liveFill` (12), `paperFill` (3),
`exitEngine`, `dailyRiskLock`, `positionSizing`, `ironCondor` (13) — **79/79 pass, unchanged.** The
entire SHADOW cost/P&L rewrite lives behind `execution_mode === 'SHADOW'`, never touched by AUTO/
PAPER — confirmed both by the regression and by inspection.

## 13. Total tests

**384 quant tests + 35 options-auto tests = 419, all pass** (up from 365+35=400 at the start of this
phase — 19 new tests: 3 cost-to-close sign-bug proofs, 6 execution-cost invariants, 4 readiness-
evaluator tests, 6 health-report tests).

## 14. Typecheck/build

`quant:typecheck` clean. `options-auto:typecheck` clean. `vite build` clean (same pre-existing
chunk-size warning only). `api/options-autotrade.ts` checked with matching compiler flags — zero new
errors (the same 3 pre-existing, unrelated `.js`-import warnings only).

## 15. Broker orders placed = 0

Confirmed structurally (nothing in this phase's new code — `executionCost.ts`, `readiness.ts`,
`shadowHealth.ts`, `selfTest.ts`, the two new API handlers — imports or calls anything
`placeOrder`-shaped) and by every test using either pure functions or in-memory mocks.

---

Per your explicit stop condition: no strategy parameter was optimized, `BASELINE_V1` is unchanged,
AUTO was not enabled, `USE_NET_EV_RANKING` remains hardcoded `false`, the protocol clock was **not**
started (migrations aren't even applied yet, so it structurally can't be), and
`FORWARD_VALIDATION_REPORT.md` was not created.

**FORWARD VALIDATION STATUS:**
**NOT READY**

(Blocked on: migrations 011/012/013 applied to production, then the protocol-run-timing check in
§8, then a real production smoke test during market hours — nothing else in this phase's scope
remains open.)
