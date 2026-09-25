# SHADOW_LIFECYCLE_COMPLETION_REPORT.md

**Broker orders placed during this phase's testing: 0.** Every test runs against in-memory mocks or
pure functions; no live Kite session was touched.

## 1. Migration created/applied

`src/options-auto/migrations/012_shadow_exit_link.sql` — additive only, no destructive change:
- `options_autotrade_positions`: `forward_ledger_id` (FK), `valid_for_forward_validation` (nullable
  bool — null means "not a SHADOW position, not applicable"), `forward_validation_ineligibility_reasons`.
- `options_forward_validation_ledger`: `gross_pnl`, `holding_period_days`, `entry_execution_cost`,
  `exit_execution_cost`, `total_execution_cost`, `daily_lock_state`, `data_quality`, and the
  idempotency-guard column **`completed boolean not null default false`**.
- `options_execution_quality`: `phase` (ENTRY/EXIT), `scan_id`, `forward_ledger_id`, `candidate_id`,
  `trading_session_horizon`, `mid`, `spread_absolute`, `spread_capture`, `data_quality`,
  `valid_for_forward_validation`.

**Not yet applied to production** — same status as the prior phase's migrations were until you ran
them; this one needs the same explicit action from you before SHADOW's DB writes will succeed
against production.

## 2. Position ↔ ledger linking

`recordSignal()`'s return value is now captured (`shadowLedgerId`) and stored on the position row at
creation (`forward_ledger_id`), together with the entry-side eligibility (`valid_for_forward_validation`,
`forward_validation_ineligibility_reasons`). If ledger recording fails, the position still opens (a
research-telemetry failure never blocks the underlying tracking) but is explicitly marked ineligible.

## 3. trading_session_horizon fix

Every hard-coded `tradingSessionHorizon: 0` in the API-layer SHADOW persistence path (snapshot rows,
IV-history rows, ledger signal) now calls `approxTradingSessionsFromCalendarDays(dte)` — the same
conversion the volatility-horizon fix already established. No new test was added purely for this one-
line substitution (it reuses `timeConventions.test.ts`'s existing 13 tests for the underlying
function); confirmed by inspection at all 3 call sites.

## 4. Entry telemetry

Wired: one `options_execution_quality` row per entry leg, built directly from
`shadowExecResult.legFills` and the already-enriched `winningSlice.quotes` (matched by strike/right)
— never a second fetch. Batched (one `insertExecutionQuality` call for the whole position).

## 5. Exit telemetry

Wired: one row per exit leg, built directly from `simulateShadowExitFills()`'s own `SimulatedFill[]`
output — the exact fills the position actually closed at.

## 6. Monitor wiring

