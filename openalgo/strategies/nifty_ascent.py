"""
ThetaLab NIFTY ASCENT (Gap-and-Go -> Williams) — OpenAlgo Python Strategy (ANALYZER / PAPER ONLY)
=================================================================================================

A port of ThetaLab's NIFTY ASCENT live-paper rules (V1.0+OR60+ROLL1, EXEC-2) to OpenAlgo's
Python Strategy Host. Signals are computed from NIFTY 1-minute candles exactly as ThetaLab's
historical backtester does (src/nifty-ascent/sim/historical.ts drives the real engine with the
same candles); option orders go to OpenAlgo's Analyzer sandbox.

RULES
- previous_close = close of the previous trading day's 15:15 bar (needs >= 370 of its 375 bars).
- today_open     = open of today's 09:15 bar. Gap = today_open - previous_close (zero gap: no trade).
- Opening range  = the 31 one-minute CLOSES 09:15 ... 09:45. W = high - low.
  OR60 filter: W < 60 points -> no trade today.
  Bands: UP = OR_HIGH + 0.10 W, DOWN = OR_LOW - 0.10 W (strictly beyond, on a 1-minute close).
- Gap-and-Go, bars 09:46 ... 12:00: gap up -> BUY CE on a close above UP; gap down -> BUY PE below DOWN.
    opposite band broken first             -> stand down `opposite_first`
    breakout, but the gap already filled   -> stand down `filled`   (price touched previous_close
                                              in or before the breakout minute)
    no breakout by the 12:00 close         -> no trade (`no_break` never hands over)
- Williams (only after opposite_first / filled, and only if gap% < 0.2 or gap% >= 0.5):
  levels = today_open +/- 0.5 x (previous day's highest - lowest 1-minute close);
  from the hand-over minute through 14:29, the first close beyond a level -> BUY CE / PE.
- Any missing 1-minute bar in the opening range or a signal window -> no trade (data error).
- Option: 150 points ITM from the signal minute's close, rounded to the strike step (ties -> deeper ITM).
  Nearest expiry; on expiry day, or when it is <= 1 calendar day away (ROLL1), the next expiry.
- Entry in the minute after the signal: spread <= 1.5% of mid, day volume >= 500, and
  ask x 1.0025 x qty + fees <= Rs 20,000 (EXEC-2). Not possible in that minute -> no trade today.
- Stops on the option's 1-minute closes (a minute with no trade decides nothing):
    fixed stop     close <= 70% of entry
    trailing stop  arms on a close > 105% of entry; exits on a close <= 80% of the highest close
- Time exit 15:15. One position per day.

SAFETY
- Orders only while OpenAlgo's Analyzer mode is ON. With Analyzer OFF nothing is sent, not even an
  exit (closing a sandbox position in live mode would open a real one).
- A signal is acted on only in the minute right after it. A strategy started late never takes an
  old signal (as in ThetaLab, signals are never rebuilt from past data).

Schedule it Mon-Fri 09:10 -> 15:35 IST in OpenAlgo's Python Strategy Host.
"""
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def env_num(name, default):
    try:
        return type(default)(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Rules (RESEARCH_RULES_V1 + LIVE_PAPER_VARIANT) and execution (EXEC-2)
# ---------------------------------------------------------------------------
OR_FIRST, OR_LAST = 9 * 60 + 15, 9 * 60 + 45
GG_FIRST, GG_LAST = 9 * 60 + 46, 12 * 60
W_LAST = 14 * 60 + 29
PREV_CLOSE_BAR = 15 * 60 + 15
TIME_EXIT = 15 * 60 + 15
BAND_FRACTION = 0.10
W_LOW_GAP_PCT, W_HIGH_GAP_PCT = 0.2, 0.5
W_FRACTION = 0.5
ITM_POINTS = 150
FIXED_STOP, TRAIL_ON, TRAIL_STOP = 0.70, 1.05, 0.80
MIN_PREV_BARS = 370
MIN_OR_WIDTH = env_num("MIN_OR_WIDTH", 60.0)
ROLL_DAYS = env_num("ROLL_DAYS", 1)

LOTS = env_num("LOTS", 1)
MAX_OUTLAY = env_num("MAX_OUTLAY", 20000.0)
MAX_LOSS = env_num("MAX_LOSS", 20000.0)
MAX_SPREAD_PCT = env_num("MAX_SPREAD_PCT", 1.5)
MIN_VOLUME = env_num("MIN_VOLUME", 500)
SLIPPAGE = 0.0025
POLL_SEC = env_num("POLL_SEC", 2)
STRATEGY = os.getenv("STRATEGY_NAME", "ThetaLabNiftyAscent")


def paise(p):
    return int(round(p * 100))


def hhmm(label):
    return f"{label // 60:02d}:{label % 60:02d}"


def log(msg):
    print(f"[{datetime.now(IST).strftime('%H:%M:%S')}] {msg}", flush=True)


def r2(v):
    return round(v + 0.0, 2)


# ---------------------------------------------------------------------------
# Pure signal logic: 1-minute candles -> signal or no-trade (mirrors core/engine.ts)
# ---------------------------------------------------------------------------
def gap_pct_below(prev_close, today_open, threshold_pct):
    g = abs(paise(today_open) - paise(prev_close))
    return g * 1_000_000 < int(round(threshold_pct * 10_000)) * paise(prev_close)


def evaluate(prev_closes, bars, last_label):
    """
    prev_closes: {label: close} of the previous session.  bars: {label: {"o","h","l","c"}} of today.
    last_label: the latest COMPLETED minute. Returns a dict with "state" in
      WAITING | ARMED | SIGNAL | NO_TRADE | DATA_ERROR, plus "reason", "detail", levels and "signal".
    """
    out = {"state": "WAITING", "reason": None, "detail": "", "signal": None, "gap": None, "or": None, "williams": None,
           "fill_label": None, "handover": None}

    def end(state, reason, detail):
        out.update(state=state, reason=reason, detail=detail)
        return out

    closes = [c for c in prev_closes.values() if c and c > 0]
    if PREV_CLOSE_BAR not in prev_closes or len(closes) < MIN_PREV_BARS:
        why = "the 15:15 bar is missing" if PREV_CLOSE_BAR not in prev_closes else f"only {len(closes)} valid minute bars (need {MIN_PREV_BARS})"
        return end("DATA_ERROR", "data_error", f"previous session unavailable: {why}")
    prev_close = prev_closes[PREV_CLOSE_BAR]
    if last_label < OR_FIRST:
        return out
    if OR_FIRST not in bars:
        return end("DATA_ERROR", "data_error", "09:15 bar missing — today's opening reference not observed")

    today_open = bars[OR_FIRST]["o"]
    g = paise(today_open) - paise(prev_close)
    direction = "UP" if g > 0 else "DOWN" if g < 0 else "NONE"
    out["gap"] = {"prev_close": prev_close, "open": today_open, "points": g / 100, "pct": abs(g) / paise(prev_close) * 100, "direction": direction}
    rng = max(closes) - min(closes)
    out["williams"] = {"ce": today_open + W_FRACTION * rng, "pe": today_open - W_FRACTION * rng, "range": rng}
    w_eligible = gap_pct_below(prev_close, today_open, W_LOW_GAP_PCT) or not gap_pct_below(prev_close, today_open, W_HIGH_GAP_PCT)
    if direction == "NONE":
        return end("NO_TRADE", "no_gap", "zero gap — no direction, no Williams")

    # Earliest minute in which the index touched the previous close (gap filled).
    for label in sorted(b for b in bars if b <= last_label):
        b = bars[label]
        if (direction == "UP" and paise(b["l"]) <= paise(prev_close)) or (direction == "DOWN" and paise(b["h"]) >= paise(prev_close)):
            out["fill_label"] = label
            break

    phase, w_start = "OR", None
    for label in range(OR_FIRST, last_label + 1):
        b = bars.get(label)
        if phase == "OR":
            if b is None:
                return end("DATA_ERROR", "data_error", f"opening-range bar {hhmm(label)} is missing — no trade today")
            if label == OR_LAST:
                cs = [bars[l]["c"] for l in range(OR_FIRST, OR_LAST + 1)]
                hi, lo = max(cs), min(cs)
                w = hi - lo
                out["or"] = {"high": hi, "low": lo, "width": w, "up": hi + BAND_FRACTION * w, "down": lo - BAND_FRACTION * w}
                if MIN_OR_WIDTH and w < MIN_OR_WIDTH:
                    return end("NO_TRADE", "narrow_or", f"opening range {w:.2f} pts < {MIN_OR_WIDTH} pts minimum")
                phase = "GG"
            continue
        if phase == "GG":
            if label > GG_LAST:
                break
            if b is None:
                return end("DATA_ERROR", "data_error", f"Gap-and-Go bar {hhmm(label)} is missing")
            c, o, up = b["c"], out["or"], direction == "UP"
            stand = None
            if (up and c < o["down"]) or (not up and c > o["up"]):
                stand = "opposite_first"
            elif (up and c > o["up"]) or (not up and c < o["down"]):
                if out["fill_label"] is not None and out["fill_label"] <= label:
                    stand = "filled"
                else:
                    right = "CE" if up else "PE"
                    out["signal"] = {"bot": "GAP_AND_GO", "right": right, "bar": label, "close": c}
                    return end("SIGNAL", "breakout", f"close {c} {'>' if up else '<'} band at {hhmm(label)} -> BUY {right}")
            if stand:
                out["handover"] = {"reason": stand, "bar": label}
                if not w_eligible:
                    return end("NO_TRADE", "williams_gap_ineligible", f"stood down ({stand}); gap {out['gap']['pct']:.4f}% is in [0.2%, 0.5%) — Williams not allowed")
                phase, w_start = "W", label
            elif label == GG_LAST:
                return end("NO_TRADE", "no_break", "no qualifying breakout by 12:00 (does not hand over to Williams)")
            else:
                continue
        if phase == "W":
            if label < w_start:
                continue
            if label > W_LAST:
                break
            if b is None:
                return end("DATA_ERROR", "data_error", f"Williams bar {hhmm(label)} is missing")
            c, wl = b["c"], out["williams"]
            right = "CE" if c > wl["ce"] else "PE" if c < wl["pe"] else None
            if right:
                out["signal"] = {"bot": "WILLIAMS", "right": right, "bar": label, "close": c}
                return end("SIGNAL", "williams_trigger", f"close {c} {'>' if right == 'CE' else '<'} Williams level at {hhmm(label)} -> BUY {right}")
            if label == W_LAST:
                return end("NO_TRADE", "williams_no_trigger", "neither Williams level broke by 14:29")
    out["state"] = "ARMED" if phase in ("GG", "W") else "WAITING"
    out["detail"] = {"OR": "collecting the opening range", "GG": "Gap-and-Go armed", "W": "Williams armed"}[phase]
    return out


def strike_step(strikes, reference):
    near = sorted({paise(k) for k in strikes if abs(k - reference) <= 1000})
    diffs = [b - a for a, b in zip(near, near[1:]) if b > a]
    return min(diffs) / 100 if diffs else None


def itm_strike(reference, right, step):
    sp = paise(step)
    target = paise(reference) - paise(ITM_POINTS) if right == "CE" else paise(reference) + paise(ITM_POINTS)
    q, rem = divmod(target, sp)
    if rem * 2 < sp:
        k = q
    elif rem * 2 > sp:
        k = q + 1
    else:
        k = q if right == "CE" else q + 1
    return k * sp / 100


def choose_expiry(expiries, today):
    upcoming = sorted(e for e in expiries if e >= today)
    if not upcoming:
        return None, False
    e = upcoming[0]
    if e == today or (ROLL_DAYS and (e - today).days <= ROLL_DAYS):
        return (upcoming[1] if len(upcoming) > 1 else None), True
    return e, False


def buy_fees(premium, qty):
    t = premium * qty
    txn, sebi = t * 0.0003503, t * 10 / 1e7
    return r2(20 + txn + sebi + t * 0.00003 + 0.18 * (20 + txn + sebi))


def sell_fees(premium, qty):
    t = premium * qty
    txn, sebi = t * 0.0003503, t * 10 / 1e7
    return r2(20 + t * 0.001 + txn + sebi + 0.18 * (20 + txn + sebi))


def stop_check(pos, close):
    """Update the trail with a premium close; return 'FIXED_STOP' / 'TRAILING_STOP' / None."""
    pos["highest"] = close if pos.get("highest") is None else max(pos["highest"], close)
    c, e = paise(close), paise(pos["entry"])
    if not pos.get("trail") and c * 100 > e * round(TRAIL_ON * 100):
        pos["trail"] = True
        log(f"trailing stop armed: close {close} > 105% of entry {pos['entry']}")
    fixed = c * 100 <= e * round(FIXED_STOP * 100)
    trailing = pos.get("trail") and c * 100 <= paise(pos["highest"]) * round(TRAIL_STOP * 100)
    return "FIXED_STOP" if fixed else "TRAILING_STOP" if trailing else None


def parse_expiry(s):
    for fmt in ("%d-%b-%y", "%d%b%y", "%d-%b-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip().title(), fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Runner (OpenAlgo I/O)
# ---------------------------------------------------------------------------
class NiftyAscent:
    def __init__(self, client, state_dir, now_fn=lambda: datetime.now(IST), sleep_fn=time.sleep):
        self.c = client
        self.now = now_fn
        self.sleep = sleep_fn
        self.state_dir = state_dir
        self.date = None
        self.state = None
        self.prev = None
        self.prev_date = None
        self.last_eval_label = None
        self.last_opt_label = None
        self.last_status = None
        self.analyzer_warned = False

    # ---- persistence ----
    def path(self):
        return os.path.join(self.state_dir, f"nifty_ascent_{self.date}.json")

    def load_day(self, today):
        self.date, self.prev, self.prev_date = today, None, None
        self.last_eval_label = self.last_opt_label = self.last_status = None
        self.state = {"date": today, "done": None, "signal": None, "position": None, "trade": None, "entry_skips": {}}
        try:
            with open(self.path()) as f:
                self.state = json.load(f)
            log(f"resumed {today}: done={self.state['done']} position={'yes' if self.state['position'] else 'no'}")
        except FileNotFoundError:
            pass
        except Exception as e:
            log(f"could not read state ({e}) — starting the day clean")

    def save(self):
        tmp = self.path() + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f, indent=1)
        os.replace(tmp, self.path())

    def finish(self, reason, detail):
        if not self.state["done"]:
            self.state["done"] = {"reason": reason, "detail": detail}
            self.save()
            log(f"DAY OVER — {reason}: {detail}")

    # ---- data ----
    def analyzer_on(self):
        try:
            r = self.c.analyzerstatus()
            return bool(r.get("data", {}).get("analyze_mode")) if r.get("status") == "success" else None
        except Exception as e:
            log(f"analyzer status failed: {e}")
            return None

    def minute_bars(self, symbol, exchange, start, end):
        df = self.c.history(symbol=symbol, exchange=exchange, interval="1m", start_date=start, end_date=end)
        if isinstance(df, dict):
            if df.get("error_type") == "no_data":
                return {}
            raise RuntimeError(df.get("message", "history failed"))
        days = {}
        for ts, row in df.iterrows():
            t = ts.to_pydatetime()
            t = t.astimezone(IST) if t.tzinfo else t.replace(tzinfo=IST)
            days.setdefault(t.date().isoformat(), {})[t.hour * 60 + t.minute] = {
                "o": float(row["open"]), "h": float(row["high"]), "l": float(row["low"]), "c": float(row["close"]),
                "v": float(row.get("volume", 0) or 0)}
        return days

    def load_prev(self, now):
        start = (now.date() - timedelta(days=10)).isoformat()
        end = (now.date() - timedelta(days=1)).isoformat()
        days = self.minute_bars("NIFTY", "NSE_INDEX", start, end)
        if not days:
            raise RuntimeError("no previous-session data")
        self.prev_date = max(days)
        self.prev = {l: b["c"] for l, b in days[self.prev_date].items()}
        log(f"previous session {self.prev_date}: {len(self.prev)} bars, 15:15 close {self.prev.get(PREV_CLOSE_BAR)}")

    def today_bars(self, now):
        d = now.date().isoformat()
        return self.minute_bars("NIFTY", "NSE_INDEX", d, d).get(d, {})

    def contract(self, right, reference, today):
        r = self.c.expiry(symbol="NIFTY", exchange="NFO", instrumenttype="options")
        if r.get("status") != "success":
            raise RuntimeError(r.get("message", "expiry failed"))
        expiry, rolled = choose_expiry([d for d in (parse_expiry(x) for x in r.get("data", [])) if d], today)
        if not expiry:
            return None, "no listed NIFTY expiry"
        ch = self.c.optionchain(underlying="NIFTY", exchange="NSE_INDEX", expiry_date=expiry.strftime("%d%b%y").upper(), strike_count=40)
        if ch.get("status") != "success":
            raise RuntimeError(ch.get("message", "optionchain failed"))
        legs = {float(it["strike"]): it.get(right.lower()) for it in ch.get("chain", []) if it.get(right.lower())}
        step = strike_step(list(legs), reference)
        if not step:
            return None, f"no listed {right} strikes near {reference}"
        k = itm_strike(reference, right, step)
        leg = legs.get(k)
        if not leg or not leg.get("symbol"):
            return None, f"{right} {k} ({expiry}) not listed"
        return {"symbol": leg["symbol"], "strike": k, "expiry": expiry.isoformat(), "rolled": rolled, "lotsize": int(leg.get("lotsize") or 0)}, None

    def quote(self, symbol):
        r = self.c.quotes(symbol=symbol, exchange="NFO")
        if r.get("status") != "success":
            return None
        d = r.get("data", {})
        return {k: float(d.get(k) or 0) for k in ("bid", "ask", "ltp", "volume")}

    def order(self, symbol, action, qty):
        r = self.c.placeorder(strategy=STRATEGY, symbol=symbol, action=action, exchange="NFO", price_type="MARKET", product="MIS", quantity=str(qty))
        if r.get("status") != "success" or not r.get("orderid"):
            raise RuntimeError(r.get("message", f"placeorder failed: {r}"))
        return str(r["orderid"])

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
        return fallback, "assumed"

    # ---- entry ----
    def try_entry(self, sig, now, analyzer):
        if self.state["position"] or self.state["trade"]:
            return
        label = now.hour * 60 + now.minute
        if label > sig["bar"] + 1:
            skips = self.state["entry_skips"]
            return self.finish("entry_rejected", f"no executable entry in {hhmm(sig['bar'] + 1)}" + (f" ({skips})" if skips else ""))
        if not analyzer:
            self.state["entry_skips"]["analyzer_off"] = self.state["entry_skips"].get("analyzer_off", 0) + 1
            return
        inst = self.state.get("instrument")
        if not inst:
            inst, why = self.contract(sig["right"], sig["close"], now.date())
            if not inst:
                return self.finish("contract_missing", why)
            if not inst["lotsize"]:
                return self.finish("contract_missing", f"{inst['symbol']} has no lot size")
            self.state["instrument"] = inst
            self.save()
            log(f"contract {inst['symbol']} (strike {inst['strike']}, expiry {inst['expiry']}{', rolled' if inst['rolled'] else ''})")
        q = self.quote(inst["symbol"])
        skips = self.state["entry_skips"]
        if not q or not (q["bid"] > 0 and q["ask"] > 0 and q["ask"] >= q["bid"]):
            skips["no_two_sided_quote"] = skips.get("no_two_sided_quote", 0) + 1
            return
        mid = (q["bid"] + q["ask"]) / 2
        if (q["ask"] - q["bid"]) / mid * 100 > MAX_SPREAD_PCT:
            skips["spread_too_wide"] = skips.get("spread_too_wide", 0) + 1
            return
        if q["volume"] < MIN_VOLUME:
            skips["low_volume"] = skips.get("low_volume", 0) + 1
            return
        qty = inst["lotsize"] * LOTS
        est = r2(q["ask"] * (1 + SLIPPAGE))
        outlay = est * qty + buy_fees(est, qty)
        if outlay > MAX_OUTLAY:
            return self.finish("budget", f"one lot costs Rs {outlay:,.0f} incl. fees > Rs {MAX_OUTLAY:,.0f} max outlay")
        if outlay + sell_fees(0, qty) > MAX_LOSS:
            return self.finish("max_loss", f"theoretical loss Rs {outlay + sell_fees(0, qty):,.0f} > Rs {MAX_LOSS:,.0f}")
        oid = self.order(inst["symbol"], "BUY", qty)
        price, st = self.fill_price(oid, q["ask"])
        if price is None:
            return self.finish("entry_rejected", f"entry order {st}")
        self.state["position"] = {"symbol": inst["symbol"], "qty": qty, "entry": r2(price), "entry_label": label, "entry_at": now.isoformat(),
                                  "bot": sig["bot"], "right": sig["right"], "highest": None, "trail": False, "entry_fees": buy_fees(price, qty),
                                  "processed": label - 1, "entry_order": oid}
        self.save()
        log(f"BOUGHT {qty} {inst['symbol']} @ {r2(price)} ({sig['bot']} {sig['right']}). "
            f"Fixed stop {r2(price * FIXED_STOP)}; trail arms above {r2(price * TRAIL_ON)}")

    # ---- position ----
    def manage(self, now, analyzer):
        pos = self.state["position"]
        label = now.hour * 60 + now.minute
        reason = None
        if label >= TIME_EXIT:
            reason = "TIME_EXIT"
        elif self.last_opt_label != label - 1:
            d = now.date().isoformat()
            bars = self.minute_bars(pos["symbol"], "NFO", d, d).get(d, {})
            self.last_opt_label = label - 1
            for l in range(pos["processed"] + 1, label):
                b = bars.get(l)
                pos["processed"] = l
                if not b or b.get("v", 1) == 0:
                    continue  # NO_PRINT: no stop decision
                reason = stop_check(pos, b["c"])
                if reason:
                    log(f"{reason}: premium close {b['c']} at {hhmm(l)} (entry {pos['entry']}, highest {pos['highest']})")
                    break
            self.save()
        if not reason and not pos.get("exit_reason"):
            return
        pos["exit_reason"] = pos.get("exit_reason") or reason
        if not analyzer:
            if self.last_status != "exit_blocked":
                log(f"EXIT {pos['exit_reason']} due but Analyzer mode is OFF — NOT sending (it would be a real order). Retrying.")
                self.last_status = "exit_blocked"
            self.save()
            return
        q = self.quote(pos["symbol"])
        try:
            oid = self.order(pos["symbol"], "SELL", pos["qty"])
        except Exception as e:
            log(f"exit order failed ({e}) — retrying")
            return
        price, st = self.fill_price(oid, q["bid"] if q and q["bid"] > 0 else (q["ltp"] if q else pos["entry"]))
        if price is None:
            log(f"exit {st} — retrying")
            return
        gross = r2((price - pos["entry"]) * pos["qty"])
        costs = r2(pos["entry_fees"] + sell_fees(price, pos["qty"]))
        self.state["trade"] = {**pos, "exit": r2(price), "exit_at": now.isoformat(), "exit_order": oid, "gross": gross, "costs": costs, "net": r2(gross - costs)}
        self.state["position"] = None
        self.save()
        log(f"SOLD {pos['symbol']} {pos['exit_reason']}: {pos['entry']} -> {r2(price)}, gross {gross:+.2f}, costs {costs}, net {gross - costs:+.2f}")
        self.finish("traded", f"{pos['bot']} {pos['right']} net {gross - costs:+.2f}")

    # ---- main loop ----
    def step(self):
        now = self.now()
        today = now.date().isoformat()
        if today != self.date:
            self.load_day(today)
        analyzer = self.analyzer_on()
        if analyzer is False and not self.analyzer_warned:
            log("Analyzer mode is OFF — this strategy sends no orders until it is turned on.")
            self.analyzer_warned = True
        if analyzer:
            self.analyzer_warned = False
        label = now.hour * 60 + now.minute
        if label < OR_FIRST or label > 15 * 60 + 30:
            return label
        if self.state["position"]:
            self.manage(now, analyzer)
            return label
        if self.state["done"]:
            return label
        if self.prev is None:
            self.load_prev(now)
        last_done = label - 1 if now.second >= 2 else label - 2  # small grace for the candle to be published
        if self.state["signal"]:
            self.try_entry(self.state["signal"], now, analyzer)
            return label
        if last_done == self.last_eval_label:
            return label
        self.last_eval_label = last_done
        ev = evaluate(self.prev, self.today_bars(now), last_done)
        status = f"{ev['state']} {ev['reason'] or ''}"
        if status != self.last_status:
            g, o = ev["gap"], ev["or"]
            extra = (f" | gap {g['direction']} {g['points']:+.2f} ({g['pct']:.3f}%)" if g else "") + \
                    (f" | OR {o['low']:.2f}-{o['high']:.2f} w {o['width']:.2f} bands {o['down']:.2f}/{o['up']:.2f}" if o else "")
            log(f"{ev['state']}: {ev['detail']}{extra}")
            self.last_status = status
        if ev["state"] in ("NO_TRADE", "DATA_ERROR"):
            return self.finish(ev["reason"], ev["detail"]) or label
        if ev["state"] == "SIGNAL":
            sig = ev["signal"]
            if sig["bar"] != last_done or label > sig["bar"] + 1:
                return self.finish("missed_signal", f"{sig['bot']} {sig['right']} signal at {hhmm(sig['bar'])} was before this strategy saw it — not taken") or label
            self.state["signal"] = sig
            self.save()
            log(f"SIGNAL {sig['bot']} {sig['right']} at {hhmm(sig['bar'])} close {sig['close']}")
            self.try_entry(sig, now, analyzer)
        return label

    def run(self):
        log(f"ThetaLab NIFTY ASCENT started — V1.0+OR{int(MIN_OR_WIDTH)}+ROLL{ROLL_DAYS}, {LOTS} lot, max outlay {MAX_OUTLAY:,.0f}. Orders only in Analyzer mode.")
        while True:
            try:
                self.step()
            except Exception as e:
                log(f"loop error: {e}")
            self.sleep(POLL_SEC)


if __name__ == "__main__":
    from openalgo import api

    key = os.getenv("OPENALGO_API_KEY")
    if not key:
        sys.exit("OPENALGO_API_KEY is not set (run this inside OpenAlgo's Python Strategy Host)")
    client = api(api_key=key, host=os.getenv("OPENALGO_HOST", "http://127.0.0.1:5000"))
    NiftyAscent(client, os.path.dirname(os.path.abspath(__file__))).run()
