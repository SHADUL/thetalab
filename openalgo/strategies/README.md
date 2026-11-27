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
