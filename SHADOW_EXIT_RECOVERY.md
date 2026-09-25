# SHADOW_EXIT_RECOVERY.md

The durable sequence a SHADOW exit is intended to complete, and exactly what the next monitor
invocation does if the process dies at any point along it. This document exists because a SHADOW
exit spans multiple independent DB operations — there is no single transaction wrapping A–E — so a
crash between any two steps is a real, expected occurrence, not a hypothetical.

## The five steps

```
A. exit trigger observed        (evaluateExit() returns CLOSE, this cycle's re-quoted mark)
B. SHADOW exit simulated ONCE   (simulateShadowExitFills() — real live bid/ask, SHADOW_EXECUTION_V1)
C. EXIT telemetry persisted     (options_execution_quality, phase='EXIT', one row per leg)
D. ledger outcome atomically
   completed                    (recordOutcome() — WHERE completed = false, migration 012's guard)
E. position finalized CLOSED    (options_autotrade_positions UPDATE — WHERE status = 'ACTIVE')
```

**The governing rule: the FIRST completed ledger outcome (step D) is authoritative.** Once D has
succeeded, nothing downstream is ever allowed to recompute a different P&L, re-run B, or write a
second batch of C — every later invocation either finishes E from D's own persisted values, or is a
no-op.

## Crash recovery, by crash point

### Crash after A (trigger observed, nothing persisted yet)
Nothing durable happened. The next monitor cycle re-evaluates from scratch — re-quotes, re-runs
`evaluateExit()`. Ordinary, no special handling needed.

### Crash after B (fill simulated, nothing persisted)
Same as after A — the simulated fill was never written anywhere. The next cycle simulates fresh.
Ordinary.

### Crash after C (EXIT telemetry persisted, D never ran)
**The dangerous ambiguous case.** A telemetry batch now exists for this `forward_ledger_id`, but the
ledger itself is still `completed = false`. The next monitor invocation, on reaching the SHADOW exit
branch, checks for exactly this via `hasOrphanedExitTelemetry()` (`shadowConsistency.ts`) — if EXIT
telemetry already exists for this ledger row and the ledger isn't completed, the position is **left
ACTIVE and flagged for manual reconciliation**, not re-simulated. Re-simulating would produce a
SECOND, independently-priced exit (different quotes, different fill, different P&L) sharing the same
telemetry batch's ledger row — exactly the "duplicate telemetry representing two independent exits"
this phase's own stop condition forbids. This is the one crash point this system does **not**
auto-resolve, by design: reconstructing the original P&L from the partial stored telemetry fields
(no bid/ask were persisted per leg, only slippage) is fragile enough that a human should confirm it
instead.

### Crash after D (ledger outcome completed, E never ran)
**The gap this phase fixes.** The ledger is `completed = true`; the position is still `ACTIVE`. Every
subsequent monitor cycle, BEFORE evaluating any fresh exit trigger, checks
`classifyShadowConsistency(ledgerCompleted, position.status)` for every SHADOW position with a
`forward_ledger_id` — this runs unconditionally at the top of the loop, specifically so a market move
back toward HOLD since the crash can never mask the recovery (a fresh `evaluateExit()` call this
cycle might well return HOLD, and the OLD code would then never reach the exit-handling branch at
all). Finding `RECOVERABLE_INCONSISTENCY` triggers `recoverShadowPositionIfLedgerCompleted()`:
1. Reads back the ledger's own persisted outcome (`getOutcome()` — read-only, no side effects).
2. Builds a finalization plan from THOSE EXACT VALUES (`buildShadowRecoveryFinalizationPlan()`) — no
   re-simulated exit, no recomputed P&L, no re-derived exit reason.
3. Applies it via an atomic `UPDATE ... WHERE id = ? AND status = 'ACTIVE'` — a concurrent second
   recovery attempt (another overlapping invocation, or a retry) affects zero rows and is a no-op.

The same recovery function also runs when THIS cycle's own `recordOutcome()` call loses an
idempotency race (`alreadyCompleted`) — the losing invocation recovers from the winner's outcome
instead of just skipping and leaving the position stuck.

### Crash after E (fully complete)
Steady state — `classifyShadowConsistency(true, 'CLOSED')` is `NORMAL_CLOSED`. Nothing to do.

## The consistency matrix

| Ledger completed | Position status | State | Action |
|---|---|---|---|
| false | ACTIVE | `NORMAL_OPEN` | ordinary in-flight — evaluate exit normally |
| true | CLOSED | `NORMAL_CLOSED` | ordinary terminal state — no-op |
| true | ACTIVE | `RECOVERABLE_INCONSISTENCY` | recover from the persisted outcome (never re-simulate) |
| false | CLOSED | `RECONCILIATION_REQUIRED` | never auto-fixed — surfaced via `shadow-health`'s `closedPositionIncompleteLedgerCount` |
| false/true | anything else (e.g. `CLOSE_FAILED`) | `RECONCILIATION_REQUIRED` | never auto-fixed — surfaced via `recoveryRequiredCount` |

This matrix is enforced by the pure function `classifyShadowConsistency()`
(`src/quant/execution/shadowConsistency.ts`), and its counts are exposed by `resource=shadow-health`
so an unresolved inconsistency is always visible, never silently sitting in the database unnoticed.

## What this guarantees

Regardless of which step the process dies at, and regardless of how many times a monitor cycle is
retried afterward, the system converges to **exactly one** completed ledger outcome and **exactly
one** `CLOSED` position for that trade — or, for the one genuinely ambiguous crash point (after C),
an explicit, visible flag asking a human to look, never a silent guess.