`handlePositionMonitor` gains an `else if (p.execution_mode === 'SHADOW')` branch, parallel to the
existing `if (p.execution_mode === 'AUTO')` branch — same trigger (`evaluateExit`, shared,
unmodified), same re-quoted `quoteMap` (shared, unmodified), zero `placer.closeLeg`/`awaitFill` calls
anywhere in it. Uses `simulateShadowExitFills()` (built directly from Kite's raw `/quote` shape,
since position-monitor doesn't run `enrichChain`) to get real-live-bid/ask-based closing fills.

## 7. Outcome wiring

`recordOutcome()` is called with the full richer `ForwardOutcome` (gross/net P&L, entry/exit/total
execution cost, holding period, daily-lock observability, data quality) — computed entirely from
already-available data (the position row, the simulated exit fills, and a `checkDailyRiskLock` call
against SHADOW's own hypothetical today's-P&L, **never the shared `options_autotrade_daily_stats`
table** — see §16).

## 8. Completion idempotency

Two independent guards, layered:
1. **The ledger's own `completed` flag** — `recordOutcome`'s production adapter does
   `UPDATE ... WHERE id = ? AND completed = false`, an atomic conditional write. A duplicate/racing
   call gets `{ alreadyCompleted: true }`, never overwrites the first outcome. Proven under real
   concurrent `Promise.all` calls in `forwardLedger.test.ts` (2 new tests).
2. **The position's own `status = 'ACTIVE'` guard** on the CLOSED update — belt-and-braces, not a
   replacement for #1.

If the ledger guard reports `alreadyCompleted`, the SHADOW branch `continue`s immediately — no
telemetry write, no position update, for that invocation.

## 9. Eligibility rules

`isCompletedTradeEligibleForForwardValidation()` — a second, stricter pure validator layered on top
of the entry-only gate: a trade counts only when BOTH entry and exit independently pass. Never
deletes a failing row. 5 new unit tests, all passing.

## 10. Health endpoint

**Not built this phase.** `dataQualityHealth.ts` (built in the prior phase) is not yet exposed via
any `resource=shadow-health` API route.

## 11. Protocol-start endpoint

**Not built this phase.** `forward_validation_runs` (migration 011, prior phase) still has no
`resource=start-forward-validation` route, and no self-test gate (§14 of your instructions) was
implemented. **This is fine given §18's own stop condition** — you have not asked to start the clock
yet, and it should not be startable until the endpoint itself, with its required self-test, exists.

## 12. Integration tests

`shadowScan.integration.test.ts` (prior phase, updated this phase): full entry→exit round trip using
the new richer `ForwardOutcome` and the raw-Kite-quote exit path — 8 tests, all passing.
`shadowExitScenarios.test.ts` (new): one test per real exit reason (`STOP_LOSS_CREDIT_MULTIPLE`,
`SHORT_STRIKE_BREACHED`, `TIME_EXIT`, plus a `HOLD` and a missing-quote case), using the real
production `evaluateExit()` and `simulateShadowExitFills()` — 5 tests, all passing.

## 13. Concurrent-monitor test

`forwardLedger.test.ts`'s "IDEMPOTENCY under real concurrency" test: two simultaneous `recordOutcome`
calls for the identical ledger row via `Promise.all` — exactly one succeeds, the other gets
`alreadyCompleted`, proven against a real (not mocked-success) in-memory store with a serialized
critical section modeling Postgres's own row-level locking.

## 14. Failure-injection tests

Carried over and still passing from the prior phase (snapshot/ledger/IV-history insert failures,
missing bid/ask, duplicate scan invocation, stale quotes) — 8 tests in `shadowScan.integration.test.ts`.
**New this phase**: the exit-side missing-quote case (`EXECUTION_DATA_INSUFFICIENT`) in
`shadowExitScenarios.test.ts`. **Not added this phase**: dedicated tests for "exit execution-telemetry
DB insert fails" / "recordOutcome DB insert fails" / "position close-state update fails" /
"timeout during monitor" as isolated API-layer scenarios — the underlying logic (try/catch soft-fail,
the idempotency guard) is exercised by the tests above, but not against the literal
`handlePositionMonitor` function itself, for the same reason given in §16.

## 15. AUTO/PAPER regression result

Explicitly re-ran: `orderIntent` (7), `brokerReconciliation` (14), `liveFill` (12), `paperFill` (3),
`exitEngine`, `dailyRiskLock`, `positionSizing`, `ironCondor` (13) — **79/79 pass, unchanged.**
Full suites: **362 quant tests, 35 options-auto tests, all pass.** `runLiveExecution`, broker
reconciliation, order-intent locking, position sizing, exit-trigger logic, and the real daily lock
are untouched by this phase — confirmed both by the passing regression and by inspection (the new
SHADOW branch in `handlePositionMonitor` is an `else if`, never touched when `execution_mode` is
`AUTO` or anything else).

## 16. Typecheck/build result

`quant:typecheck` clean. `options-auto:typecheck` clean. `vite build` clean. `api/options-autotrade.ts`
checked with matching compiler flags — zero new errors (3 pre-existing, unrelated `.js`-import
warnings only).

## 17. Broker orders placed = 0

Confirmed structurally (the SHADOW branch never calls `placer.closeLeg`/`awaitFill`/`makeLiveOrderPlacer`
anywhere) and by every test in this phase using either pure functions or mocks with no `placeOrder`-
shaped dependency.

## 18. Production smoke-test status

**Not run.** This requires a real Kite session, real market hours, and the deployed Vercel function —
none of which this sandbox has access to. Section 17 of your instructions is a real production action
for you (or your existing cron scheduler, once migration 012 is applied and `execution_mode` is set
to `SHADOW`) to trigger and observe, not something achievable from here.

## 19. Unresolved limitations (read before starting the clock)

- **§10/§11 (health + protocol-start endpoints) don't exist yet** — the protocol clock has no
  possible start mechanism until §11 is built, which is itself gated on §14's self-test per your own
  instructions. This is the single largest remaining gap.
- **`entryExecutionCost` is hard-coded to 0** in the exit-side `ForwardOutcome` — it is not looked up
  from the entry telemetry rows already stored. `totalExecutionCost` currently only reflects exit-side
  slippage. A real fix requires a small lookup (or carrying the entry cost forward via the position
  row) — flagged, not silently assumed accurate.
- **MAE/MFE remain `MAE_MFE_UNAVAILABLE`, honestly** — no intratrade mark series is persisted between
  monitor checks; `NULL` stored, never fabricated, exactly as your Task 7 allowed.
- **The daily-lock observability read uses `settings.reserved_fund`, not a real funds re-fetch** — a
  disclosed approximation, chosen specifically to avoid adding a blocking Kite call to every monitor
  cycle purely for SHADOW's own hypothetical accounting.
- **No dedicated DI/mock harness exists for `handlePositionMonitor` itself** (same scoping decision as
  last phase, for the same reason: the ~1900-line live function is not risk-free to refactor for
  testability without a way to verify the refactor against a real Kite session). Every exit-path test
  in this phase validates the exact *building blocks* (`evaluateExit`, `simulateShadowExitFills`,
  `recordOutcome`'s idempotency) the live function now calls, at the unit/integration level — not the
  literal function.
- Per your own explicit stop condition: no strategy parameter changed, `BASELINE_V1` untouched, AUTO
  not enabled, `USE_NET_EV_RANKING` remains false, protocol clock not started, and
  `FORWARD_VALIDATION_REPORT.md` was not created.
