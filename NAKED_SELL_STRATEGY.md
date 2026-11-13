# Naked Sell: strategy review and v2 rules

*Review date: 13 Nov 2026. Scope: PAPER and SHADOW only. This strategy places no real orders.*

---

## 1. Summary

The current strategy (v1) **loses money live and in a 60-day backtest**.

- **Main cause:** it reads a trend too early, before the 21-bar average exists, and acts on trends too weak to persist.
- **Effect:** it sells into noise, then gets stopped out or squared off at a loss.
- **Charges:** about ₹60 per trade, so more trades add more drag.

**v2 changes three things:**

1. No signal before 11:00. The trend needs 21 completed 5-minute bars, so EMA21 is fully formed.
2. The trend must be twice as strong: the EMA9–EMA21 gap must be at least 0.06%, up from 0.03%.
3. At most 2 entries per index per day, with take-profit and stop-loss both at 40%.

**Results on the same 60 days, same cost model:**

| | v1 (your current settings) | v2 |
|---|---|---|
| Trades | 346 | 137 |
| Win rate | 47% | 60% |
| Net P&L (2 lots, after charges) | **−₹60,011** | **+₹54,582** |
| Profit factor | 0.84 | 1.40 |
| Worst drawdown | −₹80,075 | −₹35,442 |
| First 30 days / last 30 days | −₹49,931 / −₹10,080 | +₹10,337 / +₹44,245 |
| NIFTY / SENSEX separately | both lose | +₹26,732 / +₹27,850 |
| With 1% worse fills | loses more | still +₹45,090 (PF 1.32) |

**This does not show v2 will be profitable.** The backtest prices options with a model, not with real option prices (see section 6). Run v2 in PAPER and SHADOW for at least 20 trading days before trusting it.

---

## 2. Current strategy (v1, as running on 13 Nov)

