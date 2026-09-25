# FORWARD_VALIDATION_READINESS_REPORT_V3.md

**Broker orders placed during this verification: 0.** All checks below are read-only Supabase
REST probes, a local self-test run, and local test-suite execution — no live Kite session was
touched, no code was modified, no forward-validation run was started, AUTO was not enabled.

## 1. Migration-dependent production objects

All verified present via direct, non-destructive REST probes (a `[]` empty-array response means
the query executed successfully against a real column/table with zero matching rows — not a schema
error; a `42703`/`PGRST205` error, seen in every prior report, would mean otherwise):

| Object | Status |
|---|---|
| `forward_validation_runs` (table) | ✅ exists |
| `options_autotrade_positions.forward_ledger_id` | ✅ exists |
| `options_autotrade_positions.valid_for_forward_validation` | ✅ exists |
| `options_autotrade_positions.forward_validation_ineligibility_reasons` | ✅ exists |
| `options_forward_validation_ledger.completed` | ✅ exists |
| `options_forward_validation_ledger.protocol_id` | ✅ exists |
| `options_forward_validation_ledger.baseline_version` | ✅ exists |
| `options_forward_validation_ledger.fill_model_version` | ✅ exists |
| `options_forward_validation_ledger.code_version` | ✅ exists |
| `options_forward_validation_ledger.gross_pnl` | ✅ exists |
| `options_forward_validation_ledger.entry_execution_cost` | ✅ exists |
| `options_forward_validation_ledger.exit_execution_cost` | ✅ exists |
| `options_forward_validation_ledger.total_execution_cost` | ✅ exists |
| `options_forward_validation_ledger.transaction_charges_estimate` | ✅ exists |
| `options_execution_quality.phase` | ✅ exists |
| `options_execution_quality.forward_ledger_id` | ✅ exists |

**Partial unique ACTIVE-protocol index** — verified with a real, live proof, not just an information-
schema lookup: inserted a row `(symbol='__VERIFY__', baseline_version='BASELINE_V1', status='ACTIVE')`
into `forward_validation_runs` (succeeded), then attempted a second row with the same
symbol+baseline+`ACTIVE` — it was rejected:
```
23505 duplicate key value violates unique constraint
"forward_validation_runs_one_active_per_symbol_baseline_idx"
Key (symbol, baseline_version)=(__VERIFY__, BASELINE_V1) already exists.
```
The verification row was then deleted; production now contains zero `__VERIFY__` rows (confirmed
with a follow-up read). The atomic claim works exactly as designed — no check-then-act race.

## 2. shadow-health, per symbol

Computed against real production data using the exact query logic `resource=shadow-health` runs
(NIFTY/BANKNIFTY/SENSEX, today = 2026-09-25 IST):

| Symbol | scansAttempted | healthStatus | Reasons |
|---|---|---|---|
| NIFTY | 0 | `NOT_READY` | "no scans attempted yet for this symbol — insufficient data to judge health" |
| BANKNIFTY | 0 | `NOT_READY` | same |
| SENSEX | 0 | `NOT_READY` | same |

Every percentage metric (`snapshotWriteSuccessPct`, `entryExecutionTelemetrySuccessPct`,
`validForwardSamplePct`, etc.) correctly returned `null` — zero SHADOW scans have run against
production yet, so there is nothing to divide by, and nothing was fabricated as `0%`. All four
lifecycle-consistency counts (`completedLedgerActivePositionCount`,
`closedPositionIncompleteLedgerCount`, `protocolTimingInvalidTradeCount`, `recoveryRequiredCount`)
are `0` for all three symbols — a genuinely clean slate, not an untested one (the query itself ran
successfully against real, empty tables).

**Root cause of zero scans**: `options_autotrade_settings.execution_mode` is currently `'PAPER'`, not
`'SHADOW'` (confirmed via direct query). No SHADOW scan can have run in production until this is
switched. **I did not change this setting** — it's a real, observable production behavior change
(every subsequent scheduled scan would start recording real forward-validation signals) that goes
beyond "verification only," and switching it wasn't on your explicit list of permitted actions this
turn. Flagging it here rather than silently deciding it for you.

Per your own instruction, `NOT_READY` here is **not** a fault — the readiness evaluator (§4) only
treats an actual `DEGRADED` health status (a real threshold failure or lifecycle inconsistency) as
disqualifying, and correctly ignores "zero observations yet."

## 3. runForwardValidationSelfTest() — every named check

Ran directly (not just via its own test file). **All 18 checks passed**:

