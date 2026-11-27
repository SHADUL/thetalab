"""
ThetaLab Naked Sell — OpenAlgo Python Strategy (ANALYZER / PAPER ONLY)
=====================================================================

A port of ThetaLab's intraday Naked Sell rules (src/naked-sell/engine.ts and
api/naked-sell.ts, SHADOW mode) to OpenAlgo's Python Strategy Host, so the two
can be compared side by side.

RULES (same as ThetaLab)
- Trend, per index, from today's COMPLETED 5-minute candles (needs 21 bars = 11:00):
    BULLISH  close > session average (mean of (h+l+c)/3), EMA9 - EMA21 >= 0.06% of price, close > EMA9
    BEARISH  the mirror image
    else     NEUTRAL (no trade)
- BULLISH -> SELL a PE, BEARISH -> SELL a CE, one lot setting, intraday (MIS).
- Strike: the OTM strike of that side whose Black-76 |delta| is closest to 0.30
  (each strike's own implied vol from its mid price), within 4% of spot.
- Liquidity gate: bid/ask spread <= 5% and volume >= 100, else skip.
- Expiry: nearest weekly; on its own expiry day, no new entries.
- Exits, checked every few seconds (SL/TP must hold on 2 checks in a row):
    SL          premium (ask) >= entry x 1.40
    SQUARE_OFF  15:25 IST
    TP          premium (ask) <= entry x 0.60
    TREND_FLIP  the intraday trend turns against the position
- Entry window 09:45-14:30 IST; per index: 15 min cooldown after an exit, a cap on entries
  per day, a daily loss limit (closed trades), one open position.

SAFETY
- Orders are sent ONLY while OpenAlgo's Analyzer mode is ON (sandbox, virtual
  funds). If Analyzer is OFF the strategy sends nothing, not even an exit:
  a sandbox position closed in LIVE mode would open a real position.
- Every value below can be changed with an environment variable in the
  strategy's settings in OpenAlgo (Python Strategy -> Environment Variables).

Runs under OpenAlgo's Python Strategy Host, which provides OPENALGO_API_KEY and
OPENALGO_HOST. Schedule it Mon-Fri 09:30 -> 15:35 IST.
"""
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def env_num(name, default):
    try:
        return type(default)(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Settings (defaults = ThetaLab Naked Sell SHADOW settings on 27 Nov 2026)
# ---------------------------------------------------------------------------
SYMBOLS = [s.strip().upper() for s in os.getenv("SYMBOLS", "NIFTY,SENSEX").split(",") if s.strip()]
LOTS = env_num("LOTS", 2)
TARGET_DELTA = env_num("TARGET_DELTA", 0.30)
TP_PCT = env_num("TP_PCT", 40.0)
SL_PCT = env_num("SL_PCT", 40.0)
ENTRY_START = os.getenv("ENTRY_START", "09:45")
ENTRY_END = os.getenv("ENTRY_END", "14:30")
SQUARE_OFF = os.getenv("SQUARE_OFF", "15:25")
MAX_ENTRIES_PER_DAY = env_num("MAX_ENTRIES_PER_DAY", 8)
MAX_DAILY_LOSS = env_num("MAX_DAILY_LOSS", 10000.0)
COOLDOWN_MIN = env_num("COOLDOWN_MIN", 15)
MAX_SPREAD_PCT = env_num("MAX_SPREAD_PCT", 5.0)
MIN_VOLUME = env_num("MIN_VOLUME", 100)
POLL_SEC = env_num("POLL_SEC", 3)
STRATEGY = os.getenv("STRATEGY_NAME", "ThetaLabNakedSell")

MIN_TREND_BARS = 21
MIN_EMA_GAP_PCT = 0.06
STRIKE_WINDOW_PCT = 4.0
RATE = 0.065
PRICE_EXIT_CONFIRMATIONS = 2
SCAN_EVERY_SEC = 55

INDEX = {
    "NIFTY": {"exchange": "NSE_INDEX", "opt_exchange": "NFO"},
    "SENSEX": {"exchange": "BSE_INDEX", "opt_exchange": "BFO"},
}


def hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def log(msg):
    print(f"[{datetime.now(IST).strftime('%H:%M:%S')}] {msg}", flush=True)


def r2(v):
    return round(v + 0.0, 2)


# ---------------------------------------------------------------------------
# Pure rules (mirror src/naked-sell/engine.ts)
# ---------------------------------------------------------------------------
def ema(values, period):
    k = 2 / (period + 1)
    out = []
    for i, v in enumerate(values):
        out.append(v if i == 0 else v * k + out[-1] * (1 - k))
    return out


def intraday_trend(bars):
    """bars: list of dicts with h, l, c (completed 5-minute candles, oldest first)."""
    if len(bars) < MIN_TREND_BARS:
        return "NEUTRAL", f"only {len(bars)} completed 5-min bars (need {MIN_TREND_BARS})"
    closes = [b["c"] for b in bars]
    session_avg = sum((b["h"] + b["l"] + b["c"]) / 3 for b in bars) / len(bars)
    e9, e21, close = ema(closes, 9)[-1], ema(closes, 21)[-1], closes[-1]
    gap = (e9 - e21) / close * 100
    detail = f"close {close:.2f} avg {session_avg:.2f} ema9 {e9:.2f} ema21 {e21:.2f} gap {gap:.3f}%"
    if close > session_avg and gap >= MIN_EMA_GAP_PCT and close > e9:
        return "BULLISH", detail
    if close < session_avg and gap <= -MIN_EMA_GAP_PCT and close < e9:
        return "BEARISH", detail
    return "NEUTRAL", detail


def side_for_trend(trend):
    return "PE" if trend == "BULLISH" else "CE" if trend == "BEARISH" else None


def trend_against(right, trend):
    return (right == "PE" and trend == "BEARISH") or (right == "CE" and trend == "BULLISH")


def mid_of(bid, ask, last):
    if bid and ask and bid > 0 and ask > 0 and ask >= bid:
        return (bid + ask) / 2
    return last if last and last > 0 else None


def spread_pct(bid, ask):
    if not (bid and ask and bid > 0 and ask > 0):
        return None
    return (ask - bid) / ((ask + bid) / 2) * 100


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def black76(forward, strike, t, vol, rate, right):
    """Black-76 price and delta of an option on the forward."""
    if t <= 0 or vol <= 0:
        return None, None
    sd = vol * math.sqrt(t)
    d1 = (math.log(forward / strike) + 0.5 * vol * vol * t) / sd
    d2 = d1 - sd
    df = math.exp(-rate * t)
    if right == "CE":
        return df * (forward * _ncdf(d1) - strike * _ncdf(d2)), df * _ncdf(d1)
    return df * (strike * _ncdf(-d2) - forward * _ncdf(-d1)), -df * _ncdf(-d1)


def implied_vol(price, forward, strike, t, rate, right):
    lo, hi = 0.005, 5.0
    plo, _ = black76(forward, strike, t, lo, rate, right)
    phi, _ = black76(forward, strike, t, hi, rate, right)
    if plo is None or phi is None or not (plo <= price <= phi):
        return None
    for _ in range(100):
        mid = (lo + hi) / 2
        p, _ = black76(forward, strike, t, mid, rate, right)
        if p < price:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-6:
            break
    return (lo + hi) / 2


def years_to_expiry(expiry_date, now):
    exp = datetime(expiry_date.year, expiry_date.month, expiry_date.day, 15, 30, tzinfo=IST)
    return max((exp - now).total_seconds(), 0) / (365 * 86400)


def pick_strike(rows, right, spot, expiry_date, now, target_delta):
    """rows: [{strike, symbol, bid, ask, ltp, volume, lotsize}] for one side. Closest |delta| to target, OTM only."""
    t = years_to_expiry(expiry_date, now)
    if t <= 0:
        return None
    forward = spot * math.exp(RATE * t)
    best = None
    for q in rows:
        k = q["strike"]
        if (right == "PE" and not k < spot) or (right == "CE" and not k > spot):
            continue
        if abs(k - spot) / spot * 100 > STRIKE_WINDOW_PCT:
            continue
        m = mid_of(q["bid"], q["ask"], q["ltp"])
        if m is None:
            continue
        iv = implied_vol(m, forward, k, t, RATE, right)
        if iv is None:
            continue
        _, delta = black76(forward, k, t, iv, RATE, right)
        d = abs(delta)
        if best is None or abs(d - target_delta) < abs(best["delta"] - target_delta):
            best = {**q, "mid": r2(m), "iv": round(iv, 4), "delta": round(d, 3)}
    return best


def liquidity_problems(q):
    out = []
    sp = spread_pct(q["bid"], q["ask"])
    if sp is None:
        out.append("no two-sided bid/ask")
    elif sp > MAX_SPREAD_PCT:
        out.append(f"bid/ask spread {sp:.1f}% above {MAX_SPREAD_PCT}%")
    if (q.get("volume") or 0) < MIN_VOLUME:
        out.append(f"volume {q.get('volume') or 0} below {MIN_VOLUME}")
    return out


def check_exit(pos, price, trend, minute):
    if price is not None and price >= pos["sl"]:
        return "SL", f"premium {price} >= stop {pos['sl']}"
    if minute >= hm(SQUARE_OFF):
        return "SQUARE_OFF", "intraday square-off time reached"
    if price is not None and price <= pos["tp"]:
        return "TP", f"premium {price} <= target {pos['tp']}"
    if trend and trend_against(pos["right"], trend):
        return "TREND_FLIP", f"intraday trend turned {trend}"
    return None, ""


def round_trip_charges(entry, exit_, qty, exchange):
    sell_t, buy_t = entry * qty, exit_ * qty
    turnover = sell_t + buy_t
    brokerage = 40
    stt = 0.001 * sell_t
    txn = (0.000325 if exchange == "BFO" else 0.0003503) * turnover
    sebi = turnover * 10 / 1e7
    stamp = 0.00003 * buy_t
    gst = 0.18 * (brokerage + txn + sebi)
    return r2(brokerage + stt + txn + sebi + stamp + gst)


def entry_blocker(minute, is_expiry_day, has_open, entries_today, realized_today, minutes_since_exit):
    if minute < hm(ENTRY_START):
        return "before entry window"
    if minute > hm(ENTRY_END):
        return "after entry window"
    if is_expiry_day:
        return "expiry day (gamma risk)"
    if has_open:
        return "position already open"
    if entries_today >= MAX_ENTRIES_PER_DAY:
        return f"max {MAX_ENTRIES_PER_DAY} entries today reached"
    if realized_today <= -abs(MAX_DAILY_LOSS):
        return f"daily loss limit {MAX_DAILY_LOSS} hit"
    if minutes_since_exit is not None and minutes_since_exit < COOLDOWN_MIN:
        return f"cooldown ({COOLDOWN_MIN} min after last exit)"
    return None


def parse_expiry(s):
    for fmt in ("%d-%b-%y", "%d%b%y", "%d-%b-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip().title(), fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Strategy (I/O through the OpenAlgo client)
# ---------------------------------------------------------------------------
class NakedSell:
    def __init__(self, client, state_dir, now_fn=lambda: datetime.now(IST), sleep_fn=time.sleep):
        self.c = client
        self.now = now_fn
        self.sleep = sleep_fn
        self.state_dir = state_dir
        self.date = None
        self.state = None
        self.trend = {}        # symbol -> (state, at)
        self.pending = {}      # symbol -> (reason, count)
        self.last_scan = 0.0
        self.last_trend_log = {}
        self.last_skip = {}
        self.analyzer_warned = False

    # ---- persistence: one JSON per day, so a restart resumes the day ----
    def path(self):
        return os.path.join(self.state_dir, f"naked_sell_{self.date}.json")

    def load_day(self, today):
        self.date = today
        self.state = {"date": today, "open": {}, "trades": []}
        try:
            with open(self.path()) as f:
                self.state = json.load(f)
            log(f"resumed {today}: {len(self.state['trades'])} closed, {len(self.state['open'])} open")
        except FileNotFoundError:
            pass
        except Exception as e:  # corrupt file: start clean but keep it
            log(f"could not read state ({e}) — starting the day clean")

    def save(self):
        tmp = self.path() + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f, indent=1)
        os.replace(tmp, self.path())

    # ---- broker-side helpers ----
    def analyzer_on(self):
        try:
            r = self.c.analyzerstatus()
            return bool(r.get("data", {}).get("analyze_mode")) if r.get("status") == "success" else None
        except Exception as e:
            log(f"analyzer status failed: {e}")
            return None

    def bars(self, symbol, now):
        day = now.strftime("%Y-%m-%d")
        df = self.c.history(symbol=symbol, exchange=INDEX[symbol]["exchange"], interval="5m", start_date=day, end_date=day)
        if isinstance(df, dict):
            raise RuntimeError(df.get("message", "history failed"))
        out = []
        for ts, row in df.iterrows():
            t = ts.to_pydatetime()
            t = t.astimezone(IST) if t.tzinfo else t.replace(tzinfo=IST)
            if t.date() != now.date() or t + timedelta(minutes=5) > now:
                continue  # other days, and the still-forming candle
            out.append({"h": float(row["high"]), "l": float(row["low"]), "c": float(row["close"])})
        return out

    def nearest_expiry(self, symbol):
        r = self.c.expiry(symbol=symbol, exchange=INDEX[symbol]["opt_exchange"], instrumenttype="options")
        if r.get("status") != "success":
            raise RuntimeError(r.get("message", "expiry failed"))
        dates = sorted(d for d in (parse_expiry(x) for x in r.get("data", [])) if d)
        today = self.now().date()
        upcoming = [d for d in dates if d >= today]
        return upcoming[0] if upcoming else None

    def chain(self, symbol, expiry_date, right):
        r = self.c.optionchain(underlying=symbol, exchange=INDEX[symbol]["exchange"],
                               expiry_date=expiry_date.strftime("%d%b%y").upper(), strike_count=40)
        if r.get("status") != "success":
            raise RuntimeError(r.get("message", "optionchain failed"))
        key = right.lower()
        rows = []
        for item in r.get("chain", []):
            leg = item.get(key)
            if not leg or not leg.get("symbol"):
                continue
            rows.append({"strike": float(item["strike"]), "symbol": leg["symbol"], "bid": float(leg.get("bid") or 0),
                         "ask": float(leg.get("ask") or 0), "ltp": float(leg.get("ltp") or 0),
                         "volume": float(leg.get("volume") or 0), "lotsize": int(leg.get("lotsize") or 0)})
        return float(r.get("underlying_ltp") or 0), rows

    def quote(self, symbol, exchange):
        r = self.c.quotes(symbol=symbol, exchange=exchange)
        if r.get("status") != "success":
            return None
        d = r.get("data", {})
        return {"bid": float(d.get("bid") or 0), "ask": float(d.get("ask") or 0), "ltp": float(d.get("ltp") or 0)}

    def fill_price(self, order_id, fallback):
        for _ in range(5):
            try:
                r = self.c.orderstatus(order_id=order_id, strategy=STRATEGY)
                d = r.get("data", {}) if r.get("status") == "success" else {}
                st = str(d.get("order_status", "")).lower()
                avg = float(d.get("average_price") or 0)
                if st in ("complete", "completed") and avg > 0:
                    return avg, "complete"
                if st in ("rejected", "cancelled"):
                    return None, st
            except Exception as e:
                log(f"orderstatus {order_id} failed: {e}")
            self.sleep(1)
        return fallback, "assumed"  # sandbox fills MARKET immediately; use the quote if status lags

    def order(self, symbol, exchange, action, qty):
        r = self.c.placeorder(strategy=STRATEGY, symbol=symbol, action=action, exchange=exchange,
                              price_type="MARKET", product="MIS", quantity=str(qty))
        if r.get("status") != "success" or not r.get("orderid"):
            raise RuntimeError(r.get("message", f"placeorder failed: {r}"))
        return str(r["orderid"])

    # ---- day bookkeeping ----
    def trades_today(self):
        return self.state["trades"]

    def realized_today(self):
        return sum(t["net"] for t in self.state["trades"])

    # ---- scan: trends + entries, about once a minute ----
    def scan(self, now, analyzer):
        minute = now.hour * 60 + now.minute
        for symbol in SYMBOLS:
            if symbol not in INDEX:
                continue
            try:
                trend, why = intraday_trend(self.bars(symbol, now))
                self.trend[symbol] = (trend, now.timestamp())
                if self.last_trend_log.get(symbol) != trend:
                    log(f"{symbol} trend -> {trend} ({why})")
                    self.last_trend_log[symbol] = trend
                self.try_entry(symbol, trend, now, minute, analyzer)
            except Exception as e:
                log(f"{symbol} scan failed: {e}")

    def skip(self, symbol, why):
        if self.last_skip.get(symbol) != why:
            log(f"{symbol}: no entry — {why}")
            self.last_skip[symbol] = why

    def try_entry(self, symbol, trend, now, minute, analyzer):
        right = side_for_trend(trend)
        if not right:
            return
        expiry = self.nearest_expiry(symbol)
        if not expiry:
            return self.skip(symbol, "no expiry found")
        # As in ThetaLab SHADOW: entries/day, loss limit and cooldown count per index.
        mine = [t for t in self.trades_today() if t["symbol"] == symbol]
        last_exit = max((t["exit_at"] for t in mine), default=None)
        has_open = symbol in self.state["open"]
        block = entry_blocker(minute, expiry == now.date(), has_open, len(mine) + (1 if has_open else 0),
                              sum(t["net"] for t in mine), (now.timestamp() - last_exit) / 60 if last_exit else None)
        if block:
            return self.skip(symbol, block)
        if not analyzer:
            return self.skip(symbol, f"{trend} signal, but Analyzer mode is OFF — no order sent")
        spot, rows = self.chain(symbol, expiry, right)
        if not spot:
            return self.skip(symbol, "no underlying price")
        pick = pick_strike(rows, right, spot, expiry, now, TARGET_DELTA)
        if not pick:
            return self.skip(symbol, f"{trend} but no {right} strike had a usable price")
        liq = liquidity_problems(pick)
        if liq:
            return self.skip(symbol, f"{pick['symbol']} too illiquid ({'; '.join(liq)})")
        if not pick["lotsize"]:
            return self.skip(symbol, "no lot size")
        qty = pick["lotsize"] * LOTS
        exch = INDEX[symbol]["opt_exchange"]
        oid = self.order(pick["symbol"], exch, "SELL", qty)
        price, st = self.fill_price(oid, pick["bid"])
        if price is None:
            return self.skip(symbol, f"entry {st} (order {oid})")
        pos = {"symbol": symbol, "tradingsymbol": pick["symbol"], "exchange": exch, "right": right, "qty": qty,
               "entry": r2(price), "tp": r2(price * (1 - TP_PCT / 100)), "sl": r2(price * (1 + SL_PCT / 100)),
               "entry_at": now.timestamp(), "entry_order": oid, "delta": pick["delta"], "iv": pick["iv"], "spot": spot,
               "expiry": expiry.isoformat()}
        self.state["open"][symbol] = pos
        self.save()
        self.last_skip.pop(symbol, None)
        log(f"SOLD {qty} {pick['symbol']} @ {pos['entry']} ({trend} -> sell {right}, delta {pick['delta']}, IV {pick['iv']}). "
            f"TP {pos['tp']} SL {pos['sl']}")

    # ---- monitor: exits, every POLL_SEC ----
    def monitor(self, now, analyzer):
        minute = now.hour * 60 + now.minute
        for symbol, pos in list(self.state["open"].items()):
            q = self.quote(pos["tradingsymbol"], pos["exchange"])
            price = q["ask"] if q and q["ask"] > 0 else None  # buying back pays the ask
            t = self.trend.get(symbol)
            trend = t[0] if t and now.timestamp() - t[1] < 180 else None
            reason, detail = check_exit(pos, price, trend, minute)
            if not reason:
                self.pending.pop(symbol, None)
                continue
            if reason in ("SL", "TP"):
                prev = self.pending.get(symbol)
                count = prev[1] + 1 if prev and prev[0] == reason else 1
                if count < PRICE_EXIT_CONFIRMATIONS:
                    self.pending[symbol] = (reason, count)
                    continue
            self.pending.pop(symbol, None)
            if not analyzer:
                log(f"{symbol}: EXIT {reason} due but Analyzer mode is OFF — NOT sending (it would be a real order). "
                    f"Turn Analyzer back on; the exit is retried.")
                continue
            self.close(symbol, pos, reason, detail, price if price else (q["ltp"] if q else pos["entry"]), now)

    def close(self, symbol, pos, reason, detail, ref_price, now):
        try:
            oid = self.order(pos["tradingsymbol"], pos["exchange"], "BUY", pos["qty"])
        except Exception as e:
            log(f"{symbol}: exit order failed ({e}) — retrying next check")
            return
        price, st = self.fill_price(oid, ref_price)
        if price is None:
            log(f"{symbol}: exit {st} (order {oid}) — retrying next check")
            return
        gross = r2((pos["entry"] - price) * pos["qty"])
        charges = round_trip_charges(pos["entry"], price, pos["qty"], pos["exchange"])
        trade = {**pos, "exit": r2(price), "exit_at": now.timestamp(), "exit_order": oid, "reason": reason,
                 "detail": detail, "gross": gross, "charges": charges, "net": r2(gross - charges)}
        self.state["trades"].append(trade)
        del self.state["open"][symbol]
        self.save()
        log(f"CLOSED {pos['tradingsymbol']} {reason} ({detail}): {pos['entry']} -> {trade['exit']}, "
            f"net {trade['net']:+.2f} (charges {charges}). Day: {len(self.state['trades'])} trades, net {self.realized_today():+.2f}")

    def summary(self):
        tr = self.state["trades"]
        wins = sum(1 for t in tr if t["net"] > 0)
        log(f"DAY SUMMARY {self.date}: {len(tr)} trades, {wins} winners, net {self.realized_today():+.2f}, "
            f"open {len(self.state['open'])}")

    # ---- main loop ----
    def step(self):
        now = self.now()
        today = now.strftime("%Y-%m-%d")
        if today != self.date:
            self.load_day(today)
        analyzer = self.analyzer_on()
        if analyzer is False and not self.analyzer_warned:
            log("Analyzer mode is OFF — this strategy sends no orders until it is turned on.")
            self.analyzer_warned = True
        if analyzer:
            self.analyzer_warned = False
        minute = now.hour * 60 + now.minute
        if hm("09:15") <= minute <= hm("15:30"):
            if time.time() - self.last_scan >= SCAN_EVERY_SEC:
                self.last_scan = time.time()
                self.scan(now, analyzer)
            self.monitor(now, analyzer)
        return minute

    def run(self):
        log(f"ThetaLab Naked Sell started — {','.join(SYMBOLS)}, {LOTS} lot(s), delta {TARGET_DELTA}, TP {TP_PCT}% SL {SL_PCT}%, "
            f"entries {ENTRY_START}-{ENTRY_END}, square-off {SQUARE_OFF}, max {MAX_ENTRIES_PER_DAY}/day, loss limit {MAX_DAILY_LOSS}. "
            f"Orders only in Analyzer mode.")
        summarized = None
        while True:
            try:
                minute = self.step()
                if minute > hm("15:30") and summarized != self.date:
                    self.summary()
                    summarized = self.date
            except Exception as e:
                log(f"loop error: {e}")
            self.sleep(POLL_SEC)


if __name__ == "__main__":
    from openalgo import api

    key = os.getenv("OPENALGO_API_KEY")
    if not key:
        sys.exit("OPENALGO_API_KEY is not set (run this inside OpenAlgo's Python Strategy Host)")
    client = api(api_key=key, host=os.getenv("OPENALGO_HOST", "http://127.0.0.1:5000"))
    NakedSell(client, os.path.dirname(os.path.abspath(__file__))).run()
