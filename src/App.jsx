import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Warning } from "@phosphor-icons/react";
import { impliedVol, greeks as bsGreeks, lotSize, ncdf } from "./lib/options";
import {
  atmStrike, oiTotals, oiProfile, maxPain as calcMaxPain, synthFuture, straddlePremium,
  atmImpliedVol, strikeRows, tagExpiries, rollingStraddle, mtmSeries, payoffCurve,
  payoffDomain, pnlAt, breakevens,
} from "./lib/chain";
import { makeDemo } from "./lib/demo";
import {
  fetchLiveChain, assumedKiteConnected, consumeKiteRedirectResult, kiteLoginUrl,
  resolveIndexToken, fetchLiveCandles,
} from "./lib/kiteClient";
import { buildMinuteSeries } from "./lib/liveMinutes";
import Landing from "./components/Landing";
import TopBar from "./components/TopBar";
import MarketStrip from "./components/MarketStrip";
import ChainPanel from "./components/ChainPanel";
import AnalysisPanel from "./components/AnalysisPanel";
import PositionsPanel from "./components/PositionsPanel";
import StrategyWizard from "./components/StrategyWizard";
import MobileTabs from "./components/MobileTabs";

const STORE = "thetalab-book-v2";
const STORE_V1 = "nifty-sim-legs-v1";

/* Each index is its own bundle, its own exchange and its own book. NIFTY comes
   from NSE's bhavcopy, SENSEX from BSE's — different files, different lot sizes
   and different strike spacing, all of which travel inside the bundle itself. */
const INSTRUMENTS = [
  { id: "NIFTY", file: "/chain_bundle.json" },
  { id: "SENSEX", file: "/sensex_bundle.json" },
];
/* A stable empty-object reference for "no chain yet" — `?? {}` would create
   a fresh object on every render instead, defeating every useMemo below
   that depends on `chain` for reference equality. */
const EMPTY_CHAIN = {};

