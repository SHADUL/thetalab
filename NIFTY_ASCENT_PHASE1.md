# NIFTY ASCENT — Phase 1: inspection, architecture and plan

*Strategy `NIFTY_ASCENT_V1` (Gap-and-Go → Williams). Prepared 23 Nov 2026 against commit `6ebbecd`. Nothing in this document has been built, migrated or deployed.*

**Status: waiting for your approval and your answers to section 9.**

---

## 1. What already exists in ThetaLab and will be reused

| Need | Existing piece | How NIFTY ASCENT uses it |
|---|---|---|
| Live NIFTY and option prices | `server/marketStream.ts`: the one shared Kite WebSocket in the web process. Full mode with depth, `want(tokens)` with expiry, `onQuote()` observer added for NIFTY PULSE, exchange timestamps via `packetExchangeTs` | Registers interest in NIFTY index token `256265` plus the 1–2 option contracts it needs. **No new connection.** Adds about 3 tokens to the roughly 40 NIFTY PULSE already watches, against a 2,900 cap. |
| Kite session | `kite_session` row in Supabase, read server-side (same loader NIFTY PULSE and Naked Sell pass to `marketStream.start`) | Same loader. No new login, no new token, nothing sent to the browser. |
| Previous-day 1-minute closes | Kite historical endpoint `/instruments/historical/{token}/minute`. Verified working on your account (`VWAP_KITE_HISTORY_CAPABILITY.md`) and already used by Naked Sell | One call per day at about 09:00 for the previous trading day's NIFTY minute bars. That gives the 15:15 close and the close-based high/low for Williams. Paced by the existing `kiteThrottle`. |
| Instrument master | `options_instruments` table (symbol, exchange, expiry, strike, option_right, lot_size, instrument_token), refreshed by the existing sync | Strike, expiry and lot size all come from here. Nothing is hardcoded. |
| Trading calendar | `isTradingDay()` in `src/nifty-alpha-ladder/calendar/signalCalendar.ts` (weekends and NSE holidays) | Finds the previous trading session and decides whether today trades. |
| Server process and gate | `server/index.ts` (`API_MODULES`, `middleware.ts` session gate, access log) | One new API module `api/nifty-ascent.ts` behind the same login. One `startNiftyAscent()` call that does nothing unless `NIFTY_ASCENT=on`. |
| Section routing | `src/Root.jsx` lazy-loads NIFTY PULSE at `/nifty-pulse/<workspace>` with its own internal navigation and an exit back to ThetaLab | Same pattern at `/nifty-ascent/<workspace>`, a separate lazy chunk. No other section's bundle grows. |
| Look and feel | ThetaLab tokens (the `--oat-*` CSS variables, light/dark), Inter, Phosphor icons, framer-motion, `lightweight-charts` 5 (already a dependency), recharts | Same tokens and components, plus an ASCENT accent within the existing palette. No new design system and no new chart library. |
| Patterns proven in NIFTY PULSE | Pure engine plus injected ports (`LivePulseService`), batched Supabase store with missing-table detection, optional gzip tick recorder on the VM, paper-only guard test | Copied as patterns into NIFTY ASCENT's own folder. **No NIFTY PULSE file is modified.** |

**Why not the worker container:** `thetalab-worker` runs Alpha Ladder with its own Kite depth connection (`kiteDepthSource.ts`). Putting ASCENT there would mean either a second consumer inside Alpha Ladder's process or a new connection. It belongs in the web process, next to the shared stream.

---

## 2. Architecture

