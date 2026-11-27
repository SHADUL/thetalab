# OpenAlgo strategies

Strategies written for the separately installed OpenAlgo (https://openalgo.130-210-19-135.sslip.io),
run by its **Python Strategy Host**. They are not part of the ThetaLab server.

## naked_sell.py — ThetaLab Naked Sell (Analyzer only)

The same rules as ThetaLab's Naked Sell (SHADOW mode): 5-minute trend from 11:00, sell a ~0.30-delta
OTM option in the trend's direction, TP 40% / SL 40% / trend flip / 15:25 square-off.
Defaults copy ThetaLab's SHADOW settings on 27 Nov 2026:
2 lots, at most 8 entries a day per index, ₹10,000 daily loss per index, 15-minute cooldown.

**It sends orders only while OpenAlgo's Analyzer mode is ON.** With Analyzer off it sends nothing, not
even an exit: closing a sandbox position in live mode would open a real position.

### Install
1. OpenAlgo → **Python** (`/python`) → **Add strategy**. Upload `naked_sell.py`.
2. Schedule: Mon–Fri, start **09:30**, stop **15:35** IST.
3. Make sure **Analyzer** mode is ON (toggle at the top of OpenAlgo), then **Start**.
4. Logs stream on the strategy page. Each day's state and trades are saved next to the script as
   `naked_sell_YYYY-MM-DD.json`, so a restart resumes the day without re-entering.

### Settings (optional environment variables in the strategy's settings)
| Variable | Default | Meaning |
|---|---|---|
| `SYMBOLS` | `NIFTY,SENSEX` | Indices to trade |
| `LOTS` | `2` | Lots per entry |
| `TARGET_DELTA` | `0.30` | Strike choice |
| `TP_PCT` / `SL_PCT` | `40` / `40` | Target and stop, % of the entry premium |
| `ENTRY_START` / `ENTRY_END` | `09:45` / `14:30` | Entry window (IST); the trend needs 21 bars, so the first entry is ~11:00 |
| `SQUARE_OFF` | `15:25` | Close everything |
| `MAX_ENTRIES_PER_DAY` | `8` | Per index |
| `MAX_DAILY_LOSS` | `10000` | ₹, closed trades, per index |
| `COOLDOWN_MIN` | `15` | Minutes after an exit, per index |
| `MAX_SPREAD_PCT` / `MIN_VOLUME` | `5` / `100` | Liquidity gate |
| `POLL_SEC` | `3` | Exit check interval |

### Tests
`python3 -m unittest test_naked_sell` (fake OpenAlgo client, no network). The trend and strike rules were
also checked against ThetaLab's TypeScript engine on 300 random cases: identical results.

### Differences from ThetaLab
- Fills are OpenAlgo's sandbox fills for MARKET orders, not ThetaLab's bid/ask model.
- Exit checks run every 3 s on REST quotes (ThetaLab: 1 s on the live stream).
- No margin check against capital (the sandbox applies its own margin).

## nifty_ascent.py — ThetaLab NIFTY ASCENT, Gap-and-Go → Williams (Analyzer only)

The live-paper rules **V1.0 + OR60 + ROLL1** with **EXEC-2** risk:
- 1 lot of the 150-point ITM NIFTY option.
- At most ₹20,000 outlay including fees. Entry needs spread ≤ 1.5% and day volume ≥ 500.
- 70% fixed stop; trailing stop arms above 105% of entry and exits at 80% of the high; 15:15 time exit.
- One trade a day.

Signals come from NIFTY 1-minute candles, the same way ThetaLab's historical backtester feeds its engine.
**Checked against ThetaLab's real engine on 400 random days: identical signal (bot, side, minute) or
no-trade reason, and identical strike and expiry.**

Same Analyzer-only safety as above. It also never takes a signal it did not see in real time: if it
starts after a signal minute, the day is recorded as `missed_signal`.

### Install
Upload `nifty_ascent.py` in OpenAlgo → Python. Schedule Mon–Fri **09:10 → 15:35** IST. Analyzer ON, then Start.
It must be running before 09:46 to trade that day. Its state is saved as `nifty_ascent_YYYY-MM-DD.json`.

### Settings (optional environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `LOTS` | `1` | Lots |
| `MAX_OUTLAY` / `MAX_LOSS` | `20000` / `20000` | ₹ (EXEC-2) |
| `MAX_SPREAD_PCT` / `MIN_VOLUME` | `1.5` / `500` | Entry liquidity gate |
| `MIN_OR_WIDTH` | `60` | OR60 filter (0 = off, plain V1) |
| `ROLL_DAYS` | `1` | ROLL1 expiry roll (0 = off) |

### Tests
`python3 -m unittest test_nifty_ascent` — entry contract and timing, fixed and trailing stops, no-print
minutes, time exit, liquidity and budget rejections, Analyzer off, late start, restart, expiry roll and
strike ties.

### Differences from ThetaLab's live paper
- Today's reference is the 09:15 candle's open, and a gap fill is any 1-minute low/high touching the
  previous close up to the breakout minute. ThetaLab uses individual ticks, so a fill late in the
  breakout minute could differ.
- Entries and exits are MARKET orders filled by OpenAlgo's sandbox, not ThetaLab's
  "first fresh ask/bid + 0.25%" model. The 2-second quote-age check is not applied.
- Stops are decided on the option's 1-minute candles from OpenAlgo's history, a few seconds after each minute.
