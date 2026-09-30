# Nifty Alpha Ladder — Milestone 3 (SHADOW) Report

**Status: substantially built, still not runnable end-to-end live. Railway is `PENDING_HOSTING_DECISION` per your instruction — nothing was deployed, no new/reused Railway project was created. This report replaces the previous version with the requested categorization: BUILT + TESTED / BUILT + NOT LIVE-VERIFIED / BLOCKED ON DB MIGRATION / BLOCKED ON HOSTING / BLOCKED ON REAL MARKET SESSION.**

---

## 1. Architecture (as built)

```
LIVE MARKET DATA (Kite WebSocket)                    [BUILT + NOT LIVE-VERIFIED]
        ↓
NORMALISED EVENTS (live/depthSource.ts, kiteTickerProtocol.ts)   [BUILT + TESTED — fixtures/fake socket only]
        ↓
SESSION ACCUMULATOR (live/sessionAccumulator.ts)     [BUILT + TESTED]
        ↓
APPROVED MILESTONE-2 PURE ENGINE (unchanged, reused directly)    [BUILT + TESTED — Milestone 2]
        ↓
STRATEGY DECISION → INSTRUMENT RESOLUTION            [BUILT + TESTED — Milestone 2]
        ↓
SHADOW EXECUTION SIMULATOR (execution/*, exit/*, monitor/*)      [BUILT + TESTED]
        ↓
DURABLE SHADOW LEDGER (persistence/store.ts + migration)         [BUILT + TESTED (in-memory) / BLOCKED ON DB MIGRATION (real Supabase path)]
        ↓
CRASH RECOVERY (persistence/crashRecovery.ts)        [BUILT + TESTED]
        ↓
SHADOW P&L (risk/shadowPnl.ts)                       [BUILT + TESTED]
        ↓
WORKER ENTRYPOINT (worker/main.ts, npm run alpha-ladder:worker)  [BUILT + NOT LIVE-VERIFIED / BLOCKED ON HOSTING]
        ↓
API (6 read-only resources in api/options-autotrade.ts)          [BUILT + TESTED (build/typecheck) / BLOCKED ON DB MIGRATION at runtime]
        ↓
UI (src/components/NiftyAlphaLadder.jsx)             [BUILT + TESTED — verified live in the browser pane against mocked data]
```

---

## 2. BUILT + TESTED (real code, real passing tests, no live dependency)

All of Milestone 2 (unchanged, 106 tests) plus, new this milestone:

| Module | What it does | Tests |
|---|---|---|
| `live/kiteTickerProtocol.ts` | Binary "full" mode packet parser + frame splitter + subscribe/mode message builders | 5 — round-trips a hand-built 184-byte packet exactly; rejects wrong-length packets; splits multi-packet frames; skips non-full packets |
| `live/kiteDepthSource.ts` | `KiteAlphaLadderDepthSource` — connect/subscribe/health/reconnect logic | 5 — against a fake `WebSocketLike`: subscribe message sequencing (fixed a real double-send bug this caught), tick→`NormalizedDepthTick[]` conversion, health-state transitions (never HEALTHY from a bare `open`), reconnect increments `connectionGeneration`/`reconnectCount` |
| `live/connectionSupervisor.ts` | Health state machine, session-quality gate, reconnect-integrity check | 6 (Milestone 3 part 1) |
| `live/sessionAccumulator.ts` | Live-to-Milestone-2 seam: accumulates ticks, completes θ3/θ4 windows, calls `signalEngine.evaluateSignal` unchanged | 3 — G2 windows complete on the θ4 boundary with correct ρ sign; reference threshold only activates at θ2; end-to-end wiring reaches a well-formed decision |
| `execution/*`, `exit/*`, `monitor/*` | SHADOW execution/exit/monitor engine (Milestone 3 part 1) | 25 |
| `persistence/store.ts` | `AlphaLadderStore` — in-memory implementation | (tested via idempotency tests below) |
| `persistence/crashRecovery.ts` | `determineResumeAction()` | 7 — one per restart point you listed (signal persist, leg-N-filled, rollback-in-progress, entry-complete-not-live, exit-shorts-pending, exit-between-shorts-and-longs) |
| `risk/shadowPnl.ts` | `computeShadowPnl()` | 2 — gross P&L from real fills matches worked-example arithmetic; any open leg nulls the whole result rather than guessing |
| Idempotency (in `persistence.test.ts`) | Duplicate signal/call insert → single row | 3 |
| `__tests__/modeSafety.test.ts` | Static proof: zero broker order-mutation references anywhere in the module | 2 |

**131/131 tests passing.** Zero regressions across all 833 existing tests (options-auto/quant/vwap-scalper/swing/intraday) and the frontend build.