```
                      Kite WebSocket (existing, single)
                                 │
                     server/marketStream.ts  ── onQuote() ──┬──► NIFTY PULSE (unchanged)
                                 │                           │
                                 │                           └──► NIFTY ASCENT MinuteBarBuilder
                                 │                                   • NIFTY 256265 → 1-min index closes
 Kite REST (throttled)           │                                   • traded/selected option → 1-min premium closes
  /historical/256265/minute ─────┼──► PrevSessionLoader (09:00)      • completeness / freshness / exch-ts audit
  options_instruments (DB) ──────┼──► ContractSelector                         │
                                 ▼                                            ▼
                      ┌─────────────────────── AscentEngine (pure, deterministic) ───────────────────────┐
                      │  state machine: OR collection → Gap-and-Go → handover check → Williams → entry   │
                      │  → position management (fixed stop, trailing) → exit → session complete         │
                      │  input: closed 1-min bars + clock events   output: decisions + audit events        │
                      └───────────────────────────────┬─────────────────────────────────────────────────┘
                                                      ▼
                       AscentPaperBroker (no route to any order API; fills from observed bid/ask only)
                                                      │
                       AscentStore → Supabase  (sessions, bars, events, orders/fills, trades, config, lease)
                                                      │
                       api/nifty-ascent.ts  (snapshot deltas, journal, analytics, control, config)
                                                      │
                       Browser: /nifty-ascent/*  (8 workspaces; polls snapshot every second; never sees Kite creds)
```

**Design rules:**

1. **The engine is a pure function of closed bars and clock events.** Live mode and replay feed it identical inputs, so the same input always produces the same decisions. This is tested.
2. **One authoritative engine.** A DB lease row is held by the web container and renewed every 10 s; a second instance refuses to run. All writes are idempotent: the session row is unique per date, each event has a deterministic key, and one filled trade per date is enforced by a unique constraint.
3. **Restart recovery is from persisted state, not replayed history.** On start, the engine reloads today's session row (levels, state, handover, position). If it was down during a minute it needed, that minute is marked `MISSING`, entries are blocked, and an open position is not assumed to have exited at a price nobody observed.
4. **Paper only.** No import of any order placer; a test fails the build if `server/niftyAscent*`, `api/nifty-ascent.ts` or `src/nifty-ascent/**` mention order endpoints. This is the same guard NIFTY PULSE has.
5. **Off by default, twice over.** The server flag `NIFTY_ASCENT=on` is unset, so nothing runs. Even with it set, the engine starts PAUSED each day until you press START.

---

## 3. Data conventions (proposed — see questions Q1–Q5)

- **Minute bar labels follow Kite:** the bar labelled `09:15` covers ticks with exchange time in `[09:15:00.000, 09:16:00.000)`. Its close is the last NIFTY tick in that interval. It is **confirmed** at 09:16:00 plus a grace period (proposed 1.5 s, for network lag) and is never used before then.
- **Index closes** use NIFTY 50 LTP ticks from the stream. Each bar stores `close`, `last_exch_ts`, `last_recv_ts`, `tick_count` and `status` (`OK` / `MISSING` / `LATE_PATCHED`).
- **Late ticks** that arrive after a bar is confirmed are logged but **never change a confirmed bar**. Changing it afterwards would rewrite a decision already made.
- **Bad ticks:** duplicated or out-of-order ticks (by exchange timestamp) are dropped and counted. A minute with no tick is `MISSING`; the engine never fills it from another minute.
- **Rules that need a specific bar** (09:15 reference, OR bars 09:15–09:45, previous-day 15:15) fail the session to `DATA_ERROR` (no trade) if that bar is missing, unless you approve a fallback (Q5).
- **Cross-check:** after each bar is confirmed, Kite's historical minute bar is fetched lazily (throttled, at most one call per minute, only while the engine is live). Disagreements over 0.05 points are recorded as data-quality events. They are audit only; they never change a decision.
- **Option premium bars** come from the selected contract's LTP ticks, built the same way (Q6). Bid and ask are kept separately for fills. The price used to decide and the price used to fill are never mixed.
- **Storage:** only confirmed 1-minute bars are stored: about 375 index bars a day, plus premium bars for the contract actually traded. No ticks go to Supabase. The VM tick recorder is optional and off by default, exactly like NIFTY PULSE's.

---

## 4. State machine

