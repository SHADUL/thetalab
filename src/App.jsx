import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Warning } from "@phosphor-icons/react";
import { bs, impliedVol, greeks as bsGreeks, lotSize, ncdf } from "./lib/options";
import { inr, sgn, fm, fi, cx } from "./lib/format";
import { makeDemo } from "./lib/demo";
import { Reveal } from "./components/Motion";
import Landing from "./components/Landing";
import MarketHeader from "./components/MarketHeader";
import RiskSummary from "./components/RiskSummary";
import PayoffChart from "./components/PayoffChart";
import Positions from "./components/Positions";
import OptionChain from "./components/OptionChain";
import StrategyWizard from "./components/StrategyWizard";

const STORE = "nifty-sim-legs-v1";

export default function App() {
  const [bundle, setBundle] = useState(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expiry, setExpiry] = useState(null);
  const [dayIdx, setDayIdx] = useState(0);
  const [legs, setLegs] = useState([]);
  const [defaultLots, setDefaultLots] = useState(1);
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem("thetalab-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("thetalab-theme", theme);
  }, [theme]);

  /* If a bundle is deployed alongside the site, load it without asking. */
  useEffect(() => {
    fetch("/chain_bundle.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => load(b))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /* Legs survive a refresh, per expiry. */
  useEffect(() => {
    if (!expiry) return;
    try {
      const all = JSON.parse(localStorage.getItem(STORE) || "{}");
      setLegs(all[expiry] || []);
    } catch { setLegs([]); }
  }, [expiry]);
  useEffect(() => {
    if (!expiry) return;
    try {
      const all = JSON.parse(localStorage.getItem(STORE) || "{}");
      all[expiry] = legs;
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch { /* private mode — not worth interrupting for */ }
  }, [legs, expiry]);

  /* NSE lists NIFTY options years ahead. Those far-dated contracts barely trade,
     so their chains are sparse and their implied vols meaningless — a 2031 expiry
     produced a 1-sigma of 10,000 points. Default to the most recent expiry that
     actually completed inside the data, and only offer those. */
  const usableExpiries = (b) => {
    const keys = Object.keys(b.expiries).sort();
    const lastData = keys.reduce((mx, k) => {
      const d = b.expiries[k].dates;
      const last = d[d.length - 1];
      return last > mx ? last : mx;
    }, "");
    const complete = keys.filter((k) => k <= lastData && b.expiries[k].dates.length >= 2);
    return complete.length ? complete : keys;
  };
  const load = (b, isDemo = false) => {
    const usable = usableExpiries(b);
    setBundle({ ...b, _usable: usable });
    setDemo(isDemo); setExpiry(usable[usable.length - 1]); setDayIdx(0);
  };
  const onFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { load(JSON.parse(r.result)); } catch (err) { alert("Could not read that file: " + err.message); } };
    r.readAsText(f);
  };

  const ex = bundle && expiry ? bundle.expiries[expiry] : null;
  const dates = ex?.dates ?? [];
  const today = dates[dayIdx] ?? null;
  const spot = today ? ex.spot[today] : null;
  const chain = today ? ex.chain[today] : {};
  const sessionsLeft = today ? dates.length - 1 - dayIdx : 0;
  const tYears = useMemo(() => {
    if (!today || !expiry) return 0;
    return Math.max((new Date(expiry) - new Date(today)) / 86400000, 0.35) / 365;
  }, [today, expiry]);

  const priceAt = (date, strike, right) => {
    const r = ex?.chain?.[date]?.[String(strike)];
    return r ? (right === "CE" ? r.c ?? null : r.p ?? null) : null;
  };
  const atm = spot && ex
    ? ex.strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), ex.strikes[0]) : null;

  const live = useMemo(() => {
    if (!today || !spot) return [];
    return legs.map((l) => {
      const closed = l.closedDate && today >= l.closedDate;
      const cur = closed ? l.closePrice : priceAt(today, l.strike, l.right);
      const q = l.lots * lotSize(l.entryDate);
      const isCall = l.right === "CE";
      const iv = cur != null && !closed ? impliedVol(cur, spot, l.strike, tYears, isCall) : null;
      const g = iv ? bsGreeks(spot, l.strike, tYears, iv, isCall) : { delta: 0, gamma: 0, theta: 0, vega: 0 };
      const pnl = cur == null ? null : (l.side === "SELL" ? l.entryPrice - cur : cur - l.entryPrice) * q;
      return { ...l, cur, q, dir: l.side === "SELL" ? -1 : 1, isCall, iv, g, pnl, closed,
        active: l.entryDate <= today && !closed };
    });
  }, [legs, today, spot, tYears]);

  const active = live.filter((l) => l.active);

  const held = useMemo(() => {
    const m = {};
    active.forEach((l) => {
      const k = `${l.strike}${l.right}`;
      const e = m[k] || (m[k] = { lots: 0, cost: 0, pnl: 0 });
      const s = l.side === "SELL" ? -1 : 1;
      e.lots += s * l.lots; e.cost += s * l.entryPrice * l.lots; e.pnl += l.pnl ?? 0;
    });
    Object.values(m).forEach((e) => { e.avg = e.lots ? Math.abs(e.cost / e.lots) : 0; });
    return m;
  }, [active]);

  const tot = useMemo(() => {
    let pnl = 0, credit = 0, delta = 0, gamma = 0, theta = 0, vega = 0;
    live.forEach((l) => {
      if (l.entryDate > today) return;
      if (l.pnl != null) pnl += l.pnl;
      credit += (l.side === "SELL" ? 1 : -1) * l.entryPrice * l.q;
      if (l.active) {
        delta += l.dir * l.g.delta * l.q; gamma += l.dir * l.g.gamma * l.q;
        theta += l.dir * l.g.theta * l.q; vega += l.dir * l.g.vega * l.q;
      }
    });
    return { pnl, credit, delta, gamma, theta, vega };
  }, [live, today]);

  const atmIV = useMemo(() => {
    if (!spot || !atm || !chain[String(atm)]) return null;
    const { c, p } = chain[String(atm)];
    const vs = [c != null && impliedVol(c, spot, atm, tYears, true),
                p != null && impliedVol(p, spot, atm, tYears, false)].filter(Boolean);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  }, [spot, atm, chain, tYears]);
  const sigma = atmIV && spot ? spot * atmIV * Math.sqrt(tYears) : null;

  const payoff = useMemo(() => {
    if (!spot || !active.length) return [];
    const span = Math.max(sigma ? sigma * 2.6 : spot * 0.06, spot * 0.045);
    const lo = spot - span, hi = spot + span, N = 121, out = [];
    for (let i = 0; i < N; i++) {
      const S = lo + (hi - lo) * i / (N - 1);
      let exp = 0, now = 0;
      active.forEach((l) => {
        const intr = Math.max(l.isCall ? S - l.strike : l.strike - S, 0);
        const th = l.iv ? bs(S, l.strike, tYears, l.iv, l.isCall) : intr;
        const m = l.side === "SELL" ? -1 : 1;
        exp += m * (intr - l.entryPrice) * l.q;
        now += m * (th - l.entryPrice) * l.q;
      });
      out.push({ S: Math.round(S), exp: Math.round(exp), now: Math.round(now),
        pos: exp > 0 ? exp : 0, neg: exp < 0 ? exp : 0 });
    }
    return out;
  }, [active, spot, sigma, tYears]);

  const stats = useMemo(() => {
    if (!payoff.length) return null;
    const exp = payoff.map((p) => p.exp);
    const maxP = Math.max(...exp), maxL = Math.min(...exp), bes = [];
    for (let i = 1; i < payoff.length; i++) {
      const a = payoff[i - 1], b = payoff[i];
      if ((a.exp <= 0 && b.exp > 0) || (a.exp >= 0 && b.exp < 0)) {
        const t = Math.abs(a.exp) / (Math.abs(a.exp) + Math.abs(b.exp) || 1);
        bes.push(Math.round(a.S + (b.S - a.S) * t));
      }
    }
    let pop = null;
    if (atmIV && spot) {
      const sd = atmIV * Math.sqrt(tYears);
      const z = (S) => (Math.log(S / spot) + 0.5 * sd * sd) / sd;
      let mass = 0;
      for (let i = 1; i < payoff.length; i++)
        if (payoff[i].exp > 0) mass += Math.max(ncdf(z(payoff[i].S)) - ncdf(z(payoff[i - 1].S)), 0);
      pop = mass * 100;
    }
    const shortN = active.filter((l) => l.side === "SELL").reduce((s, l) => s + l.strike * l.q, 0);
    const longN = active.filter((l) => l.side === "BUY").reduce((s, l) => s + l.strike * l.q, 0);
    return { maxP, maxL, bes, pop, margin: Math.max(shortN * 0.12 - longN * 0.06, 0),
      rr: maxL ? Math.abs(maxP / maxL) : null };
  }, [payoff, atmIV, spot, tYears, active]);

  const addLeg = (strike, right, side) => {
    const p = priceAt(today, strike, right); if (p == null) return;
    setLegs((L) => [...L, { id: Date.now() + Math.random(), side, right, strike,
      lots: Number(defaultLots) || 1, entryDate: today, entryPrice: p, closedDate: null, closePrice: null }]);
  };
  const setLots = (id, n) => setLegs((L) => L.map((l) =>
    l.id === id && !l.closedDate ? { ...l, lots: Math.max(1, Math.min(999, n)) } : l));
  const exitLeg = (id) => setLegs((L) => L.map((l) =>
    l.id === id && !l.closedDate ? { ...l, closedDate: today, closePrice: priceAt(today, l.strike, l.right) } : l));
  const removeLeg = (id) => setLegs((L) => L.filter((l) => l.id !== id));
  const loadStrategy = (strategyLegs) => {
    setLegs(strategyLegs.map((l, i) => ({
      id: Date.now() + i, side: l.side, right: l.right, strike: l.strike, lots: l.lots,
      entryDate: today, entryPrice: l.price, closedDate: null, closePrice: null,
    })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (!bundle) return <Landing onFile={onFile} onDemo={() => load(makeDemo(), true)} loading={loading} />;

  const strikes = ex.strikes.filter((s) => spot && Math.abs(s - spot) <= (sigma ? sigma * 3 : 800));
  const netEntry = active.length ? active.reduce((a, l) => a + (l.side === "SELL" ? 1 : -1) * l.entryPrice, 0) : null;
  const netNow = active.reduce((a, l) => a + (l.side === "SELL" ? 1 : -1) * (l.cur ?? 0), 0);

  return (
    <div className="min-h-screen px-3 py-3 sm:px-5 sm:py-5 max-w-[1600px] mx-auto">
      <AnimatePresence>
        {demo && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="panel mb-3 px-4 py-2.5 flex items-center gap-2.5 !border-loss/30"
            style={{ background: "var(--c-loss-soft)" }}>
            <Warning size={15} weight="regular" className="text-loss shrink-0" />
            <span className="text-[12.5px] text-loss">
              <b>Sample data.</b> These premiums come from a model, not from NSE.
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <Reveal>
        <MarketHeader expiries={bundle._usable ?? Object.keys(bundle.expiries).sort()}
          expiry={expiry} setExpiry={(v) => { setExpiry(v); setDayIdx(0); }}
          dates={dates} dayIdx={dayIdx} setDayIdx={setDayIdx} spot={spot}
          prevSpot={dayIdx > 0 ? ex.spot[dates[dayIdx - 1]] : null} sessionsLeft={sessionsLeft}
          atmIV={atmIV} sigma={sigma} lot={lotSize(today ?? "2026-01-01")}
          theme={theme} toggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} />
      </Reveal>

      <div className="workspace mt-3">
        <Reveal className="area-chain" delay={0.04}>
          <OptionChain strikes={strikes} chain={chain} atm={atm} held={held} onAdd={addLeg}
            lots={Number(defaultLots) || 1} netEntry={netEntry} netNow={netNow} />
        </Reveal>

        <Reveal className="area-risk" delay={0.06}>
          <RiskSummary pnl={tot.pnl} hasPosition={active.length > 0 || live.some((l) => l.closed)}
            maxProfit={stats?.maxP} maxLoss={stats?.maxL} netCredit={tot.credit}
            breakevens={stats?.bes} rr={stats?.rr} pop={stats?.pop} margin={stats?.margin} />
        </Reveal>

        <Reveal className="area-wizard" delay={0.08}>
          <StrategyWizard chain={chain} strikes={ex.strikes} spot={spot} sigma={sigma} tYears={tYears}
            dates={dates} dayIdx={dayIdx} expiry={expiry} lotQty={lotSize(today ?? "2026-01-01")}
            defaultLots={defaultLots} onLoad={loadStrategy} />
        </Reveal>

        <Reveal className="area-payoff" delay={0.1}>
          <PayoffChart data={payoff} spot={spot} sigma={sigma} breakevens={stats?.bes ?? []}
            legs={active} greeks={tot} hasLegs={active.length > 0} theme={theme} />
        </Reveal>

        <Reveal className="area-positions" delay={0.12}>
          <Positions legs={live} today={today} defaultLots={defaultLots} setDefaultLots={setDefaultLots}
            setLots={setLots} exit={exitLeg} remove={removeLeg} clear={() => setLegs([])} />
        </Reveal>
      </div>

      <p className="text-[11px] text-muted leading-[1.8] mt-6 mb-2 max-w-[92ch]">
        End-of-day prices. Implied volatility is solved from each observed premium, and the “today” curve
        holds that volatility constant as spot moves — real IV shifts with price, so treat the dashed line
        as a guide rather than a forecast. Probability of profit is a lognormal estimate from ATM IV, not a
        historical frequency. Approximate margin is a rough 12% of short notional less 6% of long cover; it
        is not a SPAN calculation and should not be used for real sizing. P&amp;L excludes brokerage, STT and
        slippage.
      </p>
    </div>
  );
}
