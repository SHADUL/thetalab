# Nifty Alpha Ladder — Milestone 3 (SHADOW) Report

**Status: partially complete, stopped for your review as requested — a real external blocker (Railway's free-plan resource limit) was hit while provisioning the worker, and I did not want to keep building on top of an unresolved infrastructure question. This report is honest about what is built-and-tested vs. designed-but-not-yet-live-verified.**

---

## 1. Architecture (as built so far)

```
LIVE MARKET DATA (Kite WebSocket — designed, not yet connected live)
        ↓
NORMALISED EVENTS (live/depthSource.ts's NormalizedDepthTick)
        ↓
APPROVED MILESTONE-2 PURE ENGINE (unchanged, reused directly — see §6)
        ↓
STRATEGY DECISION
        ↓
INSTRUMENT RESOLUTION (Milestone-2, reused directly)
        ↓
SHADOW EXECUTION SIMULATOR (execution/*, exit/*, monitor/* — built & tested)
        ↓
DURABLE SHADOW LEDGER (migrations/001_alpha_ladder_schema.sql — designed, NOT applied)
        ↓
MONITOR / EXIT ENGINE (monitor/futuresMonitor.ts, exit/shortFirstExit.ts — built & tested)
        ↓
SHADOW P&L + TELEMETRY (schema designed; wiring to persist real telemetry rows — NOT built yet)
```

Every box above the dashed line ("durable" and below) is real, working, unit-tested TypeScript. The top box (actually connecting to Kite's live WebSocket and running continuously) is designed against the `AlphaLadderDepthSource` interface but **not yet running anywhere** — see §4.

---

## 2. Market-data capability findings

See `NIFTY_ALPHA_LADDER_MARKET_DATA_CAPABILITY_REPORT.md` (delivered earlier this session). Summary: real, empirically-verified findings via a live read-only Kite probe —

- **A1**: nearest NIFTY future (`NIFTY26OCTFUT`) gives **5-level depth with real order counts**. Real but limited — explicitly not claimed as "full book."
- **A7**: India VIX has **native 15-minute historical bars** — resolved, no aggregation needed, no semantics change required.

## 3. Exact live depth source

`FUTURES_DEPTH_FALLBACK_MODE` / `depth_source = 'NIFTY_NEAREST_FUTURE'`, per your confirmed A1 decision. Never labeled as the NIFTY spot order book.

## 4. Worker deployment architecture — **BLOCKED, needs your decision**

Per your instruction, I attempted to provision a Railway service named `thetalab-market-stream-worker`. Result:

> `create-project` failed: **"Free plan resource provision limit exceeded. Please upgrade to provision more resources!"**

Your Railway account (workspace "shadul's Projects") currently has 2 existing projects (`tradevault`, `hospitality-os-api`), neither related to thetalab, and the free tier's project cap is already reached. **Nothing was created — no partial state was left behind.** Three ways forward, your call:

1. Upgrade the Railway plan, then I provision the project + service in one pass.
2. Add the worker as a new **service** inside one of your existing projects instead of a new project (possible, but mixes an unrelated app's project with this one — not recommended without your say-so).
3. You create the project yourself in the Railway dashboard and hand me its project ID; I create the service inside it.

**Until this is resolved, the worker has no running home.** The worker's own source code (the depth-collection glue, connection supervisor, signal-evaluation scheduler) was not yet written as a standalone deployable service, since writing an entrypoint for a host that doesn't exist yet risked producing unverifiable, unreviewable filler code — the actual logic it would call (large-order/imbalance builders, signal engine, execution simulator) is already built and tested in `src/nifty-alpha-ladder/`, ready to be wired into a real worker process once a host exists.

## 5. India VIX (A7) result

Native 15-minute bars confirmed available (71 real candles returned for a 2-day window). Timestamps appear to be bar-START (first candle of the day stamped exactly 09:15:00). Used as-is per your instruction's "if YES, use them" branch — no semantics change, no approval gate needed.

## 6. Database schema / migrations

`src/nifty-alpha-ladder/migrations/001_alpha_ladder_schema.sql` — **written, NOT applied.** 13 tables, all `alpha_ladder_`-prefixed:

`alpha_ladder_settings`, `alpha_ladder_worker_health`, `alpha_ladder_feed_gaps`, `alpha_ladder_large_order_reference`, `alpha_ladder_large_order_events`, `alpha_ladder_imbalance_snapshots`, `alpha_ladder_signals`, `alpha_ladder_calls`, `alpha_ladder_monitor_state`, `alpha_ladder_positions`, `alpha_ladder_legs`, `alpha_ladder_shadow_orders`, `alpha_ladder_activity_log`, `alpha_ladder_reconciliation`.

Notable design choices: `alpha_ladder_signals.week_key` has a `unique` constraint (Gate 5.4's idempotency, DB-enforced not in-memory); `alpha_ladder_shadow_orders.broker_order_id` is documented in-schema as "always null in Milestone 3" (and a test asserts that comment exists verbatim, so a careless future edit can't silently drop the safety note); `alpha_ladder_worker_health` is append-only per connection-generation, so a restart is a new row, never an overwritten one.

**RLS**: enabled on every table, no policies defined yet (matches this repo's existing convention — access is via the service-role key from server-side code only, same as every `options_autotrade_*`/`vwap_scalper_*` table).

**STOP — do not apply this migration until you've reviewed it.** Once you have, run it in the Supabase SQL editor same as the Milestone-2 migrations before it.

## 7. Feed-health / freshness policy

`live/connectionSupervisor.ts` — built & tested (11 tests). `deriveHealthStatus` never reports `HEALTHY` from process-liveness alone; it requires a fresh `lastSocketMessageAtMs` (< 30s old during market hours) AND completed warmup. States: `STARTING/CONNECTING/WARMING_UP/HEALTHY/DEGRADED/STALE/RECONNECTING/FAILED/MARKET_CLOSED`, exactly your list.

## 8. Data-gap policy

`deriveSessionQuality` / `canFireNewSignal` — a material gap (`hasUnrecoverableGapThisWeek`) forces `INVALID_FOR_NEW_SIGNAL` for the **whole week**, independent of current health — tested explicitly. Exit-monitoring-vs-signal-firing are modeled as genuinely separate concerns (the function only answers "can a new signal fire," never conflated with "can an existing position still be monitored").

## 9. SHADOW fill model

`execution/shadowFillModel.ts` — deterministic, conservative. A BUY only fills when the observed ask crosses the limit; a SELL only on the bid. Classifies `TOUCH_FILL`/`DEPTH_FILL`/`DELAYED_FILL`/`LIMIT_NOT_MARKETABLE`/`TIMEOUT`. **Exchange queue position is explicitly NOT modeled** — documented in the module's own header as a real limitation of this data granularity, not silently assumed away.

## 10. Entry state machine

`execution/entrySequencer.ts` — strict 3-leg placement order (Buy ATM → Buy far → Sell middle), never reordered. Every leg simulated via the fill model above; any non-first-leg failure triggers `ROLLBACK` with exactly the previously-filled legs flagged for unwind; a first-leg failure is `ABANDONED` with nothing to unwind. `noNakedShortInvariantHolds` is a standing, independently-tested assertion.

## 11. Rollback behavior

`execution/rollback.ts` — reverse placement order, one compensating order per filled leg, halts (does not guess) if a compensating order can't be established (Definition 10.3's residue guard) — tested for both the full-unwind and the halted-residue cases.

## 12. Monitor behavior

`monitor/futuresMonitor.ts` — F0 never mutated; 300pts Wed–Fri / 400pts Mon–Tue; `targetHit`/`targetProgress` tested against the PDF's own worked-example F0 (24,211.80). Genuinely logical/simulated — no futures order of any kind, per your explicit instruction.

## 13. Exit behavior

`exit/shortFirstExit.ts` — all SELL-entered legs close first; longs release **only if every short closed**; a failed short leaves longs `heldOpenLegIndices`, never silently treated as closed. `exit/repricing.ts` reproduces θ30/θ31's exact bands.

## 14. P&L methodology

**Not yet built.** The schema has the columns (`net_debit_points`, `max_loss`/`max_gain`/`tail_value` on `alpha_ladder_positions`; `fill_price_simulated`/`slippage_vs_reference` on `alpha_ladder_shadow_orders`), but the actual "compute realized SHADOW P&L from simulated fills, separate from theoretical payoff" wiring is not written. Flagged honestly rather than left ambiguous.

## 15. Crash-recovery proof

**Not yet demonstrated.** The schema is designed for it (durable state per leg/order, connection-generation-scoped health rows), and the entry/exit state machines are pure functions over explicit state (which is what makes recovery possible in principle), but there's no actual "kill mid-state and resume" test yet — this needs the persistence-writing layer to exist first, which isn't built.

## 16. Idempotency proof

**Partially designed, not proven.** `alpha_ladder_signals.week_key unique` and `alpha_ladder_calls (signal_id, kind) unique` are DB-enforced idempotency keys, matching this codebase's own established atomic-conditional-update pattern — but no code yet actually exercises "duplicate invocation → one signal" end-to-end (needs the worker/API wiring that doesn't exist yet).

## 17. Test results

**106/106 passing** in `src/nifty-alpha-ladder/` (30 new this milestone: entry sequencing, rollback, short-first exit, repricing schedule, futures monitor, connection supervisor/session-quality, marketable limit, fill model, mode safety). Categories covered from your requested list: SHADOW ENTRY (successful entry, each-leg-fail, rollback, no-naked-short), MONITOR (300/400 targets, hit detection, progress clamping), EXIT (short-first, short-failure-preserves-longs, reprice schedule), MODE SAFETY (static scan proves zero broker-order-mutation references). **Not yet covered**: WORKER (connect/disconnect/reconnect against a real or faked socket), DEPTH live-pipeline tests (state changes/disappearance/reappearance/warmup persistence wired to a live feed), G2 LIVE PIPELINE (3-min bucket restart-mid-bucket), SIGNAL live-vs-fixture parity, CRASH RECOVERY, IDEMPOTENCY end-to-end — all blocked on the worker/persistence layer not existing yet.

## 18. Existing regression results

**Zero regressions.** All 833 existing tests pass unchanged: options-auto (35), quant (419), vwap-scalper (189), swing (105), intraday (85). Frontend build succeeds unchanged.

## 19. UI/API changes

**Not built yet** beyond the read-only diagnostic probe (`resource=alpha-ladder-probe` in `api/options-autotrade.ts` — folded into that file, not a standalone `api/nifty-alpha-ladder.ts`, see §22). No UI at all yet. Deferred deliberately rather than building a dashboard against data that doesn't exist yet (no live signals, no SHADOW positions to display).

## 20. Known limitations

- 5-level futures depth, not full exchange book (disclosed in the capability report).
- Exchange queue position is not modeled in the fill simulator.
- The VIX bar's "still forming" behavior at τ* is the PDF-permitted case, not a defect, but worth remembering when reading a SHADOW signal's VIX value.
- The live WebSocket connection's actual reconnect behavior is unverified — `connectionSupervisor.ts`'s logic is tested in isolation, not against a real flaky socket.

## 21. Remaining AUTO blockers

- **AUTO_BLOCKER_A3**: futures exit-repricing schedule remains genuinely unspecified in the source PDF. Does not block SHADOW (no real futures order is ever placed); must be resolved before Milestone 5.
- **AUTO_BLOCKER_RAILWAY**: no running worker host yet (§4) — blocks not just AUTO but the rest of SHADOW's live verification too.
- **AUTO_BLOCKER_LIVE_SOCKET**: `KiteAlphaLadderDepthSource`'s real implementation against Kite's `KiteTicker` is not yet written or run-verified.
- Standard Milestone-4-gate items unchanged from the implementation plan: crash recovery, rollback, reconciliation, scheduled/monitor exits all need to be shown working in a real SHADOW run, not just unit-tested, before an AUTO readiness report can be written.

## 22. Exact git diff summary

Two commits this milestone:

1. `55f9d09` → reverted by `966d344` (a standalone `api/nifty-alpha-ladder.ts` broke Vercel deployment — Hobby plan's function-count cap, confirmed live; folded into `api/options-autotrade.ts` instead, same pattern as VWAP Scalper).
2. `1bb5247`: 13 files, +1185/-0 — capability report, DB migration (file only), execution engine (`marketableLimit.ts`, `shadowFillModel.ts`, `entrySequencer.ts`, `rollback.ts`), exit engine (`repricing.ts`, `shortFirstExit.ts`), monitor (`futuresMonitor.ts`), live-connection supervisor (`depthSource.ts`, `connectionSupervisor.ts`), and two new test files (30 tests).

No existing file's business logic was touched except the fully-additive probe handler in `api/options-autotrade.ts` (one new function, one new dispatch line).

---

## What I'd suggest next

Given the Railway blocker, I'd rather get your decision on §4's three options before writing more worker-side code that has nowhere to run yet. Once that's resolved, remaining Milestone 3 work is: the real `KiteAlphaLadderDepthSource` implementation, the persistence-writing layer (turning the schema into actual reads/writes), wiring the execution engine into a real scheduler loop, crash-recovery/idempotency proof, and the API/UI. Happy to continue directly on your word — not starting Milestone 4 regardless, per your instruction.
