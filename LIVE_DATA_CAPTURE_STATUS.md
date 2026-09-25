# LIVE_DATA_CAPTURE_STATUS.md

**This phase's deliverable, per its own explicit stop condition: implementation status, not a
populated `FORWARD_VALIDATION_REPORT.md`.** Zero forward SHADOW trades have been collected — none
could be, since `execution_mode = SHADOW` did not exist in this codebase until this phase, and no
migration has yet been applied to production. `FORWARD_VALIDATION_REPORT.md` cannot honestly be
written yet; producing one now would mean fabricating trades, which this whole line of work exists
to refuse to do. This document is what actually shipped, and exactly where it stops.

## 0/1. Production migrations — BLOCKED, needs your action

**Confirmed via direct Supabase REST check: none of the four tables exist yet**
(`options_autotrade_order_intents`, `options_chain_snapshots`, `options_execution_quality`,
`options_iv_history` all return 404). I have no DDL execution path against your production database
(no `psql` connection string, no authenticated Supabase CLI session, and PostgREST — the only
Supabase access this session has — cannot run arbitrary SQL). **Per this phase's own instruction,
AUTO stays untouched and nothing forward-validation-related can start until you apply:**

1. `src/options-auto/migrations/008_order_intents.sql`
2. `src/options-auto/migrations/009_live_data_capture.sql`
3. `src/options-auto/migrations/010_shadow_and_forward_ledger.sql` (new this phase)

Paste each into your Supabase SQL editor, in order, then tell me — I'll re-verify all tables/indexes
exist and re-run the concurrency proof (`orderIntent.test.ts`, already passing against the in-memory
model; a live check just confirms the real index behaves the same way).

## What was built this phase (real, tested, shipped)

- **`FORWARD_VALIDATION_PROTOCOL.md`** — the frozen-rules document, committed before any data
  exists, per Task 8.
- **`src/options-auto/migrations/010_shadow_and_forward_ledger.sql`** — adds `SHADOW` as a documented
  valid `execution_mode`, and the append-only `options_forward_validation_ledger` table.
- **`src/quant/execution/forwardLedger.ts`** — `recordSignal`/`recordOutcome`, with the "never edit a
  pre-trade field after outcome" guarantee enforced at the TYPE level (`ForwardOutcome` and
  `ForwardSignal` share zero keys — a test asserts this directly), not just by convention. 4 tests.