```
WAITING_FOR_MARKET ─09:15─► COLLECTING_OPENING_RANGE ──31/31 bars──► GAP_GO_ARMED
        │                         │ missing required bar                    │
        │                         ▼                                         ├─ directional close beyond band, gap NOT filled ─► GAP_GO_SIGNALLED ─► ENTRY_PENDING
        │                     DATA_ERROR ─► NO_TRADE                        ├─ opposite band first ───────► GAP_GO_STOOD_DOWN(opposite_first) ─┐
        │                                                                   ├─ directional close, gap filled earlier ─► GAP_GO_STOOD_DOWN(filled) ──┤
        │                                                                   └─ 12:00 bar closes, no break ─► GAP_GO_STOOD_DOWN(no_break) ─► NO_TRADE
        │                                                                                                                                      ▼
        │                                                                        WILLIAMS_ELIGIBILITY_CHECK  (gap < 0.2% or ≥ 0.5%?)
        │                                                                          │ no ─► NO_TRADE        │ yes
        │                                                                          ▼                       ▼
        │                                                                                         WILLIAMS_ARMED ─ first close > CE level / < PE level ─► WILLIAMS_SIGNALLED ─► ENTRY_PENDING
        │                                                                                                │ 14:29 bar closes, no trigger
        │                                                                                                ▼
        │                                                                                              NO_TRADE
ENTRY_PENDING ─fill─► POSITION_OPEN ─stop / trail / 15:15─► EXIT_PENDING ─fill─► TRADE_CLOSED ─► SESSION_COMPLETE
       │ rejected (no quote / spread / liquidity / contract missing) ─► NO_TRADE (recorded as a REJECTED entry, not a trade)
any state ─ kill switch ─► ENGINE_PAUSED (open paper position: flatten on observed bid, or hold for manual flatten — Q12)
```

**Guarantees, each covered by a test:**
- Only one bot can ever reach `ENTRY_PENDING` on a given day.
- Williams can only start from `GAP_GO_STOOD_DOWN(opposite_first | filled)`.
- `no_break` always ends the day.
- A bar is processed once, keyed by `(session_date, bar_label)`.
- Entry and exit are keyed by `(session_date, 'ENTRY' | 'EXIT')`.
- Stale data blocks new entries.
- A restart never re-enters a day whose trade was filled or rejected.

**Same-minute ordering, for a single confirmed close (deterministic):**
1. Data checks.
2. Position exits.
3. Opposite-band check.
4. Directional-band check, with the gap-filled test using only bars before this one (Q3).
5. Williams triggers.

Every transition writes previous state, new state, bar label, trigger, bot, prices, levels, reason and config version to `nifty_ascent_events`. The UI timeline reads from there.

---

## 5. Option selection and paper execution

- **Strike:** NIFTY strikes are 50 apart and 150 is a multiple of 50. So "150 points ITM" is computed as `ATM = round(reference / 50) × 50`, then CE strike = `ATM − 150` and PE strike = `ATM + 150`. The ITM depth is therefore 150 ± 25 points from the exact reference. Two points need your answer: the reference price (Q7) and the tie rule at exactly ±25 (Q8). If that exact strike isn't listed for the chosen expiry, the entry is **rejected** with `CONTRACT_MISSING`; it is never moved to another strike.
- **Expiry:** the nearest listed NIFTY expiry on or after today, from `options_instruments`. On expiry day that would be a same-day (0DTE) contract (Q9).
- **Lot size:** read from the instrument row. Quantity = approved lots × lot size (Q13).
- **Entry fill (proposed, Q10):** the signal is confirmed at the bar close (for example 10:07:00 for bar 10:06). The order is created then, and filled at the **first ask quote observed at or after the next bar starts**, plus configured slippage, with quote age ≤ 2 s. If no valid ask arrives by the end of that next bar, the entry is **rejected** and the day ends with no trade. The triggering close is never used as the fill.
- **Exit fill:** the same logic on the **bid**. If the next bar has no valid bid, the position stays `EXIT_PENDING` and retries every second against the bid. It is never closed at a price nobody saw. An unresolved exit at 15:29 is flagged `UNRESOLVED_EXIT` for you to review.
- **Stops (both on confirmed 1-minute premium closes):**
  - Fixed stop: exit when the premium close ≤ 0.70 × entry.
  - Trailing stop: turns on after a close > 1.05 × entry (exactly 1.05 does not count) and stays on. Exit when a close ≤ 0.80 × the highest close since entry.
  - If both trigger on the same close, the exit is labelled `FIXED_STOP` and both triggers are recorded. That can only happen when the close is ≤ 0.70 × entry, and the fill is the same either way.