export default function App() {
  const [bundle, setBundle] = useState(null);
  const [instrument, setInstrument] = useState("NIFTY");
  const [available, setAvailable] = useState(["NIFTY"]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  /* Bundles are tens of megabytes; keep each one once it has been parsed so
     flipping between indices is instant rather than a fresh download. */
  const bundleCache = useRef({});
  const [expiry, setExpiry] = useState(null);
  const [dayIdx, setDayIdx] = useState(0);
  const [legs, setLegs] = useState([]);
  const [defaultLots, setDefaultLots] = useState(1);
  const [multiplier, setMultiplier] = useState(1);
  const [autoRun, setAutoRun] = useState(false);
  const [basis, setBasis] = useState("spot");
  /* Which price a session is read and traded at.
     "settle" is the exchange's settlement price — computed after the close for
     every contract, internally consistent across strikes, and the right thing
     to value a chain with. "open" is the session's first trade: the price you
     could actually have entered at that morning. Settlement is only known once
     the day is over, so choosing a strike at its settlement price means
     choosing it already knowing how the day went — near the money that gap runs
     to tens of percent of the premium. Open is the default for that reason. */
  const [priceBasis, setPriceBasis] = useState("open");
  /* "Today (Live)" swaps the bundle's last EOD session for a Kite-fetched
     snapshot of right now. liveSnapshot's shape mirrors a bundle day exactly
     ({date, spot, chain}) so it can be substituted in below without any
     downstream consumer needing to know which source it came from. */
  const [liveMode, setLiveMode] = useState(false);
  const [liveSnapshot, setLiveSnapshot] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState(null);
  const [kiteConnected, setKiteConnected] = useState(() => assumedKiteConnected());
  /* Minute-level scrubbing within live mode — declared up here (rather than
     alongside the effect that fills it in, further down) because `spot`
     below already needs to read it. */
  const [minuteIdx, setMinuteIdx] = useState(null);
  const [minuteSeries, setMinuteSeries] = useState(null); // { timestamps, spot, legs: {key: number[]} }
  const [minuteLoading, setMinuteLoading] = useState(false);
  const [minuteError, setMinuteError] = useState(null);
  useEffect(() => {
    const r = consumeKiteRedirectResult();
    if (r) setKiteConnected(r.connected);
  }, []);
  const [tab, setTab] = useState("payoff");
  const [chainHid, setChainHid] = useState(false);
  /* Which of the three areas a phone is currently showing. Irrelevant above
     the phone breakpoint -- CSS there overrides it and shows all three. */
  const [mobileSection, setMobileSection] = useState("chain");
  const [analysisHid, setAnalysisHid] = useState(false);
  const [ivShift, setIvShift] = useState(0);
  const [targetSpotRaw, setTargetSpot] = useState(null);
  const [targetDate, setTargetDateRaw] = useState(null);
  /* Whether the target date is the user's own choice or just following the
     session in view. Without the distinction, a target that once landed on
     expiry stays there forever -- the expiry is always a valid option, so a
     "keep it if it is still selectable" rule never lets go, and the two payoff
     curves silently collapse back onto each other. */
  const [targetPinned, setTargetPinned] = useState(false);
  const importRef = useRef(null);

  /* Light by default, whatever the operating system prefers. A chain is read
     as a dense grid of small figures and that is what the palette is tuned
     for; the dark theme is a deliberate choice rather than something a desk
     gets handed because the OS happens to be in dark mode at the time. A
     choice made with the toggle still sticks. */
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem("thetalab-theme") || "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("thetalab-theme", theme);
  }, [theme]);

  /* Load whichever index is selected, and find out which others exist.
     An instrument whose bundle has not been built is simply not offered. */
  useEffect(() => {
    let alive = true;
    const cached = bundleCache.current[instrument];
    if (cached) { load(cached); return; }
    setSwitching(true);
    const entry = INSTRUMENTS.find((i) => i.id === instrument) ?? INSTRUMENTS[0];
    fetch(entry.file)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(entry.file))))
      .then((b) => {
        if (!alive) return;
        bundleCache.current[instrument] = b;
        load(b);
      })
      .catch(() => {})
      .finally(() => { if (alive) { setLoading(false); setSwitching(false); } });
    return () => { alive = false; };
  }, [instrument]);

  /* A missing bundle cannot be detected by status code alone: this is a single
     page app, so both the dev server and Vercel rewrite any unknown path to
     index.html and answer 200 with HTML. The content type is what actually
     distinguishes a bundle that exists from the app being served back. */
  useEffect(() => {
    let alive = true;
    Promise.all(INSTRUMENTS.map((i) =>
      fetch(i.file, { method: "HEAD" })
        .then((r) => (r.ok && /json/i.test(r.headers.get("content-type") || "") ? i.id : null))
        .catch(() => null)))
      .then((ids) => {
        const found = ids.filter(Boolean);
        if (alive && found.length) setAvailable(found);
      });
    return () => { alive = false; };
  }, []);

  /* NSE lists NIFTY options years ahead; those far-dated chains are sparse and
     any implied vol solved from them is meaningless.
     This used to demand that an expiry had COMPLETED inside the data, which
     threw out the cycle currently running — the one a desk actually trades. It
     is screened on substance instead: enough sessions to step through and a
     chain wide enough to build on. The far-dated junk that motivated the
     original rule is already gone, dropped at build time by max_dte. */
  const usableExpiries = (b) => {
    const keys = Object.keys(b.expiries).sort();
    const solid = keys.filter((k) => {
      const e = b.expiries[k];
      return e.dates.length >= 2 && e.strikes.length >= 20;
    });
    return solid.length ? solid : keys;
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
    /* Open where a desk would: the most recent session in the data, on the
       front expiry running at that point — not the start of the oldest run-up. */
    const lastData = usable.reduce((mx, k) => {
      const d = b.expiries[k].dates;
      return d[d.length - 1] > mx ? d[d.length - 1] : mx;
    }, "");
    const front = usable.find((k) => k >= lastData) ?? usable[usable.length - 1];
    const d = b.expiries[front].dates;
    setExpiry(front);
    setDayIdx(Math.max(0, d.indexOf(lastData) >= 0 ? d.indexOf(lastData) : d.length - 1));
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

  /* One book, not one per expiry.
     A position is frequently spread across tenors — a weekly sold against the
     monthly, a calendar, a hedge rolled out a week — so the legs live in a
     single list and each carries the expiry it belongs to. Switching the chain
     to another expiry changes what you are looking at, never what you hold.
     v1 stored a separate list under each expiry key; those are folded into the
     flat book on first load, stamping each leg with the key it was filed under. */
  useEffect(() => {
    try {
      const flat = localStorage.getItem(STORE);
      if (flat) { setLegs(JSON.parse(flat)); return; }
      const old = JSON.parse(localStorage.getItem(STORE_V1) || "{}");
      const merged = Object.entries(old).flatMap(([k, list]) =>
        (Array.isArray(list) ? list : []).map((l) => ({ ...l, expiry: l.expiry ?? k })));
      if (merged.length) setLegs(merged);
    } catch { /* unreadable store — start empty rather than fail to load */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(legs)); }
    catch { /* private mode — not worth interrupting for */ }
  }, [legs]);

  /* Legs belong to an index. A NIFTY short and a SENSEX short are not a
     position in anything — different underlying, different lot, different
     exchange — so the book is filtered to the instrument on screen. They share
     one stored list, each leg stamped with the symbol it was opened on. */
  const book = useMemo(
    () => legs.filter((l) => (l.symbol ?? "NIFTY") === instrument), [legs, instrument]);

  /* ── session in view ───────────────────────────────────────────────── */
  const ex = bundle && expiry ? bundle.expiries[expiry] : null;
  const dates = useMemo(() => ex?.dates ?? [], [ex]);
  const bundleToday = dates[dayIdx] ?? null;
  const bundleSpot = bundleToday && ex ? ex.spot[bundleToday] : null;
  const bundleChain = useMemo(
    () => (bundleToday && ex ? ex.chain[bundleToday] ?? {} : {}), [ex, bundleToday]);

  /* Live mode substitutes a Kite snapshot for the bundle date at exactly
     this point — everything below (Greeks, strike window, payoff, the whole
     rest of the app) reads `today`/`spot`/`chain` the same way regardless of
     source. */
  const today = liveMode ? (liveSnapshot?.date ?? null) : bundleToday;
  const spot = liveMode
    ? (minuteIdx != null && minuteSeries ? minuteSeries.spot[minuteIdx] ?? null : liveSnapshot?.spot ?? null)
    : bundleSpot;
  const chain = liveMode ? (liveSnapshot?.chain ?? EMPTY_CHAIN) : bundleChain;

  const ohlc = !liveMode && today && ex?.ohlc ? ex.ohlc[today] : null;
  const prevClose = !liveMode && dayIdx > 0 && ex ? ex.spot[dates[dayIdx - 1]] : null;
  const prevChain = useMemo(
    () => (!liveMode && dayIdx > 0 && ex ? ex.chain[dates[dayIdx - 1]] ?? null : null),
    [ex, dates, dayIdx, liveMode]);

  /* Turning live mode on, or changing expiry/instrument while it's already
     on, triggers exactly this one fetch — toggleLive() itself only flips
     the flag. Strike list and lot size are borrowed from the bundle's own
     entry for this expiry (neither changes intraday), so only price/OI
     actually needs to come from Kite. */
  useEffect(() => {
    if (!liveMode) return;
    const currentEx = bundle?.expiries?.[expiry];
    if (!currentEx) { setLiveMode(false); return; }
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    fetchLiveChain(instrument, expiry, currentEx.strikes)
      .then((data) => { if (!cancelled) setLiveSnapshot(data); })
      .catch((e) => {
        if (cancelled) return;
        setLiveError(e.message);
        setLiveMode(false);
        setKiteConnected(assumedKiteConnected());
      })
      .finally(() => { if (!cancelled) setLiveLoading(false); });
    return () => { cancelled = true; };
  }, [liveMode, expiry, instrument, bundle]);

  /* ── minute-level scrubbing within "Today (Live)" ─────────────────────
     Only for the book's own legs, not the whole visible chain — fetching
     every strike's own minute history just to answer "what would my P&L
     have been at 10:32" would be dozens of Kite calls for strikes the user
     never even bought. */
  const legKeys = useMemo(() => {
    const s = new Set();
    book.forEach((l) => {
      if ((l.expiry ?? expiry) === expiry && !l.closedDate) s.add(`${l.strike}:${l.right}`);
    });
    return [...s].sort();
  }, [book, expiry]);

  useEffect(() => {
    setMinuteIdx(null);
    setMinuteSeries(null);
    setMinuteError(null);
    if (!liveMode || !liveSnapshot || legKeys.length === 0) return;
    let cancelled = false;
    setMinuteLoading(true);
    (async () => {
      try {
        const indexToken = await resolveIndexToken(instrument);
        if (!indexToken) throw new Error("Could not resolve the index's own instrument token.");
        const legTokens = legKeys
          .map((key) => {
            const [strike, right] = key.split(":");
            const r = liveSnapshot.chain[strike];
            return { key, token: right === "CE" ? r?.ceToken : r?.peToken };
          })
          .filter((l) => l.token);

        const range = { from: liveSnapshot.date, to: liveSnapshot.date };
        const [indexCandles, ...legCandles] = await Promise.all([
          fetchLiveCandles(indexToken, "minute", range).then((r) => r.candles),
          ...legTokens.map((l) => fetchLiveCandles(l.token, "minute", range).then((r) => r.candles)),
        ]);
        if (cancelled) return;
        setMinuteSeries(buildMinuteSeries(indexCandles, legTokens.map((l, i) => [l.key, legCandles[i]])));
      } catch (e) {
        if (!cancelled) setMinuteError(e.message);
      } finally {
        if (!cancelled) setMinuteLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [liveMode, liveSnapshot, legKeys, instrument]);

  const toggleLive = () => {
    if (liveMode) { setLiveMode(false); return; }
    if (!kiteConnected) { window.location.href = kiteLoginUrl(); return; }
    setLiveMode(true);
  };
  /* Live mode means "right now," which stepping through historical days or
     switching instrument both contradict — either one exits it first. */
  const setDayIdxAndExitLive = useCallback((i) => { setLiveMode(false); setDayIdx(i); }, []);
  const onPickSymbolAndExitLive = useCallback((id) => { setLiveMode(false); setInstrument(id); }, []);

  /* The exchange states the market lot in the bhavcopy, so the bundle carries
     it; the date table is only a fallback for older bundles built without it. */
  const lotFor = useCallback(
    (expKey, date) => bundle?.expiries?.[expKey]?.lot ?? lotSize(date ?? "2026-01-01"),
    [bundle]);
  const lotQty = lotFor(expiry, today);

  const tYears = useMemo(() => {
    if (!today || !expiry) return 0;
    return Math.max((new Date(expiry) - new Date(today)) / 86400000, 0) / 365;
  }, [today, expiry]);


  /* ── chain analytics ───────────────────────────────────────────────── */
  /* The forward is deliberately read off settlement even when the desk is
     trading the open. Put-call parity needs a call and a put struck at the same
     instant; opens are two separate trades that can be minutes apart, and the
     parity between them drifts hundreds of points as a result — enough to push
     an at-the-money delta to 0.76. Settlement is the one cross-strike
     consistent series, so it anchors the forward, and every implied vol and
     delta is solved against that. Displayed and traded premiums still follow
     the basis; only the reference they are measured against is held steady. */
  const synthFut = useMemo(
    () => synthFuture(chain, ex?.strikes, spot), [chain, ex, spot]);
  const reference = basis === "synth" && synthFut != null ? synthFut : spot;
  const atm = useMemo(() => atmStrike(ex?.strikes, reference), [ex, reference]);

  /* Every Black-Scholes solve runs against the forward the options are actually
     quoting, not the index level. Each leg carries its own expiry's basis into
     the payoff curve, which is charted on the index scale. */
  const fwd = synthFut ?? spot;

  const atmIV = useMemo(
    () => atmImpliedVol(chain, atm, fwd, tYears, priceBasis), [chain, atm, fwd, tYears, priceBasis]);
  const sigma = atmIV && spot ? spot * atmIV * Math.sqrt(tYears) : null;
  const straddle = useMemo(
    () => straddlePremium(chain, atm, priceBasis), [chain, atm, priceBasis]);
  const oi = useMemo(() => oiTotals(chain, prevChain), [chain, prevChain]);
  const maxPain = useMemo(() => calcMaxPain(chain, ex?.strikes ?? []), [chain, ex]);
  /* The expiry tabs are the chains live on this session — not every expiry in
     eight years of data. The one in view is always included, even on a session
     where it happens to carry no quotes. */
  const liveExpiries = useMemo(() => {
    if (!bundle || !today) return expiry ? [expiry] : [];
    // A live "today" is never a key in _byDate (it was never a bundle
    // session) — the meaningful set there is just "not yet expired."
    if (liveMode) return (bundle._usable ?? []).filter((e) => e >= today);
    const on = (bundle._byDate?.[today] ?? []).filter((e) => e >= today);
    return on.includes(expiry) ? on : [...on, expiry].filter(Boolean).sort();
  }, [bundle, today, expiry, liveMode]);

  const tags = useMemo(
    () => tagExpiries(bundle?._usable ?? [], today), [bundle, today]);

  /* Which calendar days are themselves an expiry — the picker marks them. */
  const expirySet = useMemo(() => new Set(bundle?._usable ?? []), [bundle]);

  const windowStrikes = useMemo(() => {
    if (!ex || !spot) return [];
    const span = sigma ? sigma * 3.2 : spot * 0.05;
    return ex.strikes.filter((s) => Math.abs(s - spot) <= span);
  }, [ex, spot, sigma]);

  const rows = useMemo(
    () => strikeRows(chain, windowStrikes, fwd, tYears, priceBasis),
    [chain, windowStrikes, fwd, tYears, priceBasis]);
  const oiRows = useMemo(
    () => oiProfile(chain, windowStrikes, prevChain), [chain, windowStrikes, prevChain]);
  const straddleSeries = useMemo(
    () => rollingStraddle(ex, null, priceBasis), [ex, priceBasis]);

  /* ── legs, marked to the session in view ───────────────────────────── */
  /* Any leg, any expiry, any session. */
  const priceOf = useCallback((expKey, date, strike, right, ignoreMinute = false) => {
    /* A live pseudo-day is never in the bundle at all, so it needs its own
       lookup — c/c0 (and p/p0) are the same live number by construction
       (see kite-chain.js), so priceBasis is irrelevant here. */
    if (liveMode && liveSnapshot && date === liveSnapshot.date && expKey === expiry) {
      /* Scrubbed to a minute in the past — only resolvable for a leg that
         was already in the book when the scrubber's fetch ran (see
         legKeys above); anything else (e.g. pricing a brand-new strike to
         add) correctly falls through to null rather than a stale guess.
         ignoreMinute lets a trading action (open/close a leg) always price
         off "now" even while the view is scrubbed to the past. */
      if (!ignoreMinute && minuteIdx != null && minuteSeries) {
        return minuteSeries.legs[`${strike}:${right}`]?.[minuteIdx] ?? null;
      }
      const r = liveSnapshot.chain[String(strike)];
      if (!r) return null;
      return right === "CE" ? (r.c ?? null) : (r.p ?? null);
    }
    const r = bundle?.expiries?.[expKey]?.chain?.[date]?.[String(strike)];
    if (!r) return null;
    const k = right === "CE"
      ? (priceBasis === "open" ? "c0" : "c")
      : (priceBasis === "open" ? "p0" : "p");
    return r[k] ?? null;
  }, [bundle, priceBasis, liveMode, liveSnapshot, expiry, minuteIdx, minuteSeries]);

  /* Each expiry in the book prices off its own forward and its own tenor, so
     the context is built once per expiry rather than once per leg. */
  const legCtx = useMemo(() => {
    if (!bundle || !today) return {};
    const keys = new Set(book.map((l) => l.expiry).filter(Boolean));
    if (expiry) keys.add(expiry);
    const m = {};
    keys.forEach((k) => {
      const e = bundle.expiries[k];
      const ch = e?.chain?.[today];
      if (!ch) return;
      const sp = e.spot[today] ?? spot;
      const f = synthFuture(ch, e.strikes, sp) ?? sp;
      m[k] = {
        chain: ch, spot: sp, fwd: f, basis: f - sp,
        T: Math.max((new Date(k) - new Date(today)) / 86400000, 0) / 365,
      };
    });
    return m;
  }, [bundle, book, expiry, today, spot]);

  const live = useMemo(() => {
    if (!today) return [];
    return book.map((l) => {
      const lex = l.expiry ?? expiry;
      const c = legCtx[lex];
      const closed = l.closedDate && today >= l.closedDate;
      const quoted = priceOf(lex, today, l.strike, l.right);
      const cur = closed ? l.closePrice : quoted;
      const q = l.lots * multiplier * lotFor(lex, l.entryDate);
      const isCall = l.right === "CE";
      const iv = cur != null && !closed && c && c.T > 0
        ? impliedVol(cur, c.fwd, l.strike, c.T, isCall) : null;
      const g = iv ? bsGreeks(c.fwd, l.strike, c.T, iv, isCall)
        : { delta: 0, gamma: 0, theta: 0, vega: 0 };
      const pnl = cur == null ? null
        : (l.side === "SELL" ? l.entryPrice - cur : cur - l.entryPrice) * q;
      return {
        ...l, expiry: lex, cur, q, dir: l.side === "SELL" ? -1 : 1,
        isCall, iv, g, pnl, closed, basis: c?.basis ?? 0,
        /* This expiry carries no chain for this session — the bundle only keeps
           the run-up to each expiry. Say so rather than showing a stale mark.
           A leg opened later than the session in view is simply not held yet,
           which is a different thing and not worth flagging. */
        noQuote: !closed && quoted == null && l.entryDate <= today && lex >= today,
        expired: lex < today,
        active: l.entryDate <= today && !closed && lex >= today,
      };
    });
  }, [book, today, legCtx, multiplier, expiry, lotFor, priceOf]);

  /* Legs the payoff is actually built from: open, and not switched off. */
  const active = useMemo(() => live.filter((l) => l.active && !l.off), [live]);
  const hasLegs = active.length > 0;

  /* Chain badges belong to the expiry on screen — a leg on another tenor is
     still in the book, but it is not a position in THIS chain. */
  const held = useMemo(() => {
    const m = {};
    live.filter((l) => l.active && l.expiry === expiry).forEach((l) => {
      const k = `${l.strike}${l.right}`;
      const e = m[k] || (m[k] = { lots: 0, cost: 0 });
      const s = l.side === "SELL" ? -1 : 1;
      e.lots += s * l.lots * multiplier;
      e.cost += s * l.entryPrice * l.lots * multiplier;
    });
    Object.values(m).forEach((e) => { e.avg = e.lots ? Math.abs(e.cost / e.lots) : 0; });
    return m;
  }, [live, multiplier, expiry]);

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

  /* The payoff's expiry reference is the NEAREST leg expiry — where a calendar's
     shape is actually decided. Legs expiring then settle at intrinsic; anything
     longer-dated still carries time value and is priced for it. */
  const nearExpiry = useMemo(
    () => (active.length ? active.map((l) => l.expiry).sort()[0] : expiry), [active, expiry]);
  const yearsBetween = (from, to) =>
    Math.max((new Date(to) - new Date(from)) / 86400000, 0) / 365;

  const payoffLegs = useMemo(() => active.map((l) => ({
    side: l.side, right: l.right, strike: l.strike, entryPrice: l.entryPrice,
    q: l.q, iv: l.iv, basis: l.basis, id: l.id,
    tExp: yearsBetween(nearExpiry, l.expiry),
    tTgt: yearsBetween(targetDate ?? nearExpiry, l.expiry),
  })), [active, nearExpiry, targetDate]);

  const bookExpiries = useMemo(
    () => [...new Set(active.map((l) => l.expiry))].sort(), [active]);

  /* Fixed while you step the tape. Built from the strikes held and the whole
     spot path of this expiry — none of which depend on the session in view —
     so the payoff stays put and the spot marker is what moves. Open legs are
     used rather than active ones, so the frame does not jump on the session a
     leg happens to come into play. */
  const payoffDom = useMemo(() => {
    if (!ex) return null;
    return payoffDomain({
      strikes: book.filter((l) => !l.closedDate).map((l) => l.strike),
      spots: ex.dates.map((d) => ex.spot[d]),
    });
  }, [ex, book]);

  const payoff = useMemo(
    () => payoffCurve({ legs: payoffLegs, domain: payoffDom, ivShift }),
    [payoffLegs, payoffDom, ivShift]);

  /* The vertical scale is snapped to a round step so it does not creep as the
     target curve decays into the expiry curve day by day. */
  const yDomain = useMemo(() => {
    if (!payoff.length) return undefined;
    let lo = Infinity, hi = -Infinity;
    payoff.forEach((p) => {
      lo = Math.min(lo, p.exp, p.tgt); hi = Math.max(hi, p.exp, p.tgt);
    });
    const pad = Math.max((hi - lo) * 0.1, 1);
    lo -= pad; hi += pad;
    const raw = (hi - lo) / 4;
    const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || mag * 10;
    return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
  }, [payoff]);

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
    () => (hasLegs && targetSpot != null ? pnlAt(payoffLegs, targetSpot, ivShift) : null),
    [payoffLegs, targetSpot, ivShift, hasLegs]);

  const targetPnlByLeg = useMemo(() => {
    if (!hasLegs || targetSpot == null) return {};
    const m = {};
    payoffLegs.forEach((l) => { m[l.id] = pnlAt([l], targetSpot, ivShift); });
    return m;
  }, [payoffLegs, targetSpot, ivShift, hasLegs]);

  /* Every session still ahead of us across the whole book, plus the expiry
     dates themselves. The expiries matter on their own account: the data stops
     a few sessions short of a running contract, so without them there would be
     no way to ask what the position is worth at settlement. */
  const targetDates = useMemo(() => {
    if (!bundle || !today) return [];
    const keys = new Set(book.map((l) => l.expiry).filter(Boolean));
    if (expiry) keys.add(expiry);
    const all = new Set();
    keys.forEach((k) => {
      (bundle.expiries[k]?.dates ?? []).forEach((d) => { if (d >= today) all.add(d); });
      if (k >= today) all.add(k);
    });
    return [...all].sort();
  }, [bundle, book, expiry, today]);

  /* Target follows the session in view unless the user has picked one.
     Anchored on today the dashed curve shows what the position is worth right
     now, with time value still in it — the comparison the chart exists to
     make. Anchored on expiry both curves are intrinsic and identical, which is
     why that cannot be the default. */
  useEffect(() => {
    if (!targetDates.length) return;
    setTargetDateRaw((t) =>
      (targetPinned && t && targetDates.includes(t) ? t : targetDates[0]));
  }, [targetDates, targetPinned]);

  const setTargetDate = useCallback((d) => {
    setTargetPinned(true);
    setTargetDateRaw(d);
  }, []);
  /* A different expiry is a different question; stop holding the old answer. */
  useEffect(() => { setTargetPinned(false); }, [expiry]);

  const mtm = useMemo(
    () => mtmSeries(
      book.filter((l) => !l.off).map((l) => ({ ...l, expiry: l.expiry ?? expiry })),
      dates, priceOf, (d) => lotFor(expiry, d), (d) => ex?.spot?.[d],
    ).map((r) => ({ ...r, pnl: r.pnl == null ? null : r.pnl * multiplier })),
    [book, dates, priceOf, ex, multiplier, expiry, lotFor]);

  /* ── actions ───────────────────────────────────────────────────────── */
  const addLeg = (strike, right, side) => {
    /* Opening a position always happens at the live price, never a
       scrubbed-past one (priceOf's ignoreMinute) — and the view snaps back
       to "now" too, so the freshly-added leg isn't shown next to positions
       still marked at some earlier minute. */
    const p = priceOf(expiry, today, strike, right, true); if (p == null) return;
    setMinuteIdx(null);
    setLegs((L) => [...L, {
      id: Date.now() + Math.random(), symbol: instrument, side, right, strike, expiry,
      lots: Number(defaultLots) || 1, entryDate: today, entryPrice: p,
      closedDate: null, closePrice: null, off: false,
    }]);
  };
  const setLots = (id, n) => setLegs((L) => L.map((l) =>
    l.id === id && !l.closedDate ? { ...l, lots: Math.max(1, Math.min(999, n)) } : l));
  const closeAt = (l) => ({
    ...l, closedDate: today,
    closePrice: priceOf(l.expiry ?? expiry, today, l.strike, l.right, true),
  });
  const exitLeg = (id) => { setMinuteIdx(null); setLegs((L) => L.map((l) =>
    l.id === id && !l.closedDate ? closeAt(l) : l)); };
  /* Only legs quoted on this session can be closed at a real price. */
  const mine = (l) => (l.symbol ?? "NIFTY") === instrument;
  const exitAll = () => { setMinuteIdx(null); setLegs((L) => L.map((l) =>
    !mine(l) || l.closedDate || priceOf(l.expiry ?? expiry, today, l.strike, l.right, true) == null
      ? l : closeAt(l))); };
  const clearBook = () => setLegs((L) => L.filter((l) => !mine(l)));
  const removeLeg = (id) => setLegs((L) => L.filter((l) => l.id !== id));
  const toggleLeg = (id) => setLegs((L) => L.map((l) =>
    l.id === id ? { ...l, off: !l.off } : l));

  /* The wizard builds a structure for the expiry on screen; it replaces what
     is open on THAT expiry and leaves the rest of the book alone. */
  const loadStrategy = (strategyLegs) => {
    setMinuteIdx(null);
    setLegs((L) => [
      ...L.filter((l) => (l.symbol ?? "NIFTY") !== instrument
                      || (l.expiry ?? expiry) !== expiry || l.closedDate),
      ...strategyLegs.map((l, i) => ({
        id: Date.now() + i, symbol: instrument, side: l.side, right: l.right,
        strike: l.strike, expiry,
        lots: l.lots, entryDate: today, entryPrice: l.price,
        closedDate: null, closePrice: null, off: false,
      })),
    ]);
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
    const blob = new Blob([JSON.stringify({ symbol: instrument, expiry, date: today,
      legs: book }, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `thetalab-${instrument}-${expiry}-${today}.json`;
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
        if (Array.isArray(p?.legs)) {
          const incoming = p.legs.map((l) => ({ ...l, symbol: instrument }));
          setLegs((L) => [...L.filter((l) => !mine(l)), ...incoming]);
        }
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

      <TopBar symbol={instrument} instruments={available} onPickSymbol={onPickSymbolAndExitLive}
        switching={switching} dates={dates} dayIdx={dayIdx}
        setDayIdx={setDayIdxAndExitLive} expirySet={expirySet} autoRun={autoRun} setAutoRun={setAutoRun}
        theme={theme} toggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        live={liveMode}
        liveLoading={liveLoading} liveError={liveError} onToggleLive={toggleLive}
        minuteIdx={minuteIdx} setMinuteIdx={setMinuteIdx} minuteSeries={minuteSeries}
        minuteLoading={minuteLoading} minuteError={minuteError} />

      <MarketStrip ohlc={ohlc} prevClose={prevClose} spot={spot} synthFut={synthFut}
        expiry={expiry}
        onFind={() => { setTab("strategy"); setMobileSection("analysis"); }}
        onImport={onImport} />

      <AnimatePresence>
        {demo && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }} className="demo-note">
            <Warning size={14} weight="regular" className="shrink-0" />
            <span><b>Sample data.</b> These premiums come from a model, not from NSE.</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`deskgrid ${chainHid ? "is-chain-hidden" : ""}`}
        data-mobile-section={mobileSection}>
        <div className="area-chain">
          <ChainPanel
            expiries={liveExpiries} allExpiries={bundle._usable} expiry={expiry}
            tags={tags} today={today} rows={rows} atm={atm}
            spot={reference} held={held} onAdd={addLeg} lots={Number(defaultLots) || 1}
            atmIV={atmIV} straddle={straddle} pcr={oi?.pcr} oi={oi} maxPain={maxPain}
            basis={basis} setBasis={setBasis} synthFut={synthFut}
            priceBasis={priceBasis} setPriceBasis={setPriceBasis}
            onPickExpiry={pickExpiry} collapsed={chainHid} setCollapsed={setChainHid} />
        </div>

        <div className="area-analysis">
          <AnalysisPanel
            tab={tab} setTab={setTab} stats={stats} payoff={payoff} spot={spot} sigma={sigma}
            legs={active} hasLegs={hasLegs} targetSpot={targetSpot} setTargetSpot={setTargetSpot}
            ivShift={ivShift} setIvShift={setIvShift} targetDate={targetDate ?? ""}
            setTargetDate={setTargetDate} targetPnl={targetPnl} yDomain={yDomain} xDomain={payoffDom}
            targetDates={targetDates} targetIsExpiry={!!targetDate && targetDate >= nearExpiry}
            nearExpiry={nearExpiry} mixedExpiries={bookExpiries.length > 1}
            dates={dates} dayIdx={dayIdx} mtm={mtm} oiRows={oiRows}
            straddleSeries={straddleSeries} maxPain={maxPain}
            collapsed={analysisHid} setCollapsed={setAnalysisHid} theme={theme}
            symbol={instrument} dailyOhlc={ex.ohlc} kiteConnected={kiteConnected}
            wizard={
              <StrategyWizard chain={chain} strikes={ex.strikes} spot={spot} sigma={sigma}
                tYears={tYears} dates={dates} dayIdx={dayIdx} expiry={expiry} today={today}
                step={bundle.strike_step ?? 50} symbol={instrument} priceBasis={priceBasis}
                lotQty={lotQty} defaultLots={defaultLots} onLoad={loadStrategy} />
            } />
        </div>

        <div className="area-positions">
          <PositionsPanel
            legs={live} today={today} lotQty={lotQty} defaultLots={defaultLots}
            setDefaultLots={setDefaultLots} setLots={setLots} exitLeg={exitLeg}
            removeLeg={removeLeg} toggleLeg={toggleLeg} clear={clearBook}
            exitAll={exitAll} multiplier={multiplier} setMultiplier={setMultiplier}
            onSave={onSave} onShare={onShare} targetPnlByLeg={targetPnlByLeg}
            targetDate={targetDate ?? today}
            totals={{ ...totals, target: targetPnl }} />
        </div>
      </div>

      <MobileTabs active={mobileSection} onChange={setMobileSection}
        legCount={book.length} pnl={hasLegs ? totals.pnl : null} />

      <p className="disclaimer">
        <b>
          {priceBasis === "open"
            ? "Prices are each session's opening trade — the price you could have entered at that morning. "
            : "Prices are the exchange's settlement price, which is only known after the close: selecting a strike at it means selecting it already knowing how the day went. "}
        </b>{" "}
        End-of-day prices from {bundle.exchange ?? "NSE"}&rsquo;s official F&amp;O bhavcopy — one
        session is the smallest
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
