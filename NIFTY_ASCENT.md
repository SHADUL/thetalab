# NIFTY ASCENT — Gap-and-Go → Williams (`NIFTY_ASCENT_V1`)

*Owner decisions confirmed 23 Nov 2026: missing-minute policy, rejected-entry policy, Q13 risk limits unchanged, Q9 provisional, tick-based fill and same-bar handover preserved.*

*Paper-only NIFTY options-buying research terminal inside ThetaLab at `/nifty-ascent/<workspace>`. The rules come from OptionsBuyer.in research data. They are research specifications, not validated profitability claims and not investment advice.*

| | |
|---|---|
| **Status** | Live paper deployed 23 Nov 2026 (rules V1.0+OR60+ROLL1, settings editable in Risk & Settings). Live trading with real orders built 24 Nov 2026 (see LIVE_ORDERS.md); it is off unless the server switch is on and the owner arms it. |
| **What runs** | The UI and a deterministic strategy engine on SIMULATION replay fixtures |
| **What is not connected yet** | Kite, the server and the database |

---

## 1. Research rules v1 (locked — `src/nifty-ascent/core/rules.ts`)

| Rule | Value |
|---|---|
| Bars | Kite start-labelled 1-minute bars; the bar labelled 09:15 covers 09:15:00–09:15:59 and is confirmed after 09:16:00 (+1.5 s grace) |
| `previous_close` | close of the previous trading day's bar labelled 15:15 (Kite historical) |
| `today_open` | first valid NIFTY exchange tick at or after 09:15:00 (Q1) |
| Gap | `today_open − previous_close`; % = \|gap\| / previous_close × 100, compared exactly in integer paise |
| Opening range | 31 one-minute CLOSES, bars 09:15 … 09:45; OR_HIGH/LOW = max/min close; W = high − low |
| Bands | UP = OR_HIGH + 0.10·W · DOWN = OR_LOW − 0.10·W; a breakout needs a strictly-beyond close |
| Gap-and-Go window | bars 09:46 … 12:00; gap up → CE only, gap down → PE only |
| `opposite_first` | the opposite band breaks (close) before any directional breakout |
| `filled` (Q3) | at the breakout bar, a valid tick has already reached the previous close (gap up: ≤, gap down: ≥) at or before that bar's confirming close tick; the earliest fill is persisted |
| `no_break` (Q4) | no qualifying breakout by the 12:00 close — never activates Williams, even if the gap filled |
| Zero gap (Q14) | no direction, no Williams, no trade (`no_gap`) |
| Williams eligibility | only after `opposite_first` / `filled`, and only if gap % < 0.2 **or** ≥ 0.5 (exact boundaries) |
| Williams levels | today_open ± 0.5 × (previous day's highest − lowest 1-minute CLOSE) |
| Williams window (Q15) | from the handover bar itself (stand-down → eligibility → trigger on the same bar) through the 14:29 bar; first strictly-beyond close wins |
| Option (Q7, Q8, Q9) | 150 pts ITM from the signal minute's NIFTY close, rounded to the listed strike interval; exact ties → deeper ITM. Nearest listed expiry; on expiry day the next listed expiry — **provisional convention; the original OptionsBuyer.in expiry-day rule is not verified** |
| Entry (Q10) | first fresh executable ask (quote ≤ 2 s old, spread ≤ 1.5% of mid, day volume ≥ 500) in the next minute, + 0.25% slippage; none → entry rejected, no trade |
| Fixed stop | confirmed 1-minute option **LTP** close ≤ 70% of entry |
| Trailing stop | arms on a close strictly > 105% of entry; exits on a close ≤ 80% of the highest close since entry |
| Both on one close | labelled FIXED_STOP; both triggers recorded |
| NO_PRINT (Q6) | a minute with no option trade makes no stop decision |
| Stop exit fill (Q10) | first fresh executable bid in the next minute − slippage; never the threshold price; keeps seeking if late; never fabricated |
| Time exit (Q11) | initiated at 15:15:00; first fresh bid at or after 15:15:00; no bid before the session ends → `UNRESOLVED_EXIT` |
| Positions per day | 1, across both bots; rejected entries are recorded separately and end the day |
| Controls (Q12) | STOP NEW ENTRIES (keeps managing the position) · KILL / FLATTEN (cancels a pending entry, closes at a fresh bid) · START is refused while killed |

Numeric comparisons that decide a boundary use integer paise: gap %, 105%, 70% and 80%.

---

## 2. Execution & risk settings (versioned, `EXEC-1` — Q13)

These settings are separate from the research rules and can be changed.

| Setting | Value |
|---|---|
| Paper capital | ₹2,00,000, independent of NIFTY PULSE |
| Size | 1 lot; quantity comes from the instrument-master lot size |
| Max premium outlay | ₹15,000, *including* estimated entry fees |
| Max theoretical trade loss | ₹15,000 (premium + fees) |
| Daily realized loss cutoff | ₹15,000 |
| Quote freshness | ≤ 2 s |
| Bid/ask spread | ≤ 1.5% of mid |
| Minimum daily volume | 500 contracts |
| Slippage | 0.25% |

An entry over budget is **rejected**. Strike and quantity are never changed to force a trade.

**Costs (`IN-NFO-OPT-BUY-2026.11`):**
- Brokerage: ₹20 per order.
- STT: 0.1% of the sell premium.
- Exchange transaction charge: 0.03503%, both sides.
- SEBI fee: ₹10 per crore.
- Stamp duty: 0.003% of the buy side.
- GST: 18% on brokerage, transaction charge and SEBI fee.

Gross and net P&L are stored separately.

---

## 3. Data policy

**Ticks:**
- A tick belongs to the bar containing its exchange timestamp.
- Out-of-order and exact-duplicate ticks are dropped.
- Index ticks more than 5 s old on receipt are dropped.
- Late ticks for a confirmed bar are logged and never applied.

**Required data:**
- A missing previous-day 15:15 bar, or fewer than 370 of 375 previous-day bars → `DATA_ERROR`.
- A missing opening-range minute → `DATA_ERROR`, no trade (Q5).

**Confirmed 23 Nov 2026:**
- A missing NIFTY minute inside an active signal window (09:46–12:00, or Williams to 14:29) → `DATA_ERROR`; no further entries that day. Missing live signals are never reconstructed from later data.
- A rejected entry (budget, stale quote, liquidity, spread, missing contract, execution timeout) ends the day's entry attempts. The reason is recorded and it is not counted as a filled trade.
- An open position is never abandoned. It stays managed, and only new entries are blocked.

---

## 4. Code

```
src/nifty-ascent/core/     rules.ts levels.ts bars.ts costs.ts engine.ts   (pure, deterministic, paper only)
src/nifty-ascent/sim/      market.ts (seeded SIMULATION market + replay driver) fixtures.ts (11 sessions)
src/nifty-ascent/__tests__ helpers.ts levels.test.ts engine.test.ts replay.test.ts   (61 tests)
src/components/nifty-ascent/  NiftyAscent.jsx (shell) + 8 workspaces, AscentChart.jsx, store.js, derive.js, ui.jsx, format.js, nifty-ascent.css
src/Root.jsx               nav entry + lazy route /nifty-ascent (shared with NIFTY PULSE's terminal routing)
```

**Run the tests:**
- `npm run nifty-ascent:test`
- `npm run nifty-ascent:typecheck`

**The 11 replay fixtures** each demonstrate one path:
- Gap-and-Go CE (trailing stop) and PE (fixed stop).
- `opposite_first` → Williams PE (time exit).
- `filled` (intrabar tick) → Williams CE (fixed stop).
- Gap filled but `no_break`.
- Gap 0.30% (Williams forbidden).
- Zero gap.
- Missing opening-range minute (`DATA_ERROR`).
- Budget rejection.
- Gap exactly 0.2000%.
- Same-bar handover → Williams PE on expiry day (trailing stop).

They are synthetic and prove nothing about profitability.

---

## 5. Phase 3 — live market data (observe only, built 23 Nov 2026, not deployed)

```
src/nifty-ascent/core/contracts.ts   instrument-master validation + 150-ITM selector (shared by live and replay)
src/nifty-ascent/live/adapter.ts     shared-stream quote → engine event (exchange time required; trade = volume increase)
src/nifty-ascent/live/history.ts     previous trading day's NIFTY minute bars from Kite historical (holiday fallback)
src/nifty-ascent/live/service.ts     LiveAscentService — OBSERVE ONLY: engine created PAUSED, no start path
server/niftyAscent.ts                wiring; inert unless NIFTY_ASCENT=observe; reuses marketStream + kite_session
server/index.ts                      one startNiftyAscent() call (no-op without the flag)
```

**Live day (observe only):**
- **08:50** — the service loads the previous session (one Kite historical GET) and the instrument master. The master covers the next 3 expiries, with strikes within ±2,500 of the previous close. Failures retry every minute.
- **09:14** — if preparation still hasn't succeeded, the engine is created anyway, the day is marked `DATA_ERROR` and nothing trades.
- **From 09:00** — it registers interest in NIFTY 256265 on the shared stream.
- **Each second** — the clock runs and every confirmed bar is processed.
- **On a signal** — the signal is recorded. The service logs the contract it *would* select, and the engine refuses the entry (`entries_disabled`).

**Data quality:**
- Ticks with no exchange timestamp are dropped. Bars are never timed by when a tick was received.
- The first option packet after a subscription is never treated as a trade.
- A drop in cumulative volume is treated as a feed reset, not a trade.

**Verification:** every fixture was encoded as real Kite binary packets and decoded by `server/marketStream.ts`'s own `splitPackets` / `decodePacket` / `packetExchangeTs`. The live path then reached identical decisions to deterministic replay, both paused and running. That covers bars, levels, stand-downs, signals, contracts, fills, exits, P&L and premium bars.

**Remaining before live paper (Phase 4):**
- Run observe-only on the VM for at least one session (needs your approval to set `NIFTY_ASCENT=observe` and redeploy).
- The option contract is subscribed only after a signal, so its quotes must arrive within the next minute or the entry is rejected (`no_executable_quote`). Pre-subscribing the likely strikes from 09:46 can be added in Phase 4.

### Phase 3 additions (approved 23 Nov 2026)

**Shared stream (`server/marketStream.ts`, additive):**
- `want()` keeps the later expiry when several modules request the same instrument, so a shorter request never cuts another module's subscription short. Expired interest is still pruned on every supervisor pass.
- Observers receive an optional third argument with Kite's last-trade time and last-traded quantity, read from F&O full packets. The quote object (`LiveQuote`) and existing listeners are unchanged.

**Trade detection:** an option print counts as a trade only if the last-trade time advanced **or** the day volume rose. Every case is counted per contract and reported, never silently resolved:
- Both advanced.
- Last-trade time only.
- Volume only.
- Quote-only.
- The LTP field changed on a quote-only update.
- Last-trade time went backwards.
- No last-trade time on the packet.

The report also includes total last-traded quantity versus total volume increase.

**Option pre-subscription (`live/presubscribe.ts`):**
- **When:** from 09:46, once the opening range is final.
- **Which contracts:**
  - Gap-and-Go armed: the selector's 150-point in-the-money strike for the breakout band and for the latest close, plus one strike either side, in the gap direction only.
  - Williams armed: the same for both the CE and PE levels.
- **Limits:** at most 8 contracts, requested on the shared stream every 30 s with a 180 s expiry.
- **Release:** after the session is decided the contracts are no longer requested, and the stream releases them when they expire.

**Persistent archive (`server/niftyAscentArchive.ts`):**
- **Location:** `/opt/thetalab/data/nifty-ascent` on the VM, bind-mounted at `/data/nifty-ascent`. That is outside the release folder that `deploy.sh` replaces.
- **Contents:**
  - `reports/<date>.json` — the end-of-session report.
  - `events/<date>.ndjson` — decisions, data quality, subscriptions and health.
  - `ticks/<date>/<HH>.ndjson.gz` — optional raw evidence, only with `NIFTY_ASCENT_RECORD_TICKS=on`.
- **Retention:** 90 days for reports and events, 14 days for ticks.
- **Limits:** a 1 GB size cap (oldest tick days are deleted first, never today's); events and ticks pause when less than 5 GB is free.
- **Never written:** credentials.

## 6. Phase 4 — live PAPER mode (deployed 23 Nov 2026, PAUSED)

`NIFTY_ASCENT=paper` runs the same engine with **paper fills against real Kite bid/ask quotes**. There is no order code anywhere, and tests scan every ASCENT file for order endpoints.

**Starting:**
- The engine starts **PAUSED** every trading day.
- It trades only after **START** (Risk & Settings → Live paper), or automatically when the owner turns **auto-start** ON. Auto-start is stored in `nifty_ascent_control.auto_start` and is OFF by default.

**Safety:**
- **Single-engine lease:** `nifty_ascent_control.lease_holder`, 90 s, renewed every 30 s.
- **No lease, or a database write failure:** new entries are blocked, and any open paper position keeps being managed.
- **One trade per day:** the `nifty_ascent_trades` primary key on `session_date`. Orders are limited to one ENTRY and one EXIT per day by primary key.

**Recovery:** the engine snapshot is saved to `nifty_ascent_sessions` on every state change and at least once a minute. After a restart:
- The session resumes from the snapshot.
- Minutes the process didn't see count as missing data.
- A position already filled is never re-entered.
- If the restart is after 09:14, the engine waits for the previous session to load before being created.
- Today's reference is taken only from a tick inside the 09:15 minute.

**Controls** (login required; refused in observe mode):
- START.
- STOP NEW ENTRIES — keeps managing an open position.
- KILL / FLATTEN — persistent kill switch.
- RELEASE.
- Auto-start ON/OFF.

**UI:** a Simulation / Live paper switch. The live view is a read-only copy of the server engine. The live journal and analytics read only from `nifty_ascent_trades` and are never mixed with replay results.

**Migration:** `src/nifty-ascent/migrations/001_nifty_ascent.sql`, applied 23 Nov 2026. Rollback: `001_nifty_ascent_down.sql`.

**To enable live paper (owner only):** Risk & Settings → Live paper → *Auto-start each trading day: ON*, or press START on the day. **To stop:** KILL / FLATTEN, or set `NIFTY_ASCENT=observe` and redeploy.

## 6a. Late-start recovery (owner decision 25 Nov 2026 — amends Q5)

If the live engine missed the start of the session, it can still be rebuilt. This typically happens when Kite is logged in late; the first case was 25 Nov, when the Kite login expired and the first price arrived at 09:33.

- **Every 15 s until the 09:46 minute ends**, the service reloads the previous session and fetches today's Kite 1-minute candles.
- **Each minute before 09:46 that was not observed live is filled from its Kite candle.** The candle becomes four ticks inside the minute: open, low/high, close.
- **Minutes the stream observed in full replay their own live ticks.** "In full" means the stream was already delivering when the minute began.
- **The whole day is replayed through a fresh engine**, with the same pinned settings and the same START / STOP / KILL state, which then replaces the failed one.
- **Why this is safe:** those minutes only set today's reference (the 09:15 open), the gap, the gap-fill check and the opening range. No trade can come from them.
- **Any minute from 09:46 on that was not observed live ⇒ no recovery.** Signals are never rebuilt from history.
- **Marking:** the session carries a `recovery` marker plus a `late_start_recovered` audit event. The live journal shows **LATE START** on that day.
- **Clearer message:** a Kite 403 TokenException is now reported as "Kite login expired or missing — log in to Kite", instead of "15:15 bar missing".
- **Site-wide red banner** on trading days 08:30–15:30 when the Kite login is invalid. The login is checked with `/user/profile` at most once a minute. The banner has a *Log in to Kite* button.

## 7. Live trading — real orders (built 24 Nov 2026)

A separate, owner-armed mirror of live paper sends real Zerodha orders. When the paper entry fills it sends the same contract and quantity, and it exits when paper exits. A stop-loss order at Zerodha is the crash guard. The live paper engine itself still has no order code. Details, switches and rollback are in `LIVE_ORDERS.md`.

## 8. Earlier phase plan (historical)

1. **Phase 4:**
   - Server service `NIFTY_ASCENT=on`, OFF by default; the engine starts PAUSED daily.
   - DB lease, Supabase store and migration (you apply it), API.
   - Live-paper source in the UI.
2. **Phase 5–6:** failure simulations, then deployment after market hours with the flag off.

**Open items:**
- Verify the source's expiry-day convention (Q9). Until then, next week's expiry on expiry day stays a PROVISIONAL convention, unverified against the original OptionsBuyer.in research.
- At today's lot size of 65, a 150-ITM weekly costs about ₹170–230 a unit, so ₹11k–15k a lot. Entries several days before expiry, or at high IV, will often exceed the ₹15,000 cap and be **rejected**. This is expected under Q13, but it will reduce the number of trades.