- **Time exit:** an exit is forced at 15:15 if no stop has hit (Q11). If somehow still open at 15:20, a hard flatten on the observed bid runs as a safeguard.
- **Costs:** a versioned Indian options-buying cost model in the same style as Naked Sell's `roundTripCharges`. For buy-then-sell it covers:
  - Brokerage: ₹20 per order.
  - STT: 0.1% on the sell side.
  - NSE exchange charge: 0.03503%.
  - SEBI fee: ₹10 per crore.
  - Stamp duty: 0.003% on the buy side.
  - GST: 18%.

  Gross and net P&L are stored separately.

---

## 6. Database (additive migration `src/nifty-ascent/migrations/001_nifty_ascent.sql`)

The 12 tables suggested in the brief can be served by 7 without losing any audit detail. Fewer, well-constrained tables are easier to keep consistent.

| Table | Purpose | Key constraints |
|---|---|---|
| `nifty_ascent_config` | Versioned configuration: the research rules (locked) plus execution/risk settings. A new version is required to change any research threshold. | unique `(version)`; one row `active` |
| `nifty_ascent_sessions` | One row per trading day: previous 15:15 close, previous-day close high/low/range, 09:15 reference, gap points, gap %, direction, the 31 OR closes (JSON), OR high/low/width, bands, Williams levels, stand-down reason and bar, handover bar, final state, config version | **unique `(session_date)`** |
| `nifty_ascent_bars` | Confirmed 1-minute bars: index all day, premium for the traded contract only. About 375–500 rows a day. | unique `(session_date, series, bar_label)` |
| `nifty_ascent_events` | Every state transition, engine event, risk event and data-quality event, with its full context | unique `(session_date, event_key)` |
| `nifty_ascent_orders` | Paper orders and their fills (requested, filled/rejected, quote used, slippage, age) | unique `(session_date, purpose)` where purpose is ENTRY or EXIT |
| `nifty_ascent_trades` | One row per filled trade: source bot, contract, quantity, entry/exit, peak, trail state, gross, costs, net, exit reason | **unique `(session_date)`**: the one-position-per-day rule enforced by the database |
| `nifty_ascent_control` | Engine on/paused, kill switch, lease holder plus expiry, risk limits | single row `id = 1` |

- **Security:** row-level security is on for every table, there are no browser policies, and only the server's service role touches them. This is the same model as NIFTY PULSE.
- **Growth:** about 130k bar rows a year, small. Events are pruned after 180 days by adding an entry to `server/logRetention.ts`. That is the only change to an existing shared file besides `server/index.ts` and `Root.jsx`.
- **Rollback:** a `drop` script ships alongside the migration. The migration is applied by you, as before.

---

## 7. UI plan — `/nifty-ascent/<workspace>`

**Shell:**
- **Header bar:** NIFTY ASCENT · Gap-and-Go → Williams. It shows pills for market status, Kite feed, data freshness, engine, mode (LIVE PAPER / REPLAY), current state, IST clock and session date, plus a "← ThetaLab" button.
- **Navigation:** a left rail on desktop, a bottom tab strip on phones. ThetaLab's light and dark themes apply throughout.
- **Replay:** every screen in replay mode carries a persistent **SIMULATION** band.

