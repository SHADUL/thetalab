# Live trading: real Zerodha orders (NIFTY ASCENT and Naked Sell)

Built 24 Nov 2026 on the owner's request. **Real money.** It is off by default at three levels:

1. **Database:** apply `src/live-orders/migrations/001_live_orders.sql`. Rollback: `001_live_orders_down.sql`.
2. **Server switch:** `LIVE_ORDERS=on` in `/opt/thetalab/.env`, then recreate the web container. Without it the broker code refuses every order before it reads any credential.
3. **Arm, per strategy:** open the strategy's **Live trading** panel and click **Arm live…**, then type `ARM LIVE`. **Disarm** stops new real entries; an open real position keeps being managed until it closes. **FLATTEN LIVE** closes the real positions now and disarms.

Paper, shadow and live paper are unchanged. Live results come only from real broker fills, are stored separately (`live_positions`), and are never mixed with paper results.

## Owner decisions (24 Nov 2026)

| Decision | Choice |
|---|---|
| Crash guard | A stop-loss (SL) order is placed at Zerodha right after each entry fills. It is cancelled, and the cancel confirmed, before any other exit. |
| Naked Sell live size | Its own limits: 1 lot, 2 entries a day across NIFTY and SENSEX, ₹5,000 daily loss. Editable in the panel. Paper and shadow keep theirs. |
| NIFTY ASCENT live | Mirrors live paper exactly: same engine, contract, quantity, budget and rules. |
| Rollout | Build and test first. Deploy and push only on the owner's word. |

## How an order works (`src/live-orders/runner.ts`)

**Order type**
- Intraday product (MIS), LIMIT and SL orders only. Kite rejects plain market orders sent through its API.

**Entry**
- A marketable LIMIT: ask + 2% for a buy, bid − 2% for a sell, on the 0.05 tick.
- Unfilled after 10 s → the order is cancelled. A partial fill keeps the filled quantity.
- The record is saved *before* the order is sent, with a unique Kite order tag. A crash between sending and recording is recovered by looking up the tag, so an order is never sent twice.

**Broker stop (crash guard)**
- An SL order with its limit 10% beyond the trigger. SL-M is not allowed for index options.
- The trigger sits a set distance beyond the strategy's own stop: **5%** by default, editable in the panel. The strategy's own stop normally acts first: ASCENT on one-minute closes, Naked Sell after two one-second checks. The broker stop is the backstop if the server is down.
- If Kite rejects the stop, the position is still managed by the server and the panel shows "REJECTED".

**Exit**
1. Cancel the broker stop and confirm it.
   - If the stop already filled, fully or partly, that quantity is not closed again. There is never a double exit.
   - If the cancel cannot be confirmed, no exit is sent. The position goes to `CLOSE_FAILED` and is retried.
2. Send a marketable LIMIT at ±3%. Unfilled → cancel and retry at ±6%, then ±9%.
3. Still open → `CLOSE_FAILED`, retried every tick, and new live entries are blocked until it is resolved.

**Audit:** every broker request and its result goes to `live_order_audit`. No credentials are stored.

## NIFTY ASCENT (`src/live-orders/ascentMirror.ts`)

**Entry**
- When the live paper entry fills, a real BUY goes out for the same contract and quantity.
- The limit is capped so that premium plus fees stays inside the same ₹ outlay and maximum-loss limits.
- Conditions: armed, server switch on, and this server holds the single-engine lease.
- At most one real entry a day.
- A paper fill older than 60 s (for example, seen after a restart) is not chased.

**Exit**
- The real position is closed when the paper engine starts its exit: fixed or trailing stop, 15:15 time exit, or KILL/FLATTEN.
- It is also closed if the paper position is gone, and in all cases by 15:20 at the latest.

**Restart:** today's live record is resumed and never re-entered.

## Naked Sell (`api/naked-sell.ts`, mode `LIVE`)

**Rejections (added 25 Nov 2026)**
- If Zerodha rejects **2 entries in a row** (for example a debit balance or a margin block), new live entries stop for the rest of the day.
- The Live trading panel shows "NEW LIVE ENTRIES STOPPED" with Zerodha's reason.
- Fix the account, then click **Disarm** and **Arm live…** again. Only entries since the last arm count, so re-arming clears the stop.
- A filled entry, or an entry that was not filled and was cancelled, resets the count.

**Entry**
- Same signal, strike choice, liquidity gate and TP/SL percentages as SHADOW.
- Before selling, Kite's margin for the order is checked against real available funds.
- After the fill, TP/SL are computed from the **real** fill price, and the broker stop is placed.
- If the strategy record cannot be written, the real position is bought back immediately.

**Exit**
- LIVE squares off by **15:15**, before Zerodha's own MIS auto square-off.

**Every tick**
- A broker stop that filled is detected and recorded as SL.
- Half-finished exits are retried.
- A real position with no active strategy record (crash between fill and record) is closed.

## Verified

- Tests use a fake broker and a fake database only. No real order was sent while building this.
- `src/live-orders/__tests__`: runner (20), ASCENT mirror (11), Naked Sell LIVE end to end (11).
- Full suite passes.