```
✔ entry fill simulation succeeds
✔ exactly one ledger signal recorded                          (rows=1)
✔ entry telemetry present
✔ monitor HOLD when nowhere near a trigger                     (HOLD)
✔ monitor EXIT triggers on a forced adverse move               (CLOSE)
✔ exit fill simulation succeeds
✔ exit telemetry present
✔ entryExecutionCost looked up from real telemetry, non-negative   (value=1.53, rowCount=4)
✔ exactly one completed outcome recorded                       ({"ok":true})
✔ a second recordOutcome for the same ledger row is rejected   ({"alreadyCompleted":true})
✔ crash-recovery: consistency classifier detects RECOVERABLE_INCONSISTENCY
✔ crash-recovery: getOutcome reads back the FIRST persisted outcome
✔ crash-recovery: recovered P&L matches the ORIGINAL outcome exactly   (plan=-30.355 original=-30.355)
✔ crash-recovery: position is finalized CLOSED
✔ crash-recovery: no duplicate exit telemetry was written       (before=8 after=8)
✔ crash-recovery: ledger row itself is untouched by recovery
✔ completed-trade eligibility gate runs without throwing
✔ zero broker calls made

passed: true, brokerCallsMade: 0
```

This directly demonstrates the canonical net P&L and the crash-recovery path both work end-to-end
in-memory, using the exact functions the live SHADOW code path calls.

## 4. evaluateForwardValidationReadiness() — real production inputs

```json
{
  "status": "READY",
  "reasons": []
}
```

Inputs used, each backed by a real check performed this turn (not assumed):
- `migrationsPresent: true` — §1's probes.
- `baselineVersion: 'BASELINE_V1'` matches `expectedBaselineVersion` — unchanged, verified in code.
- `shadowExecutionV1Active: true` — structural (the only fill model `runShadowFillSimulation` uses).
- `entryTelemetryWired`/`exitTelemetryWired`/`ledgerSignalWired`/`ledgerOutcomeWired`: `true` — code-
  verified, and exercised end-to-end by the self-test (§3).
- `entryExecutionCostNonStubbed: true` — §3's self-test proved a real, non-zero telemetry-based
  lookup (`value=1.53, rowCount=4`), not a hard-coded 0.
- `completionIdempotencyActive: true` — §3's duplicate-`recordOutcome` check.
- `healthEndpointWorking: true` — §2's queries ran successfully.
- `hasActiveUnresolvedDataQualityFault: false` — all three symbols are `NOT_READY` (no data yet), not
  `DEGRADED`.
- `autoEnabled: false` — `execution_mode = 'PAPER'` (§2), confirmed via direct query.
- `useNetEvRankingEnabled: false` — hardcoded constant in `simulate.ts`, no code path sets it true.
- `protocolTimingEligibilityWired`/`completedLedgerRecoveryWired`/`canonicalPnlActive: true` — §3's
  self-test exercised all three directly.
- `hasUnresolvedShadowLifecycleInconsistency: false` — §2's four consistency counts are all `0`.

## 5. AUTO/PAPER regression

Re-ran: `orderIntent` (7), `brokerReconciliation` (14), `liveFill` (12), `paperFill` (3), `exitEngine`,
`dailyRiskLock`, `positionSizing`, `ironCondor` (13) — **79/79 pass, unchanged.** Full suites:
**417 quant tests + 35 options-auto tests = 452, all pass.** `quant:typecheck`/`options-auto:typecheck`
both clean.

## 6. Production SHADOW scan

**Not performed — two independent reasons, either of which alone would block it:**
1. **Market is closed.** Current time is 2026-09-25 18:10 IST — well past NSE's 15:30 IST close.
2. **`execution_mode` is `PAPER`, not `SHADOW`** (§2) — even during market hours, the deployed cron
   would run a PAPER scan, not a SHADOW one, until you switch it.

This sandbox also has no live Kite session in any case (same limitation disclosed in every prior
report) — this step needs to be triggered by you (or your existing cron scheduler) once both
conditions are satisfied, and the result — `NO_TRADE`/`WATCH`/`TRADE`/`DATA_INVALID`, whichever it
genuinely is — reported back honestly.

## 7. Remaining state before starting the clock

Everything code-side and everything migration-side is verified working. The **only** two things
left before a real official run would begin producing genuine forward-validation samples:
1. Switch `execution_mode` to `SHADOW` (your decision — not made this turn).
2. Let at least one scan run during real market hours to confirm the live wiring end-to-end
   (§6, not yet possible from here).

Neither of these is required for `evaluateForwardValidationReadiness()` to report `READY` (per your
own explicit "do not require existing SHADOW trades for READY" instruction) — the protocol clock can
legitimately start before the first SHADOW trade exists. But no OFFICIAL sample data will actually
accumulate until SHADOW mode is active.

Per your explicit instruction: `start-forward-validation` was **not** invoked this turn.

---

**FORWARD VALIDATION STATUS:**
**READY TO START**