| # | Workspace | Main content |
|---|---|---|
| 1 | **Command Center** | KPI row (NIFTY, previous 15:15 close, 09:15 reference, gap pts/%, direction, active bot, signal, positions today 0/1, paper P&L). Animated flow strip: OR → Gap-and-Go → Handover → Williams → Entry → Manage → Exit, with the current node lit and rejected paths greyed with their reason. Large NIFTY 1-minute chart (lightweight-charts) with toggleable overlays: OR high/low, ±10% bands, previous 15:15 close, Williams CE/PE, entry/exit/handover markers. Right decision panel explaining every WAIT / REJECT / STAND DOWN. State-transition timeline underneath. |
| 2 | **Gap-and-Go** | OR progress ring 0/31 → 31/31. Expandable table of the 31 closes with exact bar timestamps. Band diagram. Gap-filled and opposite-first trackers. Signal-window countdown to 12:00. Qualifying close highlighted, or the exact stand-down reason. |
| 3 | **Williams** | Previous-day close high/low/range. 09:15 reference. CE/PE triggers. Eligibility matrix (<0.2% eligible · 0.2–<0.5% blocked · ≥0.5% eligible · `no_break` always blocked) with today's row highlighted. Handover reason, bar and evaluation start. Distance to each trigger. Countdown to 14:29. Shown as inactive, never as armed, before a valid handover. |
| 4 | **Live Charts** | NIFTY 1-minute and option premium 1-minute charts with a synced crosshair. Premium chart lines for the fixed stop, trail activation, peak and live trail. Quote freshness and feed health. The premium chart switches to the traded contract automatically. |
| 5 | **Option Position** | Contract card (bot, CE/PE, symbol, strike, expiry, ITM distance, lot × qty). Entry, current premium, bid/ask, gross/costs/net, stop and trail ladder, trail status chip (STOP NOT HIT · TRAIL NOT ACTIVATED · TRAIL ACTIVE · EXIT SIGNALLED · EXIT PENDING · CLOSED), time to 15:15. Premium trajectory chart. A permanent note that stops do not guarantee the fill price. |
| 6 | **Trade Journal** | Sortable, filterable blotter with every column in the brief. A row drawer shows the full audit trail: session levels, transitions, orders, fills and bars around entry and exit. |
| 7 | **Analytics** | Separate tabs for Live paper · Replay (simulated) · Historical research; they are never mixed. Totals, win rate, gross/net, average win/loss, profit factor, max drawdown, equity curve, exit types, no-trade days, stand-down reasons, Williams eligibility distribution. Comparisons: Gap-and-Go vs Williams, CE vs PE, gap up vs down, small vs large gaps, entry hour, exit type. Each metric shows its n; "not enough data" appears below a minimum. |
| 8 | **Risk & Settings** | Start / stop new entries / paper flatten / kill switch. Execution and risk settings (capital, lots, max premium outlay, daily loss, quote age, spread, liquidity, slippage, costs, recorder). A **locked "Research rules v1" card** shows every fixed threshold; editing it means saving a new strategy version with a note. |

**Replay fixtures (Phase 2):** deterministic seeded sessions covering every path:
- Gap-and-Go CE and PE wins.
- `opposite_first` → Williams CE and Williams PE.
- `filled` → Williams.
- `no_break`.
- Gap in 0.2–0.5% (Williams blocked).
- Trailing exit, fixed stop, 15:15 exit, entry rejected, missing bar → DATA_ERROR.

All are labelled SIMULATION.

**Optional, later: historical research mode.** Kite has years of real NIFTY 1-minute history, so the signal side can be replayed exactly on real days: gap, OR, bands, stand-downs, Williams, signal times. Expired option premiums aren't available from Kite, though. Results using modelled premiums would be shown only in the Historical tab, clearly labelled, and never presented as paper performance.

---

## 8. Risks and how they are handled

| Risk | Handling |
|---|---|
| Disturbing NIFTY PULSE, AUTO, Naked Sell or Alpha Ladder | Separate folder and tables. Observes the shared stream through `onQuote` (already used by PULSE). Adds about 3 tokens. Only shared-file edits: `server/index.ts` (one route and one start call), `src/Root.jsx` (one nav entry and lazy route), `server/logRetention.ts` (one entry). The full existing test suite (1,107 tests) must stay green. |
| Kite rate limits | About 2 historical calls at 09:00, plus at most 1 per minute for the audit cross-check while the engine is live, all through the existing throttle. Can be turned off. |
| Look-ahead bias | A bar is processed only after it is confirmed. The gap-filled check uses bars strictly before the decision bar. Fills use quotes observed after the signal. Replay uses the same code path. |
| Duplicate entries (restart, deploy, repeated candle) | Lease, deterministic event keys, unique `(session_date)` trade row, and a `(session_date, 'ENTRY')` order key. A restart reloads the state and never replays a past signal. |
| Stale or missing data | Quote age limits. A bar missing at a required point → DATA_ERROR / no trade. A feed outage blocks entries. An open position stays EXIT_PENDING until a real bid exists. |
| Strategy risk | Buying ITM options can lose the entire premium. The −30% stop fills at the next observed bid, which can be much worse after a gap or fast move. The OptionsBuyer.in rules are research claims, not validated results. Nothing here suggests it is profitable. |
| Deploy restart mid-session | Allowed only outside market hours (Phase 6). If it happens anyway: state reloads, missed bars are marked, entries are blocked for the day if a required bar was missed, and any open position stays managed. |

