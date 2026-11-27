"""Behaviour tests for naked_sell.py with a fake OpenAlgo client. Run: python3 -m unittest test_naked_sell"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import naked_sell as ns  # noqa: E402

IST = ns.IST


class FakeClient:
    """Index rising all day (BULLISH after 11:00), option chain priced around spot, sandbox fills at the quote."""

    def __init__(self, clock):
        self.clock = clock
        self.analyze = True
        self.orders = []
        self.premium = {}  # tradingsymbol -> current premium override
        self.trend_up = True

    def analyzerstatus(self):
        return {"status": "success", "data": {"analyze_mode": self.analyze}}

    def history(self, symbol, exchange, interval, start_date, end_date):
        day = datetime.fromisoformat(start_date).replace(tzinfo=IST)
        idx, rows = [], []
        p = 26000.0
        for i in range(75):
            t = day + timedelta(hours=9, minutes=15 + 5 * i)
            o = p
            p += 4 if self.trend_up else -4
            idx.append(pd.Timestamp(t))
            rows.append({"open": o, "high": max(o, p) + 2, "low": min(o, p) - 2, "close": p, "volume": 0})
        return pd.DataFrame(rows, index=pd.DatetimeIndex(idx))

    def expiry(self, symbol, exchange, instrumenttype):
        return {"status": "success", "data": ["02-DEC-26", "09-DEC-26", "26-NOV-26"]}

    def spot(self):
        return 26000 + 4 * ((self.clock().hour * 60 + self.clock().minute - 555) / 5)

    def base(self, strike, right, spot):
        intrinsic = max(0, spot - strike) if right == "CE" else max(0, strike - spot)
        return max(0.5, 200 * pow(2.718, -abs(strike - spot) / 300) + intrinsic)

    def optionchain(self, underlying, exchange, expiry_date, strike_count):
        spot = self.spot()
        chain = []
        for k in range(int(spot // 50) * 50 - 1000, int(spot // 50) * 50 + 1050, 50):
            item = {"strike": k}
            for right in ("ce", "pe"):
                b = self.base(k, right.upper(), spot)
                item[right] = {"symbol": f"{underlying}02DEC26{k}{right.upper()}", "bid": round(b * 0.99, 2), "ask": round(b * 1.01, 2),
                               "ltp": round(b, 2), "volume": 5000, "lotsize": 65 if underlying == "NIFTY" else 20}
            chain.append(item)
        return {"status": "success", "underlying_ltp": spot, "chain": chain}

    def quotes(self, symbol, exchange):
        p = self.premium.get(symbol)
        if p is None:
            k = int("".join(ch for ch in symbol[-7:-2] if ch.isdigit()))
            p = self.base(k, symbol[-2:], self.spot())
        return {"status": "success", "data": {"bid": round(p * 0.99, 2), "ask": round(p * 1.01, 2), "ltp": p}}

    def placeorder(self, **kw):
        if not self.analyze:
            raise AssertionError("order sent while Analyzer is OFF")
        self.orders.append(kw)
        return {"status": "success", "orderid": str(len(self.orders))}

    def orderstatus(self, order_id, strategy):
        o = self.orders[int(order_id) - 1]
        q = self.quotes(o["symbol"], o["exchange"])["data"]
        return {"status": "success", "data": {"order_status": "complete", "average_price": q["bid"] if o["action"] == "SELL" else q["ask"]}}


class NakedSellTest(unittest.TestCase):
    def setUp(self):
        self.t = datetime(2026, 11, 27, 11, 5, 10, tzinfo=IST)
        self.dir = tempfile.mkdtemp()
        self.fc = FakeClient(lambda: self.t)
        self.s = self.make()
        ns.SYMBOLS[:] = ["NIFTY"]

    def make(self):
        s = ns.NakedSell(self.fc, self.dir, now_fn=lambda: self.t, sleep_fn=lambda _s: None)
        return s

    def tick(self, minutes=0, seconds=0, scan=True):
        self.t += timedelta(minutes=minutes, seconds=seconds)
        if scan:
            self.s.last_scan = 0
        self.s.step()

    def test_bullish_sells_a_pe_with_levels_from_the_fill(self):
        self.tick()
        self.assertEqual(len(self.fc.orders), 1)
        o = self.fc.orders[0]
        self.assertEqual((o["action"], o["price_type"], o["product"], o["exchange"]), ("SELL", "MARKET", "MIS", "NFO"))
        self.assertTrue(o["symbol"].endswith("PE"))
        self.assertEqual(o["quantity"], str(65 * ns.LOTS))
        pos = self.s.state["open"]["NIFTY"]
        self.assertAlmostEqual(pos["sl"], round(pos["entry"] * 1.4, 2))
        self.assertAlmostEqual(pos["tp"], round(pos["entry"] * 0.6, 2))
        self.assertLess(abs(pos["delta"] - 0.3), 0.08)

    def test_analyzer_off_sends_nothing_not_even_an_exit(self):
        self.fc.analyze = False
        self.tick()
        self.assertEqual(self.fc.orders, [])
        self.fc.analyze = True
        self.tick(minutes=1)
        sym = self.s.state["open"]["NIFTY"]["tradingsymbol"]
        self.fc.analyze = False
        self.fc.premium[sym] = 500
        for _ in range(3):
            self.tick(seconds=3, scan=False)
        self.assertEqual(len(self.fc.orders), 1, "no exit while Analyzer is OFF")
        self.assertIn("NIFTY", self.s.state["open"])
        self.fc.analyze = True
        self.tick(seconds=3, scan=False)
        self.assertEqual(self.fc.orders[-1]["action"], "BUY")
        self.assertEqual(self.s.state["trades"][-1]["reason"], "SL")

    def test_sl_needs_two_checks_then_buys_back_and_books_net(self):
        self.tick()
        pos = self.s.state["open"]["NIFTY"]
        self.fc.premium[pos["tradingsymbol"]] = pos["sl"] * 1.05
        self.tick(seconds=3, scan=False)
        self.assertEqual(len(self.fc.orders), 1, "first SL check only arms")
        self.tick(seconds=3, scan=False)
        self.assertEqual(len(self.fc.orders), 2)
        tr = self.s.state["trades"][0]
        self.assertEqual(tr["reason"], "SL")
        self.assertLess(tr["net"], 0)
        self.assertAlmostEqual(tr["net"], round(tr["gross"] - tr["charges"], 2))

    def test_tp_trend_flip_and_square_off(self):
        self.tick()
        pos = self.s.state["open"]["NIFTY"]
        self.fc.premium[pos["tradingsymbol"]] = pos["tp"] * 0.9
        self.tick(seconds=3, scan=False)
        self.tick(seconds=3, scan=False)
        self.assertEqual(self.s.state["trades"][-1]["reason"], "TP")
        # cooldown: no re-entry for 15 minutes
        self.tick(minutes=10)
        self.assertEqual(len(self.fc.orders), 2)
        self.tick(minutes=6)
        self.assertEqual(len(self.fc.orders), 3, "re-entry after the cooldown")
        # trend flips bearish -> exit
        self.fc.trend_up = False
        self.tick(minutes=1)
        self.assertEqual(self.s.state["trades"][-1]["reason"], "TREND_FLIP")
        # square-off
        self.fc.trend_up = True
        self.s.state["trades"].clear()
        self.t = self.t.replace(hour=14, minute=20)
        self.tick()
        self.assertIn("NIFTY", self.s.state["open"])
        self.t = self.t.replace(hour=15, minute=25)
        self.tick(scan=False)
        self.assertEqual(self.s.state["trades"][-1]["reason"], "SQUARE_OFF")

    def test_entry_window_expiry_day_and_daily_caps(self):
        self.t = self.t.replace(hour=10, minute=50)
        self.tick()
        self.assertEqual(self.fc.orders, [], "not enough completed bars / before 11:00")
        self.t = datetime(2026, 12, 2, 11, 5, 10, tzinfo=IST)
        self.s = self.make()
        self.tick()
        self.assertEqual(self.fc.orders, [], "own expiry day")
        self.t = datetime(2026, 11, 27, 11, 5, 10, tzinfo=IST)
        self.s = self.make()
        self.s.load_day("2026-11-27")
        self.s.state["trades"] = [{"symbol": "NIFTY", "net": -10001, "exit_at": 0}]
        self.tick()
        self.assertEqual(self.fc.orders, [], "daily loss limit")
        self.s.state["trades"] = [{"symbol": "SENSEX", "net": -10001, "exit_at": 0}]
        self.tick()
        self.assertEqual(len(self.fc.orders), 1, "limits are per index")

    def test_restart_resumes_the_open_position_and_never_re_enters(self):
        self.tick()
        self.assertEqual(len(self.fc.orders), 1)
        self.s = self.make()
        self.tick(seconds=5)
        self.assertEqual(len(self.fc.orders), 1, "no second entry after restart")
        self.assertIn("NIFTY", self.s.state["open"])
        pos = self.s.state["open"]["NIFTY"]
        self.fc.premium[pos["tradingsymbol"]] = pos["sl"] * 1.1
        self.tick(seconds=3, scan=False)
        self.tick(seconds=3, scan=False)
        self.assertEqual(self.s.state["trades"][-1]["reason"], "SL")

    def test_expiry_parsing(self):
        self.assertEqual(str(ns.parse_expiry("02-DEC-26")), "2026-12-02")
        self.assertEqual(str(ns.parse_expiry("02DEC26")), "2026-12-02")


if __name__ == "__main__":
    unittest.main()