**UI verified live** (not just built): loaded in the browser pane against mocked API responses, confirmed every field renders correctly — signal card, order-flow read, position/legs, max loss/gain/tail, AUTO button visibly present but disabled with an explanatory tooltip, no click path to enable it.

---

## 3. BUILT + NOT LIVE-VERIFIED (real code, no live counterpart tested against)

- **`KiteAlphaLadderDepthSource`'s actual Kite connection**: the class is correct against a *fake* socket; it has never opened a real WebSocket to `wss://ws.kite.trade`. Reconnect behavior against a genuinely flaky real connection is unverified.
- **`kiteTickerProtocol.ts`'s binary parsing**: verified only against hand-constructed buffers matching the *documented* format — never against a captured real Kite packet. This is the single highest-risk unverified piece; if Kite's actual wire format differs from public documentation in any byte offset, this parser would silently misread depth (a real risk, stated plainly, not hidden).
- **`worker/main.ts`**: wires everything together and typechecks, but has never been run — it needs `KITE_API_KEY`/`KITE_ACCESS_TOKEN`/`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (none available to me directly) and a real host to run continuously on.
- **`createSupabaseAlphaLadderStore`**: column-mapped exactly to the migration, but never executed against a real Postgres instance (see §4 — the migration isn't applied).
- **Real NSE holiday calendar**: `worker/main.ts` currently passes `isTradingDay(now, () => false)` — a placeholder that never reports a holiday. Flagged in-code as a TODO; using this as-is would fire signals on real exchange holidays.
- **IST timezone handling in the worker's scheduler**: `worker/main.ts`'s `setInterval` callback currently reads `now.getUTCHours()`/`getUTCMinutes()` directly instead of converting to IST properly — flagged in-code as a known gap, not silently shipped as correct.

---

## 4. BLOCKED ON DB MIGRATION

`migrations/001_alpha_ladder_schema.sql` is **written, reviewed by you, still NOT applied.** Everything that depends on a real Supabase round-trip is blocked on this specifically:

- `createSupabaseAlphaLadderStore` (the real, non-test-double persistence implementation) — will throw "relation does not exist" if used right now.
- All 6 new API resources (`alpha-ladder-settings/summary/signal/positions/activity/health`) — will return `502 supabase_error` right now, an honest failure, not a silent wrong answer.
- The worker's every persistence call.

**Per your instruction, I'm asking explicitly: should this migration be applied now**, so the API/worker have somewhere real to read/write, or do you want to review the schema further first? Everything that could be proven without a live DB (idempotency, crash recovery, P&L, the execution engine) was proven against the in-memory test double instead, precisely so this question could wait until you're ready.

---

## 5. BLOCKED ON HOSTING

Unchanged from the previous report: Railway's free-plan resource limit was hit provisioning `thetalab-market-stream-worker`. **Per your explicit instruction this session, I have not created a new Railway project and have not reused `tradevault`/`hospitality-os-api`.** The worker's source is fully host-agnostic (`npm run alpha-ladder:worker`, all config via env vars, zero Railway-specific code anywhere) and ready to deploy the moment a host exists — nothing here needs to change when that decision is made.

---

## 6. BLOCKED ON REAL MARKET SESSION

Things that can only be genuinely proven while NSE is actually open and a real Kite session is live:

- Whether `kiteTickerProtocol.ts` correctly parses real packets (§3).
- Whether the 5-level depth (confirmed available via the REST probe) behaves the same way over the WebSocket's streaming `full` mode.
- A real end-to-end SHADOW trade: a real signal firing on a real Wednesday, real structure resolution, real simulated fills against real bid/ask movement, a real monitor target hit or scheduled exit.
- The worker's actual reconnect behavior under real network conditions.

None of these can be faked responsibly — they need §4 and §5 resolved first, then a live Wednesday.

---

## 7. Answers to your specific questions

**A1**: `NIFTY_NEAREST_FUTURE` / `FUTURES_DEPTH_FALLBACK_MODE`, 5-level depth with real order counts (empirically confirmed).
**A7**: Native 15-minute India VIX bars confirmed available — used as-is.
**A3**: Still genuinely unspecified in the source PDF — marked `AUTO_BLOCKER_A3`, does not block SHADOW (no real futures order is ever placed here).

---

## 8. Test results (full detail)

**131/131 passing** in `src/nifty-alpha-ladder/`. Categories now covered from your Milestone 3 test list: WORKER (connect/subscribe/health/reconnect — against a fake socket), DEPTH (protocol parsing, tick normalization), G2 LIVE PIPELINE (θ4 bucket completion, correct ρ), SIGNAL (live-accumulator-to-signal-engine wiring reaches a well-formed decision), SHADOW ENTRY/MONITOR/EXIT (Milestone 3 part 1, unchanged), MODE SAFETY (static scan), IDEMPOTENCY (duplicate signal/call), CRASH RECOVERY (7 restart points).

**Still not covered, because they need a live session (§6)**: G2 live pipeline *restart-mid-bucket* specifically (the accumulator's in-memory bucket state isn't itself persisted/resumable yet — a real gap, not just an untested one: a worker restart mid-θ4-interval would lose that partial bucket's accumulated observations); exact live-vs-fixture signal *parity* on a real trading day; a genuine crash-and-resume against the real Supabase store (only proven against the in-memory double).

## 9. Existing regression results

**Zero regressions.** All 833 existing tests (options-auto 35, quant 419, vwap-scalper 189, swing 105, intraday 85) pass unchanged. Frontend build succeeds unchanged.

## 10. UI/API changes

- API: `alpha-ladder-settings` (GET/PUT), `alpha-ladder-summary`, `alpha-ladder-signal`, `alpha-ladder-positions`, `alpha-ladder-activity`, `alpha-ladder-health` — all in `api/options-autotrade.ts`, zero changes to existing Options Auto-Trader/VWAP Scalper handlers.
- UI: `src/components/NiftyAlphaLadder.jsx`, wired into `src/Root.jsx` alongside Options Auto-Trader (both stay visible even with `ONLY_OPTIONS_AUTO` still on — that flag's original intent was to hide the *other, unrelated* sections, not this new one). SHADOW/AUTO toggle exactly as specified: SHADOW active, AUTO visibly present but disabled with a tooltip explaining why.

## 11. Known limitations (in addition to §3's list)

- The session accumulator recomputes G1/G2 from full accumulated history each cycle rather than incrementally — correct by construction, but not yet performance-tested at a full trading day's real tick volume.
- No real NSE holiday calendar wired in yet (a placeholder in `worker/main.ts`).
- `alpha_ladder_monitor_state`, `alpha_ladder_reconciliation`, `alpha_ladder_large_order_events`, and `alpha_ladder_imbalance_snapshots` have schema and are read/written to by the `AlphaLadderStore` interface only partially — the worker doesn't yet persist raw large-order events or imbalance snapshots to those specific tables (kept in the accumulator's in-memory state only right now); the retention/write-rate design your instruction asked for (§16 of your original prompt — "efficient retention model before storing unbounded raw depth data") is not yet decided.

## 12. Remaining AUTO blockers (unchanged, still open)

- `AUTO_BLOCKER_A3` — futures exit-repricing schedule unspecified in the source PDF.
- `AUTO_BLOCKER_RAILWAY` — no running worker host (§5).
- `AUTO_BLOCKER_LIVE_SOCKET` — real Kite WebSocket connection and binary parsing unverified (§3, §6).
- `AUTO_BLOCKER_DB_MIGRATION` — real persistence path unverified (§4).
- Standard Milestone-4-gate items: a real SHADOW run (not just unit tests) demonstrating crash recovery, rollback, reconciliation, and scheduled/monitor exits, before an AUTO readiness report can be written.

## 13. Exact git diff summary

Three commits this milestone:

1. `55f9d09` → reverted by `966d344` (a standalone `api/nifty-alpha-ladder.ts` broke Vercel deployment — Hobby plan's function-count cap; folded into `api/options-autotrade.ts` instead).
2. `1bb5247`: 13 files, +1185 — capability report, DB migration (file only), execution/exit/monitor engine, live-connection supervisor, 30 tests.
3. `cff7ff3`: 16 files, +1751/-2 — Kite ticker protocol + depth source, session accumulator, persistence store (in-memory + Supabase-backed), crash recovery, SHADOW P&L, worker entrypoint, 6 API resources, UI, 25 new tests.

No existing file's business logic was touched anywhere — only fully-additive functions and dispatch lines in `api/options-autotrade.ts`, and a purely-additive nav entry in `src/Root.jsx`.

---

## What I'd suggest next

Two concrete decisions unlock most of what's left: (1) apply the DB migration (§4) — the schema itself hasn't changed since you reviewed it, only new code that *reads/writes* it has been added; and (2) resolve Railway hosting (§5), your call on the three options from the previous report. Once either or both are resolved, the natural next steps are: run the worker against a real Kite session to actually test the binary parser and reconnect behavior (§3/§6), wire real NSE holiday data into the calendar gate, and persist the accumulator's raw events/snapshots durably rather than only in worker memory. Not starting Milestone 4 regardless, per your instruction.