---

## 9. Questions before building (my proposed default in **bold**)

These are the ambiguities the brief asked me not to resolve silently. Your answers become locked parts of research rules v1.

| # | Question | Options | Proposed |
|---|---|---|---|
| **Q1** | What is the "09:15 reference price" (`today_open`) for the gap and Williams levels? | (a) the first traded index value at 09:15:00 (the 09:15 bar's open); (b) the close of the 09:15 bar (09:15:59) | **(a) the 09:15 bar open.** It is the exchange's opening value, and Kite's historical bar exposes it too, so live and replay match. |
| **Q2** | Previous day's "15:15 one-minute close": the close of the bar *labelled* 15:15 (price at 15:15:59) or the price at 15:15:00 (close of the bar labelled 15:14)? The same labelling question applies to 09:45, 12:00, 14:29 and 15:15 everywhere. | (a) start-labelled bars, like Kite; (b) end-labelled | **(a) start-labelled.** "09:15 through 09:45 inclusive = 31 bars" fits start-labelling exactly. |
| **Q3** | "Gap filled / touched yesterday's close": what counts as a touch? | (a) a 1-minute close at or beyond the previous close; (b) any traded tick reaching it (intrabar); (c) a 1-minute bar's high/low reaching it | **(a) a 1-minute close**, consistent with "everything is close-based". Checked on bars from 09:15 up to the bar *before* the breakout bar. |
| **Q4** | If the gap fills but no directional breakout happens by 12:00, the reason is `no_break`, so Williams does **not** run. Is that intended? (Taken literally, `filled` is only decided at the moment of a breakout.) | (a) yes, literal; (b) a fill alone also counts as `filled`, so Williams can run | **(a) literal**, as written. Please confirm. |
| **Q5** | A required bar (a 09:15–09:45 OR bar or the previous day's 15:15 bar) is missing from the live feed. | (a) no trade today (DATA_ERROR); (b) fill it from Kite's historical bar for that minute once available | **(b) for the previous day** (it is history, so no look-ahead). **(a) for today's OR bars.** |
| **Q6** | Option premium closes for the stops: LTP-based, or the bid/ask midpoint? A minute with no option trade: hold or no decision? | (a) LTP close; minute with no trade = no stop decision that minute; (b) midpoint close | **(a) LTP close.** Bid/ask are used only for fills. A no-trade minute is recorded as `NO_PRINT`, and the stop is checked again on the next valid close. |
| **Q7** | Reference price for the 150-point ITM strike? | (a) the signal bar's close; (b) the NIFTY price at fill time (next bar) | **(a) the signal bar's close.** It is known before the order is created, so the selection is deterministic. |
| **Q8** | If the reference is exactly halfway between strikes (for example 25,125), which way does ATM round? | (a) round to the deeper-ITM side; (b) the shallower side | **(a) deeper ITM** (CE: down, PE: up). |
| **Q9** | Which expiry on expiry day (Tuesday)? | (a) today's expiry (0DTE); (b) next week's | **(b) next week's.** A 0DTE premium can lose 30% in minutes, which would change the strategy's character. You may know which the research used; please confirm. |
| **Q10** | "Enter/exit on the next bar": at which price? | (a) the first quote at the next bar's start (≈ open); (b) the next bar's close | **(a) first ask (entry) / bid (exit) at or after the next bar starts**, quote ≤ 2 s old, plus slippage. |
| **Q11** | The 15:15 time exit. | (a) exit signal on the 15:14 bar close, fill at the first bid at or after 15:15:00; (b) signal at the 15:15 close, fill around 15:16 | **(a)**, so the position is flat by about 15:15. |
| **Q12** | Pressing the kill switch with a paper position open. | (a) flatten immediately at the observed bid; (b) stop new entries only, keep managing the position | **(b) for "stop new entries", (a) for "kill".** Two separate buttons. |
| **Q13** | Paper capital and size defaults (not inherited from NIFTY PULSE). | — | **Capital ₹2,00,000 · 1 lot (65 qty at today's lot size) · max premium outlay ₹40,000 · max estimated loss ₹15,000 · daily loss cutoff ₹15,000 · quote age ≤ 2 s · spread ≤ 1.5% of mid · min 500 contracts traded today · slippage 0.25%.** A 150-ITM weekly typically costs about ₹200–300, so ₹13k–20k per lot. |
| **Q14** | Zero gap (`gap_points = 0`). | — | **No Gap-and-Go direction → stand-down reason `no_gap` → Williams not eligible** (it isn't one of the two qualifying reasons). |
| **Q15** | Does Williams evaluate the same bar that caused the handover? | (a) no, it starts from the next completed bar; (b) yes | **(a) the next bar.** One close never drives two decisions. |

---

## 10. Files (Phases 2–4)

**New:**
```
src/nifty-ascent/
  core/types.ts             research rules v1 (frozen), config, events, states
  core/bars.ts              1-min bar builder (confirm, late, missing, dedupe, out-of-order)
  core/levels.ts            gap, opening range, bands, Williams levels, eligibility
  core/engine.ts            state machine (pure)
  core/position.ts          fixed stop, trailing, time exit
  core/contracts.ts         ITM strike + expiry selector over an instrument list
  core/costs.ts             versioned cost model
  core/paperBroker.ts       next-bar fills from observed quotes
  sim/fixtures.ts           deterministic replay sessions (SIMULATION)
  sim/replay.ts             drives the engine from fixtures / stored bars
  live/service.ts           live orchestration with injected ports (stream, history, instruments, store, clock)
  migrations/001_nifty_ascent.sql, 001_down.sql
  __tests__/…               levels, engine paths, Williams boundaries, contracts, exits, daily rule, restart, paper-only
  tsconfig.json
server/niftyAscent.ts       wiring (flag, lease, ports) — no order code
server/niftyAscentStore.ts  Supabase store (batched, idempotent)
api/nifty-ascent.ts         snapshot / journal / analytics / control / config
src/components/nifty-ascent/
  NiftyAscent.jsx (shell, rail, header), store.js (live + replay), ui.jsx, format.js, nifty-ascent.css,
  CommandCenter.jsx, GapAndGo.jsx, Williams.jsx, LiveCharts.jsx, OptionPosition.jsx,
  TradeJournal.jsx, Analytics.jsx, RiskSettings.jsx, AscentChart.jsx, FlowStrip.jsx, Timeline.jsx
NIFTY_ASCENT.md             strategy spec v1 + answered clarifications + runbook
```

**Edited (small, additive):** `src/Root.jsx` (nav entry and lazy route), `server/index.ts` (one `API_MODULES` entry and `startNiftyAscent()`), `server/logRetention.ts` (one retention entry), `package.json` (`nifty-ascent:test` / `:typecheck` scripts).

**Untouched:** everything belonging to AUTO, Naked Sell, Alpha Ladder, NIFTY PULSE and `marketStream.ts`. `onQuote` already exists.

---

## 11. Phases and rollout

| Phase | Work | Your approval needed before |
|---|---|---|
| 2 | All 8 workspaces on deterministic replay fixtures (SIMULATION), plus the pure engine, so the replay shows real decisions. Screenshots in light and dark, desktop and phone. | Starting Phase 3 |
| 3 | Live bar builder on the shared stream, the historical loader, the contract selector. Verified outside market hours with a mock stream, then in observe-only mode during a session (no engine). | Observe-only on the VM |
| 4 | Live service, paper broker, store, migration file, API. | Applying the migration (you run it) |
| 5 | Full test suite, deterministic replay tests, failure simulations (feed drop, restart mid-position, missing bars, DB errors). | — |
| 6 | Deploy after hours with `NIFTY_ASCENT` unset → verify the other sections and the stream are unaffected → set `NIFTY_ASCENT=on` (engine still PAUSED) → you press START. | Each step |

**Rollback:** remove `NIFTY_ASCENT=on` from `/opt/thetalab/.env` and redeploy. The engine stops; nothing else depends on it. For a full removal, redeploy the previous commit and run `001_down.sql`. Each phase is its own commit, so any one can be reverted on its own.
