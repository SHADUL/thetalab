# Nifty Alpha Ladder — Implementation Plan

Companion to `NIFTY_ALPHA_LADDER_SPEC_RECONSTRUCTION.md`. This plan describes **how** the reconstructed spec would be built inside thetalab, in the milestone order you specified. **No code is written yet.** This plan itself is gated on you resolving Ambiguities A1 and A4 from the spec document — they change the shape of Milestone 2's core engine, so starting to code before they're answered risks building the wrong thing twice.

**Revision note (this version)**: per your follow-up instruction, the execution-mode architecture is now **SHADOW / AUTO only — PAPER is removed from this product entirely**. This changes nothing about the strategy logic itself (still exactly the PDF, unchanged) — it only changes which execution modes exist and how the milestones map onto them. See §1 below.

---

## 0. Isolation from Options Auto-Trader (your §57)

- New top-level directory `src/nifty-alpha-ladder/` — zero imports from `src/quant/` (Options Auto-Trader's engine) or `api/options-autotrade.ts`.
- New database tables, all prefixed `alpha_ladder_*` (mirroring the `options_autotrade_*` / `vwap_scalper_*` naming convention already used for the other two strategy families in this codebase) — never reusing or altering `options_autotrade_*` tables.
- New API surface: `api/nifty-alpha-ladder.ts`, a **separate serverless function file**, following the exact same dispatch-by-`resource`-query-param pattern already established in `api/options-autotrade.ts`. Nifty Alpha Ladder gets its own file, not a new resource bolted onto the existing one.
- New settings row (own table `alpha_ladder_settings`, single row `id=1`, same pattern as `options_autotrade_settings`) — own `execution_mode`/`active_broker`, per Ambiguity A6 pending your confirmation. `execution_mode` for this table has exactly two valid values: `SHADOW`, `AUTO` (see §1).
- Shared infrastructure reused **only where semantics genuinely match** (your explicit instruction): candidates identified below, each flagged for review before reuse, never assumed compatible.
- After every phase: run the existing regression suites (`npm run options-auto:test`, `npm run quant:test`, `npm run vwap-scalper:test`, `npm run swing:test`, `npm run intraday:test`) to prove zero regressions on existing strategies. **PAPER mode in Options Auto-Trader and VWAP Scalper is untouched by any of this work** — this removal applies only to Nifty Alpha Ladder's own, brand-new module; nothing here alters those other products' PAPER mode, settings, types, or tests.
- Git hygiene per your §58: every commit stages **explicit named files only**, never `git add .` / `git add -A`.

---

## 1. Execution-mode architecture: SHADOW and AUTO only, no PAPER

This is a product decision layered on top of the PDF's own strategy logic — the PDF itself doesn't prescribe execution modes at all (that's a thetalab platform concept, same as Options Auto-Trader's OFF/PAPER/SHADOW/AUTO). For Nifty Alpha Ladder specifically:

| Mode | What runs | Broker orders |
|---|---|---|
| **SHADOW** (default) | The **full production strategy** — real depth-derived G₁/G₂, real India VIX, real signal timing, real expiry/strike resolution, real option quotes, real sizing, real execution-sequencing simulation, real fill-gate simulation, real monitor futures target, real exit-lifecycle simulation | **Zero.** Every fill is simulated against real live quotes/depth, never assumed at LTP. |
| **AUTO** | The **exact same strategy decisions as SHADOW** — no strategy logic differs | **Real.** Hedge-first entry sequence, dual-source fill confirmation, rollback, broker reconciliation, short-first exits, monitor-triggered/scheduled/safety-net exits, crash recovery, DB-backed idempotency — all against the real broker. |

**There is no PAPER mode for this strategy, at any milestone.** Concretely, this means:
- No `paper` value in `alpha_ladder_settings.execution_mode`'s check constraint — only `'SHADOW'` / `'AUTO'`.
- No paper-balance, paper-fill-simulation-at-LTP, paper-only settings fields, paper position rows, or paper history views anywhere in `src/nifty-alpha-ladder/`.
- No "paper execution branch" in `execution/entryExecutor.ts` or `exit/exitEngine.ts` — there is exactly one execution-simulation code path (the one SHADOW uses), and AUTO reuses the **same decision output**, differing only in the final "place a real order" vs "record a simulated fill" step.
- Types (`types.ts`), API validation (`api/nifty-alpha-ladder.ts`'s settings PUT handler), UI (`src/nifty-alpha-ladder/ui/` or `src/components/NiftyAlphaLadder.jsx`), and every test's expectations reference only `SHADOW`/`AUTO`.
- The one exception your own instruction allows: if a **lower-level shared type** (something outside `src/nifty-alpha-ladder/` that Nifty Alpha Ladder is forced to reuse) already has a broader mode union including `PAPER` for backward compatibility with Options Auto-Trader/VWAP Scalper, Nifty Alpha Ladder's own code narrows to `'SHADOW' | 'AUTO'` at its own boundary rather than either widening that shared type or forking it. In practice I don't expect this to come up — the reuse candidates identified below (broker-position fetchers, holiday calendar, basket-margin quote) are mode-agnostic functions with no PAPER concept baked into their own signatures.

**Design consequence for the engine**: because SHADOW and AUTO must produce **identical strategy decisions**, the signal engine, instrument resolution, sizing and payoff math (all of Milestone 2) are written with **zero knowledge of execution mode at all** — they take market data in and return a decision out, full stop. Execution mode is a property of exactly one downstream layer: the entry/exit executors, which either simulate a fill or place a real order. This isn't a new constraint introduced by removing PAPER — it was already true of the pure-math modules in the original plan — but removing PAPER makes it verifiable directly: there is now only one non-AUTO code path to compare AUTO against, not two.

---

## 2. Blocking prerequisites (must be answered before Milestone 2 starts)

1. **Ambiguity A1** (spec doc §18): what NSE instrument's depth is "the NIFTY book" really drawn from in production. This determines whether `data/depthCollector.ts` subscribes to NIFTY futures depth, a different futures series, or cannot be built on Kite/Groww retail data at all.
2. **Ambiguity A4**: depth-feed architecture. A WebSocket-based always-on collector is a **new class of infrastructure** for this codebase (everything today is stateless serverless + external cron pings). This is a real infrastructure decision — where does it run, who operates it, what's the acceptable data-loss window if it restarts — not something to default silently. This now matters even more than before: with no PAPER mode, SHADOW is the *only* non-AUTO way to validate the strategy, and SHADOW requires this real feed from day one of Milestone 3 (there's no PAPER fallback to build against in the meantime).
3. **Ambiguity A2**: confirm the single-account collapse of "subscriber" semantics.
4. **Ambiguity A6**: confirm Nifty Alpha Ladder gets its own independent broker/mode setting.
5. **Ambiguity A7**: confirm Kite actually serves India VIX at 15-minute bar granularity.

None of these block writing the **pure, broker-independent math** (G₁/G₂ computation given already-supplied event data, the alignment rule, Variation C, the payoff formulas, the sizing arithmetic) — that code has no dependency on where the depth events came from, and no dependency on execution mode either. So Milestone 2 can start on synthetic/fixture data (exactly the worked example in spec §15) while A1/A4 are resolved in parallel, **as long as no depth-collection or broker-execution code is written until they're answered**.

---

## 3. Milestone 1 (this deliverable)

- [x] `NIFTY_ALPHA_LADDER_SPEC_RECONSTRUCTION.md`
- [x] `NIFTY_ALPHA_LADDER_IMPLEMENTATION_PLAN.md` (this file, now revised for SHADOW/AUTO-only)
- **STOP.** Awaiting your review before any code.

---

## 4. Milestone 2 — Pure strategy engine only

No execution, no broker, no simulated fills, no market-data connection at all. Scope: everything that is pure computation, deterministic, and testable against the spec's own worked example.

### 4.1 Types and parameters
- `types.ts`: all domain types — `Direction`, `SignalRecord`, `LargeOrderEvent`, `AggregateSnapshot`, `LegTemplate`, `ResolvedLeg`, `Payoff`, `ExecutionMode = 'SHADOW' | 'AUTO'`, etc. Mirrors the PDF's own notation (spec §3) so the code reads like the formulas.
- `parameters.ts`: the θ₁–θ₃₉ register from spec §2, each with `{symbol, name, value, unit, description, sourceSection, version}` per your §48. `strategy_version = HEDGED133_V3_0` stamped alongside.

### 4.2 Calendar
- `calendar/signalCalendar.ts`: Gates 5.1–5.3 (trading day, Wednesday/Thursday-fallback weekday, session window). Needs an NSE holiday calendar — check whether one already exists in this codebase as a reuse candidate.
- `calendar/expirySelection.ts`: Definition 3.1 exactly (`e*(d)` rule, including the `≤1 day AND |𝔈(d)|>1` edge case).

### 4.3 Signal construction — buildable now against fixtures, independent of A1/A4
- `signal/largeOrderNet.ts`: G₁ (Eq 4.1), reference-threshold recursion (Definition 13.3). Testable in isolation by feeding a synthetic stream of `(price, quantity, orderCount, timestamp)` tuples matching the spec's worked example (§15, Step 3).
- `signal/imbalancePath.ts`: G₂ (Eq 4.3), the `(B_k, A_k, ρ_k)` aggregation (Definition 2.6) — same fixture-testable property, using the worked example (§15, Step 2).
- `signal/signedArea.ts`: the shared trapezoidal-area function 𝒜(u) (Eq 4.2/4.4), one implementation used by both G₁ and G₂.
- `signal/alignmentRule.ts`: Ψ (Definition 4.1) and its closed form (Proposition 4.4).
- `signal/variationC.ts`: 𝒞 (Eq 4.10–4.11), with the explicit asymmetry (bearish never reversed) as a first-class invariant test.
- `signal/signalEngine.ts`: composes the above into the full `τ*`/`d₁`/`d₂`/`D₀`/`D` pipeline (Eq 4.5–4.11) — receives already-collected event data and returns a decision. **This module has no notion of SHADOW or AUTO; it is the single decision source both modes call identically.**

### 4.4 Instrument resolution
- `instruments/strikeResolver.ts`: strike step (Definition 3.2, derived from listed strikes, never hard-coded 50) and ATM (Definition 3.3, lower-strike tie-break).
- `instruments/expiryResolver.ts`: wraps `calendar/expirySelection.ts` with an actual listed-expiry lookup (reuse candidate: `src/lib/optionsInstrumentMaster.js`, pending a semantics check).
- `instruments/ladderTemplate.ts`: the declared bearish template (spec §7 leg table) and mirror operator `ℳ`, plus the atomic single-query resolution (`𝓡(D,d,S)`, Eq 3.1) that returns `null` on any missing leg.

### 4.5 Risk / payoff math
- `risk/payoff.ts` (new module, not in your original suggested tree but required by spec §7/§12): `V⁻(S_T)` (Eq 6.6), max loss/gain/tail (Eq 6.7), break-evens (Proposition 6.3), Greeks characterisation (Eq 11.3). Pure functions.

### 4.6 Sizing
- `sizing/unitSizing.ts`: Definition 6.1 (unit mode).
- `sizing/quantitySizing.ts`: Definition 6.2 (quantity mode) + structure-proxy margin rule.
- `sizing/capitalGate.ts`: Gate 5.12 / Definition 15.1 head-room formula, under Ambiguity A2's single-account collapse.

### 4.7 Tests for Milestone 2
CALENDAR, G1, G2, ALIGNMENT, VARIATION C, EXPIRY, ATM, STRUCTURE, PAYOFF, SIZING — all pure-function tests, no broker/data/execution-mode dependency. The full worked example (spec §15) becomes one end-to-end fixture test exercising signal→structure→payoff with known-correct intermediate values at every step.

**Explicit exclusion from Milestone 2**: `data/depthCollector.ts`, `data/vixReader.ts`, `data/futuresReader.ts`, anything execution-related — blocked on Ambiguities A1/A4/A7, and out of scope for a pure-strategy milestone regardless.

**STOP after Milestone 2. Report test results before Milestone 3.**

---

## 5. Milestone 3 — SHADOW: real live market data, simulated execution, zero broker orders

Only after Milestone 2 is approved and A1/A4/A7 are resolved (real depth collection can only be built once we know what it's collecting). This milestone builds the **entire production strategy end to end**, live, on real data — the only thing it does not do is place a broker order.

### 5.1 Real data layer
- `data/depthCollector.ts`, `data/aggregateImbalance.ts`, `data/vixReader.ts`, `data/futuresReader.ts`: real, live-data-connected sources feeding the Milestone-2 pure functions. Shape depends entirely on the A1/A4 resolution.
- `data/largeOrderReference.ts`: the persistent, cross-invocation reference-threshold state (Definition 13.3's `q̂_σ`) — durable storage, since it accumulates across the whole session, not per-invocation.

### 5.2 Simulated execution (SHADOW's own realism requirement, no LTP shortcuts)
- `execution/marketableLimit.ts`: Definition 7.2 (buffer/rounding formula) — pure, testable immediately, shared by SHADOW's simulation and AUTO's real order pricing later.
- `execution/entryExecutor.ts`, `execution/fillGate.ts`, `execution/rollback.ts`: SHADOW versions run the full state machines of spec §8/§17 against **real bid/ask and depth**, simulating a realistic fill (reference LTP vs limit vs observed bid/ask, slippage, time-to-fill) — never fill-at-LTP. This is the direct architectural analogue of Options Auto-Trader's own SHADOW convention (`src/quant/execution/shadowExecution.ts`) but a new implementation, since Nifty Alpha Ladder's fill/gate semantics differ enough that literal reuse would blur strategy-specific behavior.
- `monitor/futuresMonitor.ts`, `monitor/targetEngine.ts`: Definition 8.1–8.2 — the futures target ladder and chained-exit trigger, live, on the real future's tick stream.
- `exit/exitEngine.ts`, `exit/shortFirstExit.ts`, `exit/repricing.ts`, `exit/scheduledExit.ts`, `exit/safetyExit.ts`, `exit/leftoverCheck.ts`: the full exit lifecycle of spec §10, simulated against real quotes, including the shorts-first invariant as a hard-enforced code path and the repricing schedule (Eq 9.2).

### 5.3 Persistence and telemetry (full production-validation record)
- `persistence/*`: durable state machines (spec §14) — signal/call/entry/order tables and repositories, DB-backed idempotency (your §37) for weekly signal, call creation, entry orders, rollback, monitor exit, scheduled exit, safety exit. Same atomic-conditional-UPDATE pattern already used throughout `handlePositionMonitor` in this codebase.
- `research/auditLogger.ts`: full telemetry, exactly the list you specified — signal inputs, G₁/G₂, d₁/d₂, alignment, D₀, Variation C, final direction, resolved legs, simulated entry prices, simulated fills, simulated slippage, monitor target, simulated exits, realised simulated P&L, all timing, all failure/recovery states. Mirrors the existing `options_autotrade_log` append-only pattern (new table).
- `execution/reconciliation.ts`: even in SHADOW there are no broker orders to reconcile against, so this module's SHADOW-mode responsibility is internal consistency checking (ledger vs simulated state) rather than broker-truth comparison; it becomes broker-facing only in Milestone 5 (AUTO).

### 5.4 Tests for Milestone 3
Every entry leg fills (simulated); leg 1/2/3 rejected (simulated); fill timeout (simulated); rollback triggers correctly on simulated failures; no-uncovered-short invariant holds throughout; MONITOR tests (bullish/bearish 300, Monday/Tuesday 400); EXIT tests (futures target exit, scheduled 15:10, safety 15:20, short-first exit, no over-exit) — all against simulated fills; CRASH RECOVERY (restart after each major state transition, resuming from durable state); IDEMPOTENCY (duplicate signal/entry/exit invocation). Plus: **`broker_order_count === 0` for every SHADOW run, asserted explicitly** — this is the one invariant that most directly proves SHADOW never touches a broker.

**STOP after Milestone 3. Conduct replay tests before Milestone 4.**

---

## 6. Milestone 4 — AUTO readiness report

A **report only** — no AUTO execution code is written in this milestone. Deliverable: `NIFTY_ALPHA_LADDER_AUTO_READINESS_REPORT.md`, covering, with evidence:

1. Core engine (Milestone 2) passes its full test suite.
2. Replay (spec §15's worked example and any additional historical replay) matches expected strategy behavior exactly.
3. SHADOW (Milestone 3) has run against real live data for a sustained period, producing coherent, auditable telemetry — signal fired correctly, structure resolved correctly, simulated fills were realistic, monitor target logic behaved correctly, scheduled/safety exits behaved correctly.
4. Crash recovery has been demonstrated (a deliberate mid-state kill-and-resume in SHADOW, not just an assertion on stored state).
5. Rollback has been demonstrated (a deliberately-triggered simulated entry failure in SHADOW, proving the compensating logic actually runs end to end).
6. Reconciliation logic has been exercised (even without a broker, the ledger/state-consistency checks of §5.3 above have run and passed).
7. Scheduled exit and monitor-triggered exit have both actually fired at least once in SHADOW, not merely unit-tested.

**AUTO remains disabled regardless of this report's conclusions.** The report is decision support for you; it is not an activation switch, and I will not build or enable Milestone 5 without your explicit, separate approval after reading it.

---

## 7. Milestone 5 — AUTO integration (only after your explicit approval)

Adds the **real-broker execution path**, reusing the exact same decision output SHADOW already produces (per §1's design consequence — no strategy logic differs). Concretely:

- `execution/entryExecutor.ts` gains its real-order branch: hedge-first entry sequence placed for real, dual-source fill confirmation against the real broker, rollback executed with real compensating orders.
- `execution/reconciliation.ts` gains its real broker-truth comparison, reusing the **broker-position-fetch functions** already built for Options Auto-Trader (`fetchGrowwBrokerPositions`, `fetchBrokerPositions` for Kite) as a strong reuse candidate — these are broker-API wrappers with no Options-Auto-Trader-specific business logic, a good semantics-match case. The reconciliation *logic* (what counts as a mismatch) is still Nifty Alpha Ladder's own, since its ledger shape differs from Options Auto-Trader's.
- `exit/*` gains real short-first exits, real monitor-triggered/scheduled/safety-net exits against the broker.
- Crash recovery and DB-backed idempotency (already proven in SHADOW, §5.3) now guard real orders instead of simulated ones — same code paths, same durable-state design, higher stakes.
- **Parity test, required before AUTO is ever enabled**: for identical market inputs, assert `SHADOW decision === AUTO decision` — same signal time, direction, expiry, ATM, legs, unit count, monitor target, exit reason. Only the execution side effect (simulated fill vs real order) may differ. This is the direct, automated proof that AUTO never diverges from the strategy SHADOW already validated.
- AUTO activation itself goes through the same confirmation/safety workflow already established for Options Auto-Trader's own AUTO mode (an explicit UI warning before a setting change that starts placing real orders) — not a silent settings flip.

---

## 8. UI (your §40–§44, revised for SHADOW/AUTO only)

New nav entry `Nifty Alpha Ladder` in `src/Root.jsx`'s `ALL_SECTIONS`, between Options Auto-Trader and VWAP Scalper. Given `ONLY_OPTIONS_AUTO` currently hides everything except Options Auto-Trader (temporary/reversible), Nifty Alpha Ladder's nav visibility while that flag is still `true` needs your call — hidden alongside the other sections until you flip it back, or shown regardless. **Flagging, not deciding.**

**Execution-mode control** shows exactly two options, not four:

```
[ SHADOW | AUTO ]
```
- **SHADOW**: "Live strategy · simulated execution · zero broker orders"
- **AUTO**: "Live strategy · real broker orders"
- **Default**: SHADOW.
- **AUTO requires the existing confirmation/safety workflow** before activation (same pattern as Options Auto-Trader's own real-money warning) — never a bare toggle.

New component `src/components/NiftyAlphaLadder.jsx` (or a `src/nifty-alpha-ladder/ui/` subtree — your call, both keep it isolated). Reuses the shared `--c-*` design tokens every other page already uses — **not** the `.oat-page` scoped premium theme built specifically for Options Auto-Trader, to keep the "completely separate module" boundary clean. Dashboard, position display, monitor display and timeline exactly as you specified (mode/broker/next-signal-day/signal-status/order-flow-read/position/monitor/timeline panels) — updated only to drop every PAPER-mode reference (mode badge shows SHADOW or AUTO, never a third/fourth option).

---

## 9. Open questions for you (summary, cross-referenced to the spec doc)

1. A1 — what real instrument backs "the NIFTY book" depth (spec §18).
2. A2 — confirm single-account collapse of "subscriber."
3. A4 — where does the always-on depth collector run; who operates it; acceptable restart data-loss window. (Now the single highest-priority answer — SHADOW is the *only* pre-AUTO validation path, and it needs this from day one of Milestone 3.)
4. A6 — Nifty Alpha Ladder's own broker/mode setting, confirm.
5. A3 — futures exit repricing schedule: genuinely unspecified in the source document, or does it exist in a companion document you have?
6. A7 — confirm Kite serves India VIX at 15-minute bar granularity.

I'll wait for your review of all three documents, and answers to the above, before writing any code.
