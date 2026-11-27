"""Behaviour tests for nifty_ascent.py with a fake OpenAlgo client. Run: python3 -m unittest test_nifty_ascent"""
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nifty_ascent as na  # noqa: E402

IST = na.IST
D = date(2026, 11, 26)  # a Thursday; nearest expiry Tue 1 Dec (5 days, no roll)


def index_path(label):
    """Gap up 25,100 -> 25,200; OR closes 25,150-25,230 (width 80); breakout above 25,238 at 10:00."""
    if label < 9 * 60 + 20:
        return 25200.0
    if label < 9 * 60 + 30:
        return 25230.0
    if label < 9 * 60 + 40:
        return 25150.0
    if label < 10 * 60:
        return 25190.0
    return 25260.0


class FakeClient:
    def __init__(self, clock):
        self.clock = clock
        self.analyze = True
        self.orders = []
        self.premium = lambda label: 180.0  # option 1-minute closes by minute
        self.no_print = set()
        self.spread = 0.5
        self.volume = 50_000
        self.expiries = ["01-DEC-26", "08-DEC-26"]

    def analyzerstatus(self):
        return {"status": "success", "data": {"analyze_mode": self.analyze}}

    def _frame(self, day, labels, price):
        idx, rows = [], []
        for l in labels:
            t = datetime(day.year, day.month, day.day, l // 60, l % 60, tzinfo=IST)
            c = price(l)
            prev = price(l - 1) if l > 555 else c
            idx.append(pd.Timestamp(t))
            rows.append({"open": prev, "high": max(prev, c) + 1, "low": min(prev, c) - 1, "close": c, "volume": 0 if l in self.no_print else 100})
        return pd.DataFrame(rows, index=pd.DatetimeIndex(idx))

    def history(self, symbol, exchange, interval, start_date, end_date):
        now = self.clock()
        done = now.hour * 60 + now.minute - 1
        if symbol == "NIFTY":
            if start_date != end_date:  # previous session
                prev = date(2026, 11, 25)
                return self._frame(prev, range(555, 930), lambda l: 25100.0 if l == 915 else 25120.0 + (60 if l == 700 else 0) - (60 if l == 800 else 0))
            return self._frame(D, range(555, min(done, 929) + 1), index_path)
        return self._frame(D, range(555, min(done, 929) + 1), self.premium)

    def expiry(self, symbol, exchange, instrumenttype):
        return {"status": "success", "data": self.expiries}

    def optionchain(self, underlying, exchange, expiry_date, strike_count):
        chain = [{"strike": k, "ce": {"symbol": f"NIFTY{expiry_date}{k}CE", "lotsize": 65}, "pe": {"symbol": f"NIFTY{expiry_date}{k}PE", "lotsize": 65}}
                 for k in range(24000, 26500, 50)]
        return {"status": "success", "underlying_ltp": 25260, "chain": chain}

    def quotes(self, symbol, exchange):
        now = self.clock()
        p = self.premium(now.hour * 60 + now.minute)
        return {"status": "success", "data": {"bid": p - self.spread, "ask": p + self.spread, "ltp": p, "volume": self.volume}}

    def placeorder(self, **kw):
        if not self.analyze:
            raise AssertionError("order sent while Analyzer is OFF")
        self.orders.append(kw)
        return {"status": "success", "orderid": str(len(self.orders))}

    def orderstatus(self, order_id, strategy):
        o = self.orders[int(order_id) - 1]
        q = self.quotes(o["symbol"], "NFO")["data"]
        return {"status": "success", "data": {"order_status": "complete", "average_price": q["ask"] if o["action"] == "BUY" else q["bid"]}}


class AscentTest(unittest.TestCase):
    def setUp(self):
        self.t = datetime(D.year, D.month, D.day, 9, 10, 0, tzinfo=IST)
        self.dir = tempfile.mkdtemp()
        self.fc = FakeClient(lambda: self.t)
        self.s = self.make()

    def make(self):
        return na.NiftyAscent(self.fc, self.dir, now_fn=lambda: self.t, sleep_fn=lambda _s: None)

    def run_until(self, hh, mm, ss=5):
        end = self.t.replace(hour=hh, minute=mm, second=ss)
        while self.t < end:
            self.t = min(self.t + timedelta(seconds=20), end)
            self.s.step()

    def test_gap_and_go_buys_the_150_itm_ce_in_the_next_minute(self):
        self.run_until(10, 1, 5)
        self.assertEqual(len(self.fc.orders), 1)
        o = self.fc.orders[0]
        self.assertEqual((o["action"], o["exchange"], o["product"], o["quantity"]), ("BUY", "NFO", "MIS", "65"))
        self.assertEqual(o["symbol"], "NIFTY01DEC2625100CE", "25,260 - 150 = 25,110 -> 25,100 (step 50)")
        self.assertEqual(self.s.state["signal"]["bot"], "GAP_AND_GO")
        self.assertEqual(self.s.state["signal"]["bar"], 10 * 60)

    def test_time_exit_at_1515_with_net_pnl(self):
        self.run_until(15, 15, 10)
        self.assertEqual([o["action"] for o in self.fc.orders], ["BUY", "SELL"])
        tr = self.s.state["trade"]
        self.assertEqual(tr["exit_reason"], "TIME_EXIT")
        self.assertAlmostEqual(tr["net"], round(tr["gross"] - tr["costs"], 2))
        self.assertEqual(self.s.state["done"]["reason"], "traded")
        self.run_until(15, 25)
        self.assertEqual(len(self.fc.orders), 2, "one position per day")

    def test_fixed_stop_on_a_70pct_close_and_no_print_minutes_decide_nothing(self):
        self.fc.premium = lambda l: 180.0 if l < 10 * 60 + 20 else 120.0
        self.fc.no_print = {10 * 60 + 20, 10 * 60 + 21}
        self.run_until(10, 22, 30)
        self.assertEqual(len(self.fc.orders), 1, "no-print minutes make no stop decision")
        self.run_until(10, 23, 30)
        self.assertEqual(self.fc.orders[-1]["action"], "SELL")
        self.assertEqual(self.s.state["trade"]["exit_reason"], "FIXED_STOP")

    def test_trailing_stop_arms_above_105pct_and_exits_at_80pct_of_the_high(self):
        def prem(l):
            if l < 10 * 60 + 10:
                return 180.0
            if l < 10 * 60 + 30:
                return 260.0
            return 205.0  # <= 80% of 260 (208) but above 70% of entry
        self.fc.premium = prem
        self.run_until(10, 31, 30)
        self.assertEqual(self.s.state["trade"]["exit_reason"], "TRAILING_STOP")
        self.assertTrue(self.s.state["trade"]["trail"])

    def test_analyzer_off_sends_nothing_then_the_missed_entry_minute_ends_the_day(self):
        self.fc.analyze = False
        self.run_until(10, 2, 30)
        self.assertEqual(self.fc.orders, [])
        self.assertEqual(self.s.state["done"]["reason"], "entry_rejected")

    def test_illiquid_or_over_budget_entry_is_rejected_not_forced(self):
        self.fc.spread = 5.0
        self.run_until(10, 2, 30)
        self.assertEqual(self.fc.orders, [])
        self.assertIn("spread_too_wide", self.s.state["done"]["detail"])
        self.t = self.t.replace(hour=9, minute=10)
        self.dir = tempfile.mkdtemp()
        self.fc = FakeClient(lambda: self.t)
        self.fc.premium = lambda l: 320.0  # 65 x 320.8 > 20,000
        self.s = self.make()
        self.run_until(10, 1, 30)
        self.assertEqual(self.fc.orders, [])
        self.assertEqual(self.s.state["done"]["reason"], "budget")

    def test_late_start_never_takes_an_old_signal(self):
        self.t = self.t.replace(hour=10, minute=5)
        self.s.step()
        self.run_until(10, 6)
        self.assertEqual(self.fc.orders, [])
        self.assertEqual(self.s.state["done"]["reason"], "missed_signal")

    def test_restart_resumes_the_position_and_never_re_enters(self):
        self.run_until(10, 3)
        self.assertEqual(len(self.fc.orders), 1)
        self.s = self.make()
        self.run_until(10, 10)
        self.assertEqual(len(self.fc.orders), 1)
        self.assertIsNotNone(self.s.state["position"])
        self.run_until(15, 15, 10)
        self.assertEqual(self.fc.orders[-1]["action"], "SELL")

    def test_expiry_roll_and_strike_rounding(self):
        self.assertEqual(na.choose_expiry([date(2026, 12, 1), date(2026, 12, 8)], date(2026, 11, 30)), (date(2026, 12, 8), True))
        self.assertEqual(na.choose_expiry([date(2026, 12, 1), date(2026, 12, 8)], date(2026, 12, 1)), (date(2026, 12, 8), True))
        self.assertEqual(na.choose_expiry([date(2026, 12, 1), date(2026, 12, 8)], date(2026, 11, 26)), (date(2026, 12, 1), False))
        self.assertEqual(na.itm_strike(25275.0, "CE", 50.0), 25100.0, "exact tie -> deeper ITM (lower) for CE")
        self.assertEqual(na.itm_strike(25275.0, "PE", 50.0), 25450.0, "exact tie -> deeper ITM (higher) for PE")


if __name__ == "__main__":
    unittest.main()