- **`src/quant/analytics/rollingMetrics.ts`** — 20/30-trade rolling expectancy/profit-factor/win-rate,
  monitoring-only (never triggers a stop on its own — that stays `dailyRiskLock.ts`'s job). 3 tests.
- **`src/quant/analytics/dataQualityHealth.ts`** — the health panel (Task 14): ingestion success,
  missing bid/ask %, stale-quote %, missing-IV %, execution-telemetry success %, IV-history
  coverage %, all reported as `null` (never fabricated) when the input to compute them doesn't
  exist yet, plus a `hasQualityIssue` flag a caller must surface rather than silently continue past.
  5 tests.
- **`src/quant/execution/empiricalExecutionModel.ts`** — the calibration framework for
  `REALISTIC_EMPIRICAL_V1` (Task 9): refuses below 30 observations (matching the protocol's own
  minimum), computes real spread/slippage/latency distributions from `ObservedFill[]`, and builds a
  `FillSimulatorConfig` **without ever mutating `REALISTIC_V1`** (a test asserts this directly by
  hashing `REALISTIC_CONFIG` before/after). 5 tests.
- **`SHADOW_EXECUTION_V1`** added to `fillSimulator.ts` — currently structurally identical to
  `REALISTIC_V1` but exported and named separately so it can diverge once calibrated, without
  touching `REALISTIC_V1`.
- **SHADOW mode wired into `api/options-autotrade.ts`'s `handlePaperScan`**: `execution_mode =
  'SHADOW'` is now accepted, sizes against the real Kite account balance (same as AUTO, so the
  hypothetical intent reflects what AUTO would actually have sized), **skips the broker-
  reconciliation gate** (that gate exists only to protect a real order, which SHADOW never places),
  and **places zero broker orders** — it falls through to the exact same simulated-fill code path
  PAPER already uses (`runPaperExecution`), which is the scoped-down decision explained below.
  Position-monitor's real-closing-order branch is already gated on `execution_mode === 'AUTO'`
  specifically (pre-existing code, re-verified this phase) — a SHADOW position is structurally
  incapable of triggering a real closing order.

## What was scoped down, and why (read this before trusting SHADOW output)

**SHADOW currently simulates fills via `runPaperExecution` (instant, at the live-quoted decision
price) rather than the live-bid/ask-based `SHADOW_EXECUTION_V1` model (Task 6).** The
`SHADOW_EXECUTION_V1` config and the `LegQuote`/`simulateStructureFill` machinery it would need
already exist and are unit-tested (`fillSimulator.test.ts`, from an earlier phase) — what's missing
is the specific wiring inside `handlePaperScan` that would extract each selected leg's real bid/ask/
depth from the already-enriched live quote data and feed it through `simulateStructureFill` instead
of `runPaperExecution`. I made a deliberate call not to attempt that specific piece of surgery in
this session: it sits inside the same ~1,900-line production dispatch function that scans real
market data and (in AUTO mode) places real orders, and I have no way to integration-test it against
a live Kite session from here. Wiring it incorrectly risks a real production regression for a
research-quality improvement that can wait one more pass. **This is the single most important thing
to finish before treating SHADOW data as reflecting genuinely observed execution quality** rather
than the same optimistic assumption the historical backtest already used.

**The `options_chain_snapshots` and `options_execution_quality` tables are schema only** — no insert
calls were added to `handlePaperScan`/`handlePositionMonitor` this phase, for the same reason above
(risk of destabilizing the live scan/monitor loop without a way to test the change against a real
session). The forward-validation ledger (`options_forward_validation_ledger`) IS wired at the
application-code level (`forwardLedger.ts`, tested), but **is not yet called from
`handlePaperScan`** — recording a real signal there is the next concrete step, not attempted this
pass for the same reason.

## Sections not applicable yet (require real collected data first)

- **§9 empirical execution model / §10 replay with empirical execution**: the calibration function
  exists and is tested against synthetic `ObservedFill[]` data proving its logic is correct, but
  **zero real observations exist** — cannot run for real yet.
- **§11 BANKNIFTY/SENSEX forward collection**: no new mechanism needed beyond what already exists
  (the scan runs per-symbol already) — but since snapshot capture itself isn't wired yet (see
  above), nothing is being collected for any symbol, including NIFTY, right now. Both remain
  `FORWARD_DATA_ONLY` per the prior phase's finding, unchanged.
- **§12/13 rolling monitoring / daily-lock observability**: the computation functions exist and are
  tested (`rollingMetrics.ts`); nothing to compute yet since no forward trades exist.
- **§15 FORWARD_VALIDATION_REPORT.md**: not written. Per §8's own stated minimum (30 completed NIFTY
  SHADOW trades AND 3 months elapsed, whichever is longer), and given zero trades and zero elapsed
  time exist, the honest status is **"minimum not yet met — 0/30 trades, 0/~90 days elapsed."**
  Writing a report now would violate this phase's own protocol.

## What actually needs to happen next, in order

1. **You** apply the three migrations (§0/1 above) to production Supabase.
2. I re-verify the tables/indexes exist, then wire the two remaining pieces honestly scoped down
   above: (a) `options_chain_snapshots`/`options_execution_quality` inserts at the actual live-quote
   and fill points in `handlePaperScan`/`handlePositionMonitor`, and (b) the live-bid/ask
   `SHADOW_EXECUTION_V1` fill path, replacing SHADOW's current `runPaperExecution` fallback.
3. You (or a scheduled cron) sets `execution_mode = SHADOW` and lets it run.
4. Forward data accumulates. Nothing in §9-§15 can produce a real answer before that.

## Test results this phase

17 new tests (`forwardLedger.test.ts`, `rollingMetrics.test.ts`, `dataQualityHealth.test.ts`,
`empiricalExecutionModel.test.ts`), all passing. **325 total quant tests, 35 options-auto tests,
both typechecks clean, build clean.** No strategy parameter was changed. `USE_NET_EV_RANKING` remains
`false`. AUTO was not enabled and no real broker order was placed anywhere in this phase.
