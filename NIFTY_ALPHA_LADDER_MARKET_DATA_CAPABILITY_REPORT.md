# Nifty Alpha Ladder — Market Data Capability Report

Empirically verified against the live, connected Kite Connect session (via a
read-only probe — `resource=alpha-ladder-probe` in `api/options-autotrade.ts`
— never places, modifies, or cancels anything). Run 2026-09-30 08:47 UTC
(14:17 IST), during market hours. Raw response in the probe's own GitHub
Actions run for full auditability.

---

## 1. Depth source: nearest NIFTY future (A1)

**Resolved instrument** (from Kite's own NFO instrument dump, never hardcoded):

| Field | Value |
|---|---|
| Listed NIFTY futures found | 3 |
| Nearest (selected) | `NIFTY26OCTFUT` |
| Instrument token | 12468226 |
| Expiry | 2026-10-27 |
| Lot size | 65 |

**Live quote depth** (`GET /quote?i=NFO:NIFTY26OCTFUT`):

| Field | Value |
|---|---|
| Depth present | ✅ yes |
| Bid levels | **5** |
| Ask levels | **5** |
| Order-count field present | ✅ yes (`orders`) |
| Sample bid level | `{price: 22815.6, quantity: 260, orders: 2}` |
| Sample ask level | `{price: 22820, quantity: 65, orders: 1}` |
| Last price | 22,822 |
| Last trade time | 2026-09-30 14:17:08 |

**Finding**: Kite's retail Connect API provides **5-level market depth with price, quantity, AND order count** for the nearest NIFTY future. This is real, usable depth for Definition 2.2's large-order detection (which needs exactly `(price, quantity, order_count)` per level) — **but it is 5 levels, not the PDF's "full-book" language**. Per your instruction, this is called out explicitly, not glossed over:

> The PDF's phrase "full-book" may not equal the number of depth levels provided by our retail broker feed.

**5-level depth is what we have and what will be used.** `depth_source = 'NIFTY_NEAREST_FUTURE'`, `depth_source_mode = 'FUTURES_DEPTH_FALLBACK_MODE'` — never labeled as the NIFTY spot order book (the index itself has no order book at all), and never labeled as full exchange depth. The reference-threshold estimator (Definition 13.3) and large-order event detection (Definition 2.2) will operate on this 5-level view; the practical consequence is that "large order" classification only ever sees the top 5 levels each side, which is a real, disclosed approximation of the PDF's own described mechanism, not a full reproduction of it.

**Update frequency / streaming vs snapshot**: this probe used the REST `/quote` snapshot endpoint (a point-in-time read). The worker itself will use Kite's WebSocket ticker (`KiteTicker`, mode `full`), which streams the same 5-level depth continuously — not tested live in this probe (a WebSocket connection isn't a one-shot REST call), verified by architecture/documentation instead; this is the one live-connectivity claim in this report that is **design-verified, not run-verified**, flagged honestly.

**Exchange timestamp**: the quote response includes `last_trade_time` (a real exchange-side timestamp) but the depth levels themselves carry no per-level timestamp in the REST snapshot — the WebSocket ticker payload does carry a message-level timestamp, which the worker will use as `timestamp_exchange`-adjacent (Kite's WebSocket depth doesn't tag a true exchange-side per-tick timestamp separately from receipt; both a "received" and the WS packet's own timestamp will be persisted, per the normalization requirement in §9 of your instructions).

---

## 2. India VIX (A7)

**Resolved instrument** (from Kite's own NSE instrument dump, never hardcoded): `instrument_token = 264969`, `tradingsymbol = "INDIA VIX"`.

**Historical candle availability**:

| Interval | Candles returned (2-day window) | Available? |
|---|---|---|
| 15minute | 71 | ✅ **YES** |
| minute | 1,052 | ✅ yes (finer than needed) |
| day | 3 | ✅ yes |

**θ9's assumed 15-minute granularity IS natively available.** Per your instruction ("If YES: use them"), no aggregation logic is needed — this resolves A7 in the simple branch, no "stop for approval" required.

**Timestamp convention**: sample candles —
```
["2026-09-28T09:15:00+0530", 12.16, 13.73, 12.16, 13.7, 0]   <- first candle of the day
["2026-09-28T09:30:00+0530", 13.7, 14.15, 13.59, 14.05, 0]
```
The first candle of the trading day is stamped exactly `09:15:00` (the market open), which is strong evidence Kite's candle timestamps denote the **bar's START**, not its end (an end-stamped convention would show the first candle at 09:30). This matters directly for causality: a bar stamped e.g. `10:00:00` covers `[10:00, 10:15)` and **may still be forming** if queried at, say, `τ*=10:12` (exactly the worked example's own crossing time). The spec anticipates this exact case:

> "When bar timestamps denote bar starts, that bar may still be forming at t_f and v* is then its latest print; in no case does v* use information from after the decision instant."

So: querying the 15-minute VIX series at any `τ*` and taking the **latest bar stamped at or before τ*'s own current close value** (whatever Kite returns for that still-forming bar as of the query instant) is exactly the PDF-permitted behavior, not a workaround. This is documented here rather than silently assumed, per your instruction to describe the causal aggregation requirement explicitly — no change to VIX semantics was needed since native 15-minute bars exist.

---

## 3. Option data (from existing, already-verified Options Auto-Trader usage)

Not re-probed here since Options Auto-Trader already depends on and has verified these in production this session: option LTP, bid/ask depth (`midOrLastPrice`'s existing bid/ask-mid convention), and the NFO instrument master sync. Reused as-is for Nifty Alpha Ladder's option-leg quoting; no new capability question here.

---

## 4. Reconnect behavior, streaming architecture

Not empirically tested in this report (requires an actual live WebSocket session, which a one-shot REST probe cannot exercise). The worker's `KiteAlphaLadderDepthSource` implementation (§ below) is written against Kite's documented `KiteTicker` reconnect/subscribe semantics; its actual reconnect behavior against a real socket is a Milestone-3-in-progress item, not yet run-verified, and is called out as such in the Milestone 3 report's limitations section.

---

## 5. Summary verdict

| Question | Answer |
|---|---|
| Futures depth available? | ✅ Yes, 5 levels |
| Order count available? | ✅ Yes |
| Update frequency | Snapshot tested (REST); WebSocket streaming is the worker's design, not yet run-verified |
| Exchange timestamp available? | Partial — `last_trade_time` on quotes; WS ticker timestamp to be used per-tick |
| India VIX live source | ✅ Kite, resolved token 264969 |
| India VIX 15-min native bars | ✅ **YES** — use natively, no aggregation |
| Option LTP/bid/ask/depth | ✅ already in production use (Options Auto-Trader) |
| Futures LTP | ✅ confirmed via the same quote call |
| Instrument master | ✅ NFO/NSE CSV dumps, already the existing sync pattern |

**Conclusion**: sufficient real data exists to proceed with the approved practical approximation (5-level futures depth via `FUTURES_DEPTH_FALLBACK_MODE`, native 15-minute VIX bars) — proceeding with Milestone 3 on this basis, as instructed.