| Item | Rule / setting |
|---|---|
| Underlyings | NIFTY (NFO, weekly Tuesday expiry), SENSEX (BFO, weekly Thursday expiry) |
| Trend | 5-minute index candles. **BULLISH** needs all three: close above the session average (TWAP), EMA9 above EMA21 by at least **0.03%**, close above EMA9. **BEARISH** mirrors it. Otherwise NEUTRAL. |
| Warm-up | **6 completed bars**, so signals start at 09:45 |
| Trade | BULLISH → sell PE; BEARISH → sell CE; NEUTRAL → no trade |
| Strike | OTM strike closest to **0.30 delta** (Black-76 with each strike's own IV), nearest weekly expiry, rolling to the next one on expiry day |
| Entry window | 09:45–14:30 IST |
| Size | **2 lots** (NIFTY 130 qty, SENSEX 40 qty) |
| Take profit | premium falls **30%** |
| Stop-loss | premium rises **30%**, confirmed on 2 consecutive 1-second checks |
| Trend flip | exit as soon as the trend turns against the position |
| Square-off | 15:15 IST |
| Limits | **8 entries/day per index**, 15-minute cooldown, stop for the day at −₹5,000 per mode |
| Fills | PAPER at mid; SHADOW at bid to sell and ask to buy back, skipping any option whose spread is over 5% or volume under 100 |

---

## 3. Review of the 14 closed trades (12–13 Nov)

| # | Mode | Contract | Entry (IST) | Trend at entry | Exit | Net ₹ |
|---|---|---|---|---|---|---|
| 1 | PAPER | NIFTY 25500 CE | 12 Nov 12:55 | BEARISH, 0.25% below session avg | SQUARE_OFF | −340 |
| 2 | SHADOW | NIFTY 25500 CE | 12 Nov 12:55 | same | SQUARE_OFF | −354 |
| 3 | PAPER | SENSEX 83000 CE | 12 Nov 12:55 | BEARISH, 0.27% below | SQUARE_OFF | −419 |
| 4 | SHADOW | SENSEX 83000 CE | 12 Nov 12:55 | same | SQUARE_OFF | −451 |
| 5 | PAPER | SENSEX 80800 PE | 13 Nov 10:21 | BULLISH, **13 bars** | TREND_FLIP | −87 |
| 6 | SHADOW | SENSEX 80800 PE | 13 Nov 10:21 | same | TREND_FLIP | −151 |
| 7 | PAPER | NIFTY 25000 PE | 13 Nov 10:25 | BULLISH, **14 bars** | TREND_FLIP | −602 |
| 8 | SHADOW | NIFTY 25000 PE | 13 Nov 10:25 | same | TREND_FLIP | −625 |
| 9 | SHADOW | SENSEX 82500 CE | 13 Nov 11:55 | BEARISH, gap 0.035% | SQUARE_OFF | +353 |
| 10 | PAPER | NIFTY 25350 CE | 13 Nov 12:06 | BEARISH, gap 0.053% | **TP** | **+2,687** |
| 11 | SHADOW | NIFTY 25350 CE | 13 Nov 12:06 | same | **TP** | **+2,667** |
| 12 | PAPER | SENSEX 82400 CE | 13 Nov 12:11 | BEARISH | SQUARE_OFF | −848 |
| 13 | PAPER | NIFTY 25250 CE | 13 Nov **14:20** | BEARISH, 0.31% below avg | **SL** in 18 min | **−3,055** |
| 14 | SHADOW | NIFTY 25250 CE | 13 Nov **14:20** | same | **SL** in 18 min | **−2,951** |

**Totals:**
- **PAPER:** 7 trades, 1 win, net **−₹2,666**. Charges were ₹457.
- **SHADOW:** 7 trades, 2 wins, net **−₹1,513**. Charges were ₹456.
- The average loss (about −₹900) is a third of the average win (about +₹2,700). With 1–2 wins in 7, that still loses.

**What went wrong:**

1. **Trades 5–8 were opened on an unfinished trend reading.** The trend uses EMA21, but these entries came after only 13–14 bars. With fewer than 21 bars, EMA21 is mostly its starting value, so the "trend" is really just the first hour's direction. Both NIFTY and SENSEX reversed within 90 minutes and the trend-flip exits fired.
2. **Trades 13–14 were opened late, into a move that had already happened.** By 14:20, NIFTY was already 0.31% below its session average. A late sell into a stretched move has little time left to decay and sharp reversal risk, and NIFTY bounced. Stop hit in 18 minutes for −₹3,000.
3. **Several trades ended at 15:15 slightly down (1–4, 12).** With 4–6 days to expiry, an option only loses about 5–10% of its value from time decay in a whole day. A 30% target almost always needs the index to move in your favour. When the trend stalls, the trade drifts to square-off slightly negative, and charges make it worse.
4. **The winners (9–11) came from late-morning entries with a clear, settled trend.** That is the setup v2 keeps.

14 trades over 2 days is far too few to conclude anything on its own. That's why the changes below were tested on 60 days of data before being made.

---

## 4. How v2 was tested

- **Data:** 5-minute NIFTY 50 and SENSEX candles for the last 60 trading days (18 Aug–13 Nov 2026), plus daily India VIX. Source: public Yahoo Finance history. Your local `.env` has no Kite API key, so Kite history couldn't be used.
- **Engine:** the same `intradayTrend` code that runs live, replayed bar by bar.
- **Option prices:** Black-76 priced from the index, at the previous day's India VIX (SENSEX +1 point), with each index's real weekly expiry day and lot size.
- **Fills:** 0.5% worse than the model price on both entry and exit, plus the same `roundTripCharges` used live.
- **Stops and targets:** checked against each bar's high and low. If both are hit in the same bar, the stop counts.
- **Each idea was tested alone first, then in combination.** A change was kept only if it helped in both halves of the period and on both indices.

**Ideas tested and rejected:**

| Idea | Result (60 days, net ₹) | Why rejected |
|---|---|---|
| Sell on expiry day / sell 0–2 days-to-expiry options (more time decay) | −₹28k to −₹59k, PF 0.52–0.67 | Expiry-day swings blow through stops faster than time decay pays |
| Sell against stretched moves instead of with the trend | −₹35k to −₹110k, PF 0.3–0.5 | Intraday index trends continue more often than they reverse |
| Lower delta (0.20 / 0.15) | −₹41k | Fewer points per move, but premium too small to cover charges |
| TP 20% / SL 40% | −₹82k | High win rate, but losses far outweigh wins |
| No trend-flip exit | −₹68k | The flip exit is a useful early stop |
| Stop on the index (close back through the session average) instead of on premium | −₹39k | Too many small stop-outs |

**The changes that helped:**

| Change alone | Net ₹ | PF |
|---|---|---|
| Warm-up 21 bars | −₹12,984 | 0.95 |
| EMA gap ≥ 0.06% | −₹13,812 | 0.95 |
| 2 entries/day | −₹17,879 | 0.93 |
| TP 50 / SL 50 | −₹17,416 | 0.94 |
| **All of warm-up 21 + gap 0.06 + 2/day** | **+₹47,053** | **1.35** |
| **+ TP 40 / SL 40 (chosen v2)** | **+₹54,582** | **1.40** |

None of the changes is profitable alone. Together they remove most of the low-quality entries, and what's left has an edge in the model.

---

## 5. Updated strategy (v2)

| Item | v1 | **v2** | Where it lives |
|---|---|---|---|
| Trend warm-up | 6 bars (09:45) | **21 bars (11:00)** | `MIN_TREND_BARS` in `src/naked-sell/engine.ts`, changed in code |
| Minimum EMA9–EMA21 gap | 0.03% | **0.06%** | `MIN_EMA_GAP_PCT` in `src/naked-sell/engine.ts`, changed in code |
| Entry window | 09:45–14:30 | **11:00–14:30** (follows from the warm-up) | default `entry_start_min` 660 |
| Take profit | 30% | **40%** | **Settings card**, you need to change it |
| Stop-loss | 30% | **40%** | **Settings card**, you need to change it |
| Entries per day per index | 8 | **2** | **Settings card**, you need to change it |
| Delta, lots, cooldown, daily loss, square-off, expiry-day rule, SHADOW liquidity gate | unchanged | unchanged | |

**The v2 rules:**
1. From 11:00 to 14:30, on each completed 5-minute bar, read the trend.
2. **Sell PE** only if price is above the session average, EMA9 is at least 0.06% above EMA21, and price is above EMA9. **Sell CE** on the mirror image.
3. Pick the ~0.30-delta OTM strike on the nearest weekly expiry, and never this week's on its expiry day.
4. Exit on whichever comes first:
   - Premium −40% (target).
   - Premium +40% (stop, 2-second confirmation).
   - Trend turns against the position (also needs the 0.06% gap).
   - 15:15 square-off.
5. At most 2 trades per index per day, with 15 minutes between them and a −₹5,000 daily stop.

**Code changed:**
- `src/naked-sell/engine.ts`: the warm-up and gap constants, and the default settings for new installs.
- `src/naked-sell/__tests__/engine.test.ts`: tests updated for the new rules; 15/15 pass, full suite 1,107/1,107.
- `src/components/NakedSell.jsx`: the Rules card and the empty-state text now say 11:00 and 0.06%.

**What you need to do:**
1. Deploy the code.
2. In Naked Sell → Settings, set **Take profit 40**, **Stop-loss 40**, **Entries/day 2**, then save. The code defaults only apply to a fresh settings row; your saved values (30/30/8) override them.

---

## 6. Limits of this analysis

- **Option prices are modelled, not real.** The model assumes implied volatility stays at yesterday's VIX all day. In reality volatility rises when the market falls, which hurts short PEs, and eases in calm afternoons, which helps. Real profits and losses will differ.
- **60 days, two indices, one market phase.** Choosing 3 changes from about 30 combinations tested on the same data risks fitting to the past. Both halves of the period being positive is reassuring, but it isn't proof.
- **The edge is thin.** With 2% worse fills, v2's profit factor drops to about 1.13. SHADOW fills are at bid and ask, so watch the SHADOW numbers, not PAPER.
- **Uncapped risk.** A gap or sudden spike can jump past the 40% stop. Losses on a naked short have no hard limit.

**How to judge v2 going forward:**
- **Wait for at least 20 trading days of SHADOW** before drawing conclusions.
- **On track:** a SHADOW profit factor above 1.2, with an average loss no bigger than about 1.3× the average win.
- **Stop and review:** SHADOW is still below a profit factor of 1.0 after about 40 trades, or one trade loses more than 1.5× the stop.
