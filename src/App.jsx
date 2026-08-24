import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Warning } from "@phosphor-icons/react";
import { impliedVol, greeks as bsGreeks, lotSize, ncdf } from "./lib/options";
import {
  atmStrike, oiTotals, oiProfile, maxPain as calcMaxPain, synthFuture, straddlePremium,
  atmImpliedVol, strikeRows, tagExpiries, rollingStraddle, mtmSeries, payoffCurve,
  pnlAt, breakevens,
} from "./lib/chain";
import { makeDemo } from "./lib/demo";
import Landing from "./components/Landing";
import TopBar from "./components/TopBar";
import MarketStrip from "./components/MarketStrip";
import ChainPanel from "./components/ChainPanel";
import AnalysisPanel from "./components/AnalysisPanel";
import PositionsPanel from "./components/PositionsPanel";
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
  const [multiplier, setMultiplier] = useState(1);
  const [autoRun, setAutoRun] = useState(false);
  const [basis, setBasis] = useState("spot");
  const [tab, setTab] = useState("payoff");
  const [chainHid, setChainHid] = useState(false);
  const [analysisHid, setAnalysisHid] = useState(false);
  const [ivShift, setIvShift] = useState(0);
  const [targetSpotRaw, setTargetSpot] = useState(null);
  const [targetDate, setTargetDate] = useState(null);
  const importRef = useRef(null);

  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem("thetalab-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("thetalab-theme", theme);
  }, [theme]);

  /* If a bundle ships alongside the site, load it without asking. */
  useEffect(() => {
    fetch("/chain_bundle.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => load(b))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /* NSE lists NIFTY options years ahead; those far-dated chains are sparse and
     any IV solved from them is meaningless. Offer only expiries that actually
     completed inside the data. */
  const usableExpiries = (b) => {
    const keys = Object.keys(b.expiries).sort();
    const lastData = keys.reduce((mx, k) => {
      const d = b.expiries[k].dates;
      return d[d.length - 1] > mx ? d[d.length - 1] : mx;
    }, "");
    const complete = keys.filter((k) => k <= lastData && b.expiries[k].dates.length >= 2);
    return complete.length ? complete : keys;
  };

  /* Which expiries were actually quoted on each session. The bundle is stored
     per expiry, but the chain reads the other way round: on any given day a desk
     sees the handful of expiries live at that moment. Indexing once on load
     keeps the expiry tab row from scanning 400 expiries on every render. */
  const indexByDate = (b, usable) => {
    const byDate = {};
    usable.forEach((e) => {
      b.expiries[e].dates.forEach((d) => { (byDate[d] ||= []).push(e); });
    });
    Object.values(byDate).forEach((list) => list.sort());
    return byDate;
  };

  const load = (b, isDemo = false) => {
    const usable = usableExpiries(b);
    setBundle({ ...b, _usable: usable, _byDate: indexByDate(b, usable) });
    setDemo(isDemo);
    setExpiry(usable[usable.length - 1]);
    setDayIdx(0);
  };
  const onFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { load(JSON.parse(r.result)); }
      catch (err) { alert("Could not read that file: " + err.message); }
    };
    r.readAsText(f);
  };

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

  /* ── session in view ───────────────────────────────────────────────── */
  const ex = bundle && expiry ? bundle.expiries[expiry] : null;
  const dates = useMemo(() => ex?.dates ?? [], [ex]);
  const today = dates[dayIdx] ?? null;
  const spot = today && ex ? ex.spot[today] : null;
  const ohlc = today && ex?.ohlc ? ex.ohlc[today] : null;
  const prevClose = dayIdx > 0 && ex ? ex.spot[dates[dayIdx - 1]] : null;
  const chain = useMemo(() => (today && ex ? ex.chain[today] ?? {} : {}), [ex, today]);
  const prevChain = useMemo(
    () => (dayIdx > 0 && ex ? ex.chain[dates[dayIdx - 1]] ?? null : null), [ex, dates, dayIdx]);
  const lotQty = lotSize(today ?? "2026-01-01");

  const tYears = useMemo(() => {
    if (!today || !expiry) return 0;
    return Math.max((new Date(expiry) - new Date(today)) / 86400000, 0) / 365;
  }, [today, expiry]);

  /* Target date defaults to expiry and is clamped into the remaining sessions
     whenever the session in view moves past it. */
  useEffect(() => {
    if (!dates.length) return;
    setTargetDate((t) => (t && t >= dates[dayIdx] && dates.includes(t) ? t : dates[dates.length - 1]));
  }, [dates, dayIdx]);
  const targetT = useMemo(() => {
    if (!targetDate || !expiry) return 0;
    return Math.max((new Date(expiry) - new Date(targetDate)) / 86400000, 0) / 365;
  }, [targetDate, expiry]);

  /* ── chain analytics ───────────────────────────────────────────────── */
  const synthFut = useMemo(() => synthFuture(chain, ex?.strikes, spot), [chain, ex, spot]);
  const reference = basis === "synth" && synthFut != null ? synthFut : spot;
  const atm = useMemo(() => atmStrike(ex?.strikes, reference), [ex, reference]);

  /* Every Black-Scholes solve runs against the forward the options are actually
     quoting, not the index level. `basisAdj` carries that difference into the
     payoff curve, which is charted on the index scale. */
  const fwd = synthFut ?? spot;
  const basisAdj = fwd != null && spot != null ? fwd - spot : 0;

  const atmIV = useMemo(() => atmImpliedVol(chain, atm, fwd, tYears), [chain, atm, fwd, tYears]);
  const sigma = atmIV && spot ? spot * atmIV * Math.sqrt(tYears) : null;
  const straddle = useMemo(() => straddlePremium(chain, atm), [chain, atm]);
  const oi = useMemo(() => oiTotals(chain, prevChain), [chain, prevChain]);
  const maxPain = useMemo(() => calcMaxPain(chain, ex?.strikes ?? []), [chain, ex]);
  /* The expiry tabs are the chains live on this session — not every expiry in
     eight years of data. The one in view is always included, even on a session
     where it happens to carry no quotes. */
  const liveExpiries = useMemo(() => {
    if (!bundle || !today) return expiry ? [expiry] : [];
    const on = (bundle._byDate?.[today] ?? []).filter((e) => e >= today);
    return on.includes(expiry) ? on : [...on, expiry].filter(Boolean).sort();
  }, [bundle, today, expiry]);

  const tags = useMemo(() => tagExpiries(liveExpiries, today), [liveExpiries, today]);

  const windowStrikes = useMemo(() => {
    if (!ex || !spot) return [];
    const span = sigma ? sigma * 3.2 : spot * 0.05;
    return ex.strikes.filter((s) => Math.abs(s - spot) <= span);
  }, [ex, spot, sigma]);

  const rows = useMemo(
    () => strikeRows(chain, windowStrikes, fwd, tYears), [chain, windowStrikes, fwd, tYears]);
  const oiRows = useMemo(
    () => oiProfile(chain, windowStrikes, prevChain), [chain, windowStrikes, prevChain]);
  const straddleSeries = useMemo(() => rollingStraddle(ex), [ex]);

  /* ── legs, marked to the session in view ───────────────────────────── */
  const priceAt = useCallback((date, strike, right) => {
    const r = ex?.chain?.[date]?.[String(strike)];
    return r ? (right === "CE" ? r.c ?? null : r.p ?? null) : null;
  }, [ex]);

  const live = useMemo(() => {
    if (!today || !spot) return [];
    return legs.map((l) => {
      const closed = l.closedDate && today >= l.closedDate;
      const cur = closed ? l.closePrice : priceAt(today, l.strike, l.right);
      const q = l.lots * multiplier * lotSize(l.entryDate);
      const isCall = l.right === "CE";
      const iv = cur != null && !closed && tYears > 0
        ? impliedVol(cur, fwd, l.strike, tYears, isCall) : null;
      const g = iv ? bsGreeks(fwd, l.strike, tYears, iv, isCall)
        : { delta: 0, gamma: 0, theta: 0, vega: 0 };
      const pnl = cur == null ? null
        : (l.side === "SELL" ? l.entryPrice - cur : cur - l.entryPrice) * q;
      return {
        ...l, expiry: l.expiry ?? expiry, cur, q, dir: l.side === "SELL" ? -1 : 1,
        isCall, iv, g, pnl, closed, active: l.entryDate <= today && !closed,
      };
    });
  }, [legs, today, spot, fwd, tYears, multiplier, priceAt, expiry]);

  /* Legs the payoff is actually built from: open, and not switched off. */
  const active = useMemo(() => live.filter((l) => l.active && !l.off), [live]);
  const hasLegs = active.length > 0;

  const held = useMemo(() => {
    const m = {};
    live.filter((l) => l.active).forEach((l) => {
      const k = `${l.strike}${l.right}`;
      const e = m[k] || (m[k] = { lots: 0, cost: 0 });
      const s = l.side === "SELL" ? -1 : 1;
      e.lots += s * l.lots * multiplier;
      e.cost += s * l.entryPrice * l.lots * multiplier;
    });
    Object.values(m).forEach((e) => { e.avg = e.lots ? Math.abs(e.cost / e.lots) : 0; });
    return m;
  }, [live, multiplier]);

  const totals = useMemo(() => {
    let pnl = 0, credit = 0, delta = 0, gamma = 0, theta = 0, vega = 0;
    live.forEach((l) => {
      if (l.entryDate > today || l.off) return;
      if (l.pnl != null) pnl += l.pnl;
      credit += (l.side === "SELL" ? 1 : -1) * l.entryPrice * l.q;
      if (l.active) {
        delta += l.dir * l.g.delta * l.q; gamma += l.dir * l.g.gamma * l.q;
        theta += l.dir * l.g.theta * l.q; vega += l.dir * l.g.vega * l.q;
      }
    });
    return { pnl, credit, delta, gamma, theta, vega };
  }, [live, today]);

  /* ── payoff and its summary ────────────────────────────────────────── */
  /* A null scenario spot means "wherever this session closed" — it only holds a
     value once the user has actually dragged it somewhere. Switching expiry
     drops back to tracking. */
  useEffect(() => { setTargetSpot(null); }, [expiry]);
  const targetSpot = targetSpotRaw ?? (spot != null ? Math.round(spot) : null);

  const payoff = useMemo(
    () => payoffCurve({ legs: active, spot, sigma, targetT, ivShift, basisAdj }),
    [active, spot, sigma, targetT, ivShift, basisAdj]);

  const stats = useMemo(() => {
    if (!payoff.length) return null;
    const exp = payoff.map((p) => p.exp);
    const maxP = Math.max(...exp), maxL = Math.min(...exp);
    const bes = breakevens(payoff);
    let pop = null;
    if (atmIV && spot && tYears > 0) {
      const sd = atmIV * Math.sqrt(tYears);
      const z = (S) => (Math.log(S / spot) + 0.5 * sd * sd) / sd;
      let mass = 0;
      for (let i = 1; i < payoff.length; i++)
        if (payoff[i].exp > 0) mass += Math.max(ncdf(z(payoff[i].S)) - ncdf(z(payoff[i - 1].S)), 0);
      pop = mass * 100;
    }
    const shortN = active.filter((l) => l.side === "SELL").reduce((s, l) => s + l.strike * l.q, 0);
    const longN = active.filter((l) => l.side === "BUY").reduce((s, l) => s + l.strike * l.q, 0);
    return {
      maxP, maxL, bes, pop, pnl: totals.pnl, credit: totals.credit,
      margin: Math.max(shortN * 0.12 - longN * 0.06, 0),
      rr: maxL ? Math.abs(maxP / maxL) : null,
    };
  }, [payoff, atmIV, spot, tYears, active, totals]);

  const targetPnl = useMemo(
    () => (hasLegs && targetSpot != null ? pnlAt(active, targetSpot, targetT, ivShift, basisAdj) : null),
    [active, targetSpot, targetT, ivShift, hasLegs, basisAdj]);

  const targetPnlByLeg = useMemo(() => {
    if (!hasLegs || targetSpot == null) return {};
    const m = {};
    active.forEach((l) => { m[l.id] = pnlAt([l], targetSpot, targetT, ivShift, basisAdj); });
    return m;
  }, [active, targetSpot, targetT, ivShift, hasLegs, basisAdj]);

  const mtm = useMemo(
    () => mtmSeries(legs.filter((l) => !l.off), ex, lotSize).map((r) => ({
      ...r, pnl: r.pnl == null ? null : r.pnl * multiplier })),
    [legs, ex, multiplier]);

  /* ── actions ───────────────────────────────────────────────────────── */
  const addLeg = (strike, right, side) => {
    const p = priceAt(today, strike, right); if (p == null) return;
    setLegs((L) => [...L, {
      id: Date.now() + Math.random(), side, right, strike, expiry,
      lots: Number(defaultLots) || 1, entryDate: today, entryPrice: p,
      closedDate: null, closePrice: null, off: false,
    }]);
  };
  const setLots = (id, n) => setLegs((L) => L.map((l) =>
    l.id === id && !l.closedDate ? { ...l, lots: Math.max(1, Math.min(999, n)) } : l));
  const exitLeg = (id) => setLegs((L) => L.map((l) =>
    l.id === id && !l.closedDate
      ? { ...l, closedDate: today, closePrice: priceAt(today, l.strike, l.right) } : l));
  const exitAll = () => setLegs((L) => L.map((l) =>
    l.closedDate ? l : { ...l, closedDate: today, closePrice: priceAt(today, l.strike, l.right) }));
  const removeLeg = (id) => setLegs((L) => L.filter((l) => l.id !== id));
  const toggleLeg = (id) => setLegs((L) => L.map((l) =>
    l.id === id ? { ...l, off: !l.off } : l));

  const loadStrategy = (strategyLegs) => {
    setLegs(strategyLegs.map((l, i) => ({
      id: Date.now() + i, side: l.side, right: l.right, strike: l.strike, expiry,
      lots: l.lots, entryDate: today, entryPrice: l.price,
      closedDate: null, closePrice: null, off: false,
    })));
    setTab("payoff");
  };

  /* Switching expiry keeps the session you were looking at wherever it exists,
     so the tab row reads as one chain seen at different tenors. */
  const pickExpiry = (e) => {
    const nextDates = bundle.expiries[e]?.dates ?? [];
    const keep = nextDates.indexOf(today);
    setExpiry(e);
    setDayIdx(keep >= 0 ? keep : Math.max(0, nextDates.length - 1));
  };

  const onSave = () => {
    const blob = new Blob([JSON.stringify({ expiry, date: today, legs }, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `thetalab-${expiry}-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const onShare = async () => {
    const text = active.map((l) =>
      `${l.side} ${l.lots * multiplier}x ${l.strike}${l.right} @ ${l.entryPrice}`).join("\n");
    try { await navigator.clipboard.writeText(text || "no open legs"); }
    catch { /* clipboard blocked — nothing worth interrupting for */ }
  };
  const onImport = () => importRef.current?.click();
  const onImportFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = JSON.parse(r.result);
        if (Array.isArray(p?.legs)) setLegs(p.legs);
      } catch (err) { alert("Could not read that strategy: " + err.message); }
    };
    r.readAsText(f);
    e.target.value = "";
  };

  if (!bundle) {
    return <Landing onFile={onFile} onDemo={() => load(makeDemo(), true)} loading={loading} />;
  }

  return (
    <div className="app-shell">
      <input ref={importRef} type="file" accept="application/json"
        onChange={onImportFile} className="hidden" />

      <TopBar symbol={bundle.symbol ?? "NIFTY"} dates={dates} dayIdx={dayIdx}
        setDayIdx={setDayIdx} autoRun={autoRun} setAutoRun={setAutoRun}
        theme={theme} toggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} />

      <MarketStrip ohlc={ohlc} prevClose={prevClose} spot={spot} synthFut={synthFut}
        expiry={expiry} onFind={() => setTab("strategy")} onImport={onImport} />

      <AnimatePresence>
        {demo && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }} className="demo-note">
            <Warning size={14} weight="regular" className="shrink-0" />
            <span><b>Sample data.</b> These premiums come from a model, not from NSE.</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`deskgrid ${chainHid ? "is-chain-hidden" : ""}`}>
        <div className="area-chain">
          <ChainPanel
            expiries={liveExpiries} expiry={expiry}
            tags={tags} today={today} rows={rows} atm={atm}
            spot={reference} held={held} onAdd={addLeg} lots={Number(defaultLots) || 1}
            atmIV={atmIV} straddle={straddle} pcr={oi?.pcr} oi={oi} maxPain={maxPain}
            basis={basis} setBasis={setBasis} synthFut={synthFut}
            onPickExpiry={pickExpiry} collapsed={chainHid} setCollapsed={setChainHid} />
        </div>

        <div className="area-analysis">
          <AnalysisPanel
            tab={tab} setTab={setTab} stats={stats} payoff={payoff} spot={spot} sigma={sigma}
            legs={active} hasLegs={hasLegs} targetSpot={targetSpot} setTargetSpot={setTargetSpot}
            ivShift={ivShift} setIvShift={setIvShift} targetDate={targetDate ?? ""}
            setTargetDate={setTargetDate} targetPnl={targetPnl} targetT={targetT}
            dates={dates} dayIdx={dayIdx} mtm={mtm} oiRows={oiRows}
            straddleSeries={straddleSeries} maxPain={maxPain}
            collapsed={analysisHid} setCollapsed={setAnalysisHid} theme={theme}
            wizard={
              <StrategyWizard chain={chain} strikes={ex.strikes} spot={spot} sigma={sigma}
                tYears={tYears} dates={dates} dayIdx={dayIdx} expiry={expiry}
                lotQty={lotQty} defaultLots={defaultLots} onLoad={loadStrategy} />
            } />
        </div>

        <div className="area-positions">
          <PositionsPanel
            legs={live} today={today} lotQty={lotQty} defaultLots={defaultLots}
            setDefaultLots={setDefaultLots} setLots={setLots} exitLeg={exitLeg}
            removeLeg={removeLeg} toggleLeg={toggleLeg} clear={() => setLegs([])}
            exitAll={exitAll} multiplier={multiplier} setMultiplier={setMultiplier}
            onSave={onSave} onShare={onShare} targetPnlByLeg={targetPnlByLeg}
            targetDate={targetDate ?? today}
            totals={{ ...totals, target: targetPnl }} />
        </div>
      </div>

      <p className="disclaimer">
        End-of-day prices from NSE&rsquo;s official F&amp;O bhavcopy — one session is the smallest
        step that exists in this data, which is why there are no intraday controls. Implied
        volatility is solved from each observed premium, and the target curve holds that
        volatility constant as spot moves; real IV shifts with price, so treat the dashed line as
        a guide rather than a forecast. Probability of profit is a lognormal estimate from ATM IV,
        not a historical frequency. Estimated margin is a rough 12% of short notional less 6% of
        long cover — it is <b>not</b> a SPAN calculation and should not be used for real sizing.
        Max pain and PCR describe where open interest sits, not where price is going. P&amp;L
        excludes brokerage, STT and slippage.
      </p>
    </div>
  );
}
