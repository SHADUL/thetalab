# FORWARD_VALIDATION_READINESS_REPORT_V2.md

**Broker orders placed during this phase's testing: 0.** Every test and the self-test run against
in-memory mocks or pure functions; no live Kite session was touched.

## 1. Migration status

**Still not applied.** Re-verified via the same direct, non-destructive REST probes as the prior
report:

- `forward_validation_runs` — table does not exist (migration 011).
- `options_autotrade_positions.forward_ledger_id` — does not exist (migration 012).
- `options_forward_validation_ledger.completed` — does not exist (migration 012).
- `options_execution_quality.phase` — does not exist (migration 012).

Migration `013_forward_validation_readiness.sql` (written last phase) adds the version-fingerprint
and cost-breakdown columns plus the atomic active-run index — it depends on 011/012 already existing
and has also not been applied. **All three — 011, then 012, then 013, in that order — still need to
be applied to production before anything protocol-related works.** I cannot execute DDL myself (no
`psql` connection, no authenticated Supabase CLI session, PostgREST can't run arbitrary SQL) — this
is the single blocking dependency for this entire phase, unchanged from the prior report.

## 2. Protocol-timing eligibility — fixed

Built `evaluateProtocolTimingEligibility()`
([`src/quant/execution/protocolTiming.ts`](src/quant/execution/protocolTiming.ts)) — a pure function
(no DB query inside it, per your explicit instruction) checking a signal's `protocol_id`,
`baseline_version`, `fill_model_version`, and timestamp against the referenced
`forward_validation_runs` row's own facts, all supplied by the caller. Folded into
`isCompletedTradeEligibleForForwardValidation()` via a new optional `protocolTiming` field (backward-
compatible — omitting it just skips the check). Wired into the real exit-close path in
`api/options-autotrade.ts`: at CLOSE time, the ledger's own stored fingerprint is read back, the
referenced run (if any) is looked up, and the full completed-trade eligibility verdict — including
protocol timing — now actually determines `valid_for_forward_validation` (previously this was
computed ad hoc inline and never actually called the dedicated eligibility function at all, another
gap this phase closed).

**Tests**: [`protocolTiming.test.ts`](src/quant/__tests__/protocolTiming.test.ts) — all 10 of your
listed scenarios pass: before/exactly-at/after protocol start, wrong protocol ID, wrong baseline,
wrong fill model, STOPPED run, INVALIDATED run, pre-protocol trade, no matching run at all.
`shadowExecution.test.ts` — 3 new tests proving the `protocolTiming` field folds in correctly.

## 3/4. Completed-ledger / active-position recovery gap — fixed

Built `classifyShadowConsistency()` + `buildShadowRecoveryFinalizationPlan()` +
`hasOrphanedExitTelemetry()` in
[`src/quant/execution/shadowConsistency.ts`](src/quant/execution/shadowConsistency.ts) — see
[`SHADOW_EXIT_RECOVERY.md`](SHADOW_EXIT_RECOVERY.md) for the full durable-sequence design (§5).

Wired into `handlePositionMonitor`'s SHADOW branch in two places:
- **At the very top of the per-position loop, before any quote-based logic or a fresh
  `evaluateExit()` call** — this is deliberate: if the market had moved back toward HOLD since a
  crash, a fresh exit decision this cycle could easily be HOLD, and the OLD code would never reach
  the exit-handling branch again, leaving the position stuck ACTIVE forever. The recovery check now
  runs unconditionally first.
- **In the `recordOutcome` idempotency-loser branch** — a losing invocation (another overlapping
  monitor call won the race) now recovers from the WINNER's persisted outcome instead of just
  skipping.

`forwardLedger.ts` gained a new **read-only** `getOutcome(ledgerId)` accessor on `ForwardLedgerStore`
— never touches `completed` or any other column, exists solely to read back the FIRST persisted
outcome for recovery. The recovery path never re-simulates an exit, never recomputes P&L from newer
quotes, and never writes a second telemetry batch — it finalizes the position from the EXACT
persisted values via an atomic `UPDATE ... WHERE id = ? AND status = 'ACTIVE'`.

**A related gap found and fixed in the same pass**: the "exit telemetry written, crash before
outcome" case (your own Task 6, item 6) is genuinely ambiguous — the original fill/quote state is
gone, so re-simulating would create a second, independently-priced exit sharing the same ledger row.
Rather than guess, `hasOrphanedExitTelemetry()` now flags this and leaves the position ACTIVE for
manual reconciliation — the one crash point this system deliberately does NOT auto-resolve, disclosed
plainly in §5 of `SHADOW_EXIT_RECOVERY.md`.

**Tests**: [`shadowConsistency.test.ts`](src/quant/__tests__/shadowConsistency.test.ts) — 8 tests on
the classifier and finalization-plan builder.

## 5. SHADOW exit transaction boundary

Documented in [`SHADOW_EXIT_RECOVERY.md`](SHADOW_EXIT_RECOVERY.md) — the five-step durable sequence
(A: trigger observed, B: exit simulated once, C: EXIT telemetry persisted, D: ledger outcome
atomically completed, E: position finalized CLOSED), with an explicit "what does the next monitor do"
section for a crash after each step, plus the full consistency matrix.

## 6. Failure-injection tests for the literal gap

[`shadowRecovery.test.ts`](src/quant/__tests__/shadowRecovery.test.ts) — 11 tests, one per scenario
in your list (outcome-succeeds-position-throws, two concurrent recovery invocations, all four matrix
combinations, orphaned-exit-telemetry, retried-finalize-converges-once, a purity invariant, and a
zero-broker-calls invariant), using a minimal in-memory "atomic position store" modeling Postgres's
own `WHERE status = 'ACTIVE'` conditional UPDATE. **Not literal `handlePositionMonitor` tests** — same
scoping decision as every prior phase (disclosed, not hidden): the ~2500-line live dispatch function
still has no DI/mock harness, for the same reason as before (not risk-free to refactor without a way
to verify against a real Kite session). These tests exercise the exact pure building blocks that
function now calls for recovery.

## 7. Completion consistency checker

`classifyShadowConsistency()` implements exactly your four-state matrix
(`NORMAL_OPEN`/`NORMAL_CLOSED`/`RECOVERABLE_INCONSISTENCY`/`RECONCILIATION_REQUIRED`), used both in
the position monitor (to decide whether to recover) and in the health endpoint (to count and report
it). Never silently ignored — every non-`NORMAL_*` classification is either auto-recovered (with a
log line) or explicitly surfaced.

## 8. Health endpoint update

`resource=shadow-health` now also returns, per symbol: `completedLedgerActivePositionCount`,
`closedPositionIncompleteLedgerCount`, `protocolTimingInvalidTradeCount`, `recoveryRequiredCount` —
computed via a read-only embedded-relationship query
(`options_autotrade_positions.select('...,options_forward_validation_ledger(completed)')`) classified
per-row with the same pure function the monitor uses. **Any of these being `> 0` now unconditionally
blocks `HEALTHY`** (moved to `DEGRADED` with an explicit reason), regardless of how good every other
percentage looks — these are correctness problems, never averaged away.

**Tests**: [`shadowHealth.test.ts`](src/quant/__tests__/shadowHealth.test.ts) — 1 new test covering
all four new counts individually blocking `HEALTHY`.

## 9. Protocol-start readiness — updated

`evaluateForwardValidationReadiness()` gained: `migrationsPresent` (renamed/widened from
`migration012Present` — 011 turned out to have never been applied either, so this now covers all
three), `protocolTimingEligibilityWired`, `completedLedgerRecoveryWired`, `canonicalPnlActive`,
`hasUnresolvedShadowLifecycleInconsistency` (derived from the health endpoint's new counts). The
start endpoint now probes all four migration-dependent tables/columns (011/012/013 combined) before
calling the evaluator.

**Tests**: [`readiness.test.ts`](src/quant/__tests__/readiness.test.ts) — updated to 17 individual-
failure cases (was 13) plus the aggregate/purity tests.

## 10. Self-test update

`runForwardValidationSelfTest()` now also simulates the crash: after the outcome is recorded
(`completed = true`), an in-memory "position" is deliberately left `ACTIVE` (nothing finalizes it),
then the SAME recovery path (`classifyShadowConsistency` -> `getOutcome` ->
`buildShadowRecoveryFinalizationPlan`) is run against it. Six new named checks assert: the classifier
detects `RECOVERABLE_INCONSISTENCY`, `getOutcome` reads back the first persisted outcome, the
recovered P&L matches the original exactly (never recomputed), the position is finalized `CLOSED`,
no duplicate telemetry was written, and the ledger row itself is untouched by recovery (completed
exactly once).

**Tests**: [`selfTest.test.ts`](src/quant/__tests__/selfTest.test.ts) — updated to assert all six new
checks are present and passing.

## 11. Production smoke test

**Not run.** Blocked on §1 — migrations 011/012/013 are not applied to production, so the health/
start endpoints (and the SHADOW exit path itself, which now queries `options_execution_quality.phase`
and `options_forward_validation_ledger.completed`) will error against production until they are.

## 12. Protocol start — still explicit

Unchanged: `resource=start-forward-validation` requires an explicit POST; nothing in this codebase
invokes it automatically. Not invoked this phase.

## 13. AUTO/PAPER regression

Re-ran: `orderIntent` (7), `brokerReconciliation` (14), `liveFill` (12), `paperFill` (3), `exitEngine`,
`dailyRiskLock`, `positionSizing`, `ironCondor` (13) — **79/79 pass, unchanged.** The entire recovery
path lives behind `p.execution_mode === 'SHADOW'`, and the top-of-loop recovery check is gated on
`p.execution_mode === 'SHADOW' && p.forward_ledger_id` — confirmed both by the regression and by
inspection that AUTO/PAPER positions (which never populate `forward_ledger_id`) never enter it.

## 14. Total tests

**417 quant tests + 35 options-auto tests = 452, all pass** (up from 384+35=419 last phase — 33 new
tests: 10 protocol-timing, 3 shadowExecution protocol-timing integration, 8 consistency-classifier,
11 recovery failure-injection, 1 health-panel inconsistency test).

## 15. Typecheck/build

`quant:typecheck` clean. `options-auto:typecheck` clean. `vite build` clean (same pre-existing chunk-
size warning only). `api/options-autotrade.ts` checked with matching compiler flags — zero new
errors (the same 3 pre-existing, unrelated `.js`-import warnings only).

## 16. Broker orders placed = 0

Confirmed structurally — none of this phase's new modules (`protocolTiming.ts`,
`shadowConsistency.ts`) import or reference anything `placeOrder`-shaped, and every test uses pure
functions or in-memory stores.

---

Per your explicit stop condition: nothing was optimized, `BASELINE_V1` is unchanged, AUTO was not
enabled, `USE_NET_EV_RANKING` remains hardcoded `false`, the protocol clock was **not** started
(structurally impossible — the table it would insert into doesn't exist in production yet), and
`FORWARD_VALIDATION_REPORT.md` was not created.

Every code-side blocker from the prior report is now closed. The **only** remaining blocker is
applying migrations 011, 012, and 013 to production, in that order — once that's done, a re-run of
`resource=start-forward-validation`'s own readiness probe (§9) should report every condition satisfied
except the production smoke test (§11), which needs real market hours to complete.

**FORWARD VALIDATION STATUS:**
**NOT READY**
