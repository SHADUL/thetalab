/**
 * NIFTY ASCENT — Gap-and-Go → Williams. A self-contained options-buying
 * research terminal inside ThetaLab at /nifty-ascent/<workspace>.
 * Phase 2: deterministic SIMULATION replay only (every screen is labelled);
 * paper only, no order path, no Kite connection.
 */
import { useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from "react";
import {
  ArrowLeft, Gauge, TrendUp, ArrowsSplit, ChartLine, Crosshair, Notebook, ChartBar, ShieldCheck,
  Play, Pause, ArrowCounterClockwise, Sun, Moon, Lock, FastForward, ClockCounterClockwise,
} from "@phosphor-icons/react";
import "./nifty-ascent.css";
import { ascent, useAscent, SPEEDS, startLivePolling, view } from "./store.js";
import { Pill, AscentGlyph } from "./ui.jsx";
import { istTime, istDate, hm, BOT_LABEL } from "./format.js";
import { FIXTURES } from "../../nifty-ascent/sim/fixtures.ts";
import { barStart } from "../../nifty-ascent/core/rules.ts";
import CommandCenter from "./CommandCenter.jsx";

const GapAndGo = lazy(() => import("./GapAndGo.jsx"));
const Williams = lazy(() => import("./Williams.jsx"));
const LiveCharts = lazy(() => import("./LiveCharts.jsx"));
const OptionPosition = lazy(() => import("./OptionPosition.jsx"));
const TradeJournal = lazy(() => import("./TradeJournal.jsx"));
const Analytics = lazy(() => import("./Analytics.jsx"));
const RiskSettings = lazy(() => import("./RiskSettings.jsx"));
const Backtest = lazy(() => import("./Backtest.jsx"));

const WORKSPACES = [
  { id: "command-center", label: "Command Center", icon: Gauge, C: CommandCenter },
  { id: "gap-and-go", label: "Gap-and-Go", icon: TrendUp, C: GapAndGo },
  { id: "williams", label: "Williams", icon: ArrowsSplit, C: Williams },
  { id: "live-charts", label: "Live Charts", icon: ChartLine, C: LiveCharts },
  { id: "option-position", label: "Option Position", icon: Crosshair, C: OptionPosition },
  { id: "trade-journal", label: "Trade Journal", icon: Notebook, C: TradeJournal },
  { id: "analytics", label: "Analytics", icon: ChartBar, C: Analytics },
  { id: "risk-settings", label: "Risk & Settings", icon: ShieldCheck, C: RiskSettings },
  { id: "backtest", label: "Backtest", icon: ClockCounterClockwise, C: Backtest },
];
const BASE = "/nifty-ascent";

function tabFromPath() {
  const seg = window.location.pathname.slice(BASE.length).replace(/^\/+/, "").split("/")[0];
  return WORKSPACES.some((w) => w.id === seg) ? seg : "command-center";
}

function useTheme() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("thetalab-theme") || "light"; } catch { return "light"; } });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("thetalab-theme", theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, setTheme];
}

/** Live paper status word from the server. */
function livePaperPill(L) {
  if (!L || !L.enabled || L.mode !== "PAPER") return { tone: "warn", text: "NOT ENABLED", title: "Live paper execution is not enabled. No paper or real orders are placed." };
  if (L.livePaper === "RUNNING") return { tone: "gain", text: "RUNNING", title: "Paper engine running on real Kite quotes — paper fills only, never real orders." };
  return { tone: "accent", text: "READY · PAUSED", title: L.paper?.blockedReason ? `Blocked: ${L.paper.blockedReason}` : "Paper engine ready and PAUSED — it trades only after START or auto-start." };
}

function Header({ onExit, theme, setTheme }) {
  const S = useAscent();
  const v = view(S);
  const e = v.engine ?? S.replay.engine;
  const now = v.now;
  const lp = livePaperPill(S.live);
  const open = now >= barStart(e.date, 555) && now < barStart(e.date, 930);
  const L = S.live;
  const st = L?.stream;
  const kite = !L ? { tone: undefined, text: "CHECKING", title: "Contacting the server" }
    : !L.enabled ? { tone: "warn", text: "NOT OBSERVED", title: L.reason }
    : st?.connected ? { tone: "gain", live: true, text: "CONNECTED", title: `Shared Kite stream · ${st.subscribed ?? 0} instruments · last message ${st.lastMessageAgoMs ?? "—"} ms ago` }
    : { tone: undefined, text: "IDLE", title: "The shared Kite stream connects 09:00–15:45 IST on trading days" };
  const liveEng = !L ? { tone: undefined, text: "—", title: "" }
    : !L.enabled ? { tone: "warn", text: "OFF", title: L.reason }
    : !L.engine ? { tone: undefined, text: "NOT CREATED", title: "The live engine is created from 08:50 on trading days" }
    : { tone: L.engine.engineStatus === "RUNNING" ? "gain" : "warn", text: `${L.engine.engineStatus.replace("_", " ")}${L.mode === "PAPER" ? "" : " · OBSERVE"}`, title: L.mode === "PAPER" ? "Live PAPER engine — paper fills only, never real orders." : "The live engine observes real NIFTY data and records signals; it cannot place paper or real orders." };
  const stTone = e.state === "DATA_ERROR" ? "loss" : e.state === "POSITION_OPEN" || e.state === "EXIT_PENDING" ? "gain" : e.state.includes("ARMED") ? "accent" : undefined;
  return (
    <header className="na-header">
      <button className="na-back" onClick={onExit} title="Return to ThetaLab">
        <ArrowLeft size={14} weight="bold" />
        <img src="/favicon.svg" alt="" width={14} height={14} />
        <b>theta<span className="text-accent">lab</span></b>
      </button>
      <div className="na-brand">
        <div className="na-mark"><AscentGlyph size={22} /></div>
        <div className="min-w-0">
          <div className="na-title">NIFTY <span>ASCENT</span></div>
          <div className="na-sub">Gap-and-Go → Williams · {e.configVersion.split(":")[0]}</div>
        </div>
      </div>
      <div className="na-pills" role="status" aria-live="off">
        {v.live
          ? <Pill k="Showing" tone="accent" title="Real NIFTY data from the server engine (read-only)">LIVE · REAL DATA</Pill>
          : v.backtest
          ? <Pill k="Showing" tone="accent" title="Real NIFTY 1-minute history from Kite; option premiums are MODELLED (Black-76 with the previous day's India VIX)">BACKTEST · {S.bt.date ?? "no day"}</Pill>
          : <Pill k="Showing" tone="warn" title="Every price on these screens comes from a synthetic replay fixture — not market data">SIMULATION</Pill>}
        <Pill k="Live paper" tone={lp.tone} title={lp.title}><Lock size={10} weight="bold" style={{ marginRight: 3, verticalAlign: -1 }} />{lp.text}</Pill>
        <Pill k="Kite feed" tone={kite.tone} live={kite.live} title={kite.title}>{kite.text}</Pill>
        <Pill k="Live engine" tone={liveEng.tone} title={liveEng.title}>{liveEng.text}</Pill>
        {!v.live && <Pill k="Replay" optional tone={open ? "gain" : undefined} live={open && S.playing}>{open ? "SESSION" : now < barStart(e.date, 555) ? "PRE-OPEN" : "CLOSED"} · engine {e.engineStatus.replace("_", " ").toLowerCase()}</Pill>}
        {(!v.live || v.engine) && <Pill k="State" tone={stTone}>{e.state.replaceAll("_", " ")}</Pill>}
        {(!v.live || v.engine) && <Pill k="Bot" optional tone={e.activeBot === "WILLIAMS" ? "accent" : undefined}>{e.activeBot ? BOT_LABEL[e.activeBot] : "—"}</Pill>}
        <Pill k="Session" optional>{istDate(now)} · {istTime(now)} IST</Pill>
      </div>
      <button className="na-icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}

const JUMPS = ["09:14", "09:46", "10:30", "12:00", "14:29", "15:15"];

function SourceSwitch() {
  const S = useAscent();
  return (
    <div className="na-seg" role="group" aria-label="Data source">
      <button data-on={S.source === "SIMULATION"} onClick={() => ascent.setSource("SIMULATION")} title="Deterministic replay in this browser">Simulation</button>
      <button data-on={S.source === "BACKTEST"} onClick={() => ascent.setSource("BACKTEST")} title="Replay past trading days: real NIFTY 1-minute data, modelled option prices">Backtest</button>
      <button data-on={S.source === "LIVE"} onClick={() => ascent.setSource("LIVE")} title="Read-only view of the server engine on real Kite data">Live paper</button>
    </div>
  );
}

function LiveBand() {
  const S = useAscent();
  const L = S.live, lp = livePaperPill(L);
  return (
    <div className="na-simband na-liveband" data-down={!L?.enabled} role="note">
      <span className="na-simtag na-livetag">{L?.mode === "PAPER" ? "LIVE PAPER" : "LIVE · OBSERVE"}</span>
      <span className="na-long">Real NIFTY data from the shared Kite stream · {L?.mode === "PAPER" ? <>paper fills — real orders only if you arm <b>Live trading</b> in Risk &amp; Settings</> : <><b>LIVE PAPER — NOT ENABLED</b> (observe only)</>} · status: <b>{lp.text}</b>{L?.date ? <> · session {L.date}</> : null}</span>
      <span className="na-short">Real data · <b>{lp.text}</b></span>
      <span className="n na-muted">{L?.serverTime ? `${istTime(L.serverTime)} IST` : ""}</span>
      <div className="na-simctl"><SourceSwitch /></div>
    </div>
  );
}

function LiveEmpty() {
  const S = useAscent();
  const L = S.live;
  return (
    <div className="na-card" style={{ padding: 22 }}>
      <div className="na-ws-title" style={{ fontSize: 16 }}>No live engine to show yet</div>
      <div className="na-note" style={{ marginTop: 6 }}>
        {!L ? "Contacting the server…" : !L.enabled ? L.reason : S.mirrorError ? `Live view unavailable: ${S.mirrorError}` : "The live engine is created from 08:50 IST on trading days. Switch to Simulation to explore the strategy with replay data."}
      </div>
      <div style={{ marginTop: 12 }}><SourceSwitch /></div>
    </div>
  );
}

function ReplayControls() {
  const S = useAscent();
  return (
    <>
        <button className="na-chipbtn" onClick={() => (S.playing ? ascent.pause() : ascent.play())} disabled={S.replay.done} aria-label={S.playing ? "Pause replay" : "Play replay"}>
          {S.playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}{S.playing ? "Pause" : S.replay.done ? "Ended" : "Play"}
        </button>
        <div className="na-seg" role="group" aria-label="Replay speed">
          {SPEEDS.map((x) => <button key={x} data-on={S.speed === x} onClick={() => ascent.setSpeed(x)}>{x}×</button>)}
        </div>
        <select className="na-chipbtn" aria-label="Jump to time" value="" onChange={(ev) => ev.target.value && ascent.jumpTo(ev.target.value)}>
          <option value="">Jump to…</option>
          {JUMPS.map((j) => <option key={j} value={j}>{j} IST</option>)}
        </select>
        <button className="na-chipbtn" onClick={() => ascent.toEnd()} title="Run to the end of the session"><FastForward size={13} />End</button>
        <button className="na-chipbtn" onClick={() => ascent.restart()} title="Restart this day from 09:10"><ArrowCounterClockwise size={13} />Restart</button>
    </>
  );
}

function BacktestBand() {
  const S = useAscent();
  const B = S.bt;
  const i = B.days.findIndex((d) => d.date === B.date);
  const step = (k) => { const d = B.days[i + k]; if (d) ascent.btOpenDay(d.date); };
  return (
    <div className="na-simband na-liveband" role="note">
      <span className="na-simtag na-livetag">BACKTEST</span>
      <span className="na-long">Real NIFTY 1-minute data (Kite history) · option prices <b>MODELLED</b> (Black-76, previous-day VIX) · paper only — never mixed with live paper</span>
      <span className="na-short">Real NIFTY · <b>modelled options</b></span>
      <span className="n na-muted">{B.data ? `${B.date} ${istTime(S.replay.t)} IST` : B.loading ? `Loading ${B.date}…` : "No day loaded"}</span>
      <div className="na-simctl">
        <SourceSwitch />
        <button className="na-chipbtn" onClick={() => step(-1)} disabled={i <= 0 || B.loading} aria-label="Previous day">‹</button>
        <select className="na-chipbtn" aria-label="Backtest day" value={B.date ?? ""} onChange={(ev) => ev.target.value && ascent.btOpenDay(ev.target.value)} disabled={B.loading}>
          <option value="">{B.loadingDays ? "Loading days…" : "Pick a day…"}</option>
          {B.days.map((d) => <option key={d.date} value={d.date}>{d.date}</option>)}
        </select>
        <button className="na-chipbtn" onClick={() => step(1)} disabled={i < 0 || i >= B.days.length - 1 || B.loading} aria-label="Next day">›</button>
        {B.data && !B.loading && <ReplayControls />}
      </div>
    </div>
  );
}

function BacktestEmpty({ go }) {
  const S = useAscent();
  return (
    <div className="na-card" style={{ padding: 22 }}>
      <div className="na-ws-title" style={{ fontSize: 16 }}>{S.bt.loading ? `Loading ${S.bt.date}…` : "No backtest day loaded"}</div>
      <div className="na-note" style={{ marginTop: 6 }}>{S.bt.error ? `Could not load the day: ${S.bt.error}` : "Pick a trading day in the band above, or open the Backtest workspace to see the whole month."}</div>
      <div style={{ marginTop: 12 }}><button className="na-chipbtn" onClick={() => go("backtest")}>Open the Backtest workspace</button></div>
    </div>
  );
}

function SimBand() {
  const S = useAscent();
  const f = ascent.fixture();
  return (
    <div className="na-simband" role="note">
      <span className="na-simtag">SIMULATION</span>
      <span className="na-long">Deterministic replay fixture · synthetic NIFTY and option prices — <b>not market data</b> · results prove nothing · <b>LIVE PAPER — NOT ENABLED</b>.</span>
      <span className="na-short">Synthetic data — <b>not market data</b></span>
      <span className="n na-muted">SIM {istTime(S.replay.t)} IST</span>
      <div className="na-simctl">
        <SourceSwitch />
        <select className="na-chipbtn" aria-label="Replay fixture" value={S.fixtureId} onChange={(ev) => ascent.select(ev.target.value)} style={{ maxWidth: 280 }} title={f.summary}>
          {FIXTURES.map((x) => <option key={x.id} value={x.id}>{x.date.slice(5)} · {x.title}</option>)}
        </select>
        <ReplayControls />
      </div>
    </div>
  );
}

function Rail({ tab, go }) {
  const S = useAscent();
  const e = view(S).engine ?? S.replay.engine;
  return (
    <nav className="na-rail" aria-label="NIFTY ASCENT workspaces">
      <div className="lbl na-rail-label">Workspaces</div>
      {WORKSPACES.map((w, i) => {
        const Icon = w.icon;
        return (
          <button key={w.id} className="na-navbtn" aria-current={tab === w.id ? "page" : undefined} onClick={() => go(w.id)} title={w.label}>
            <Icon size={17} weight={tab === w.id ? "fill" : "regular"} />
            <span>{w.label}</span>
            <span className="na-navkey">{i + 1}</span>
          </button>
        );
      })}
      <div className="na-rail-foot">
        <div className="lbl" style={{ marginBottom: 6 }}>Today</div>
        <div className="flex items-center justify-between text-[11.5px]"><span className="na-muted">Positions</span><b className="n">{e.positionsToday}/1</b></div>
        <div className="flex items-center justify-between text-[11.5px] mt-1"><span className="na-muted">Bot</span><b>{e.activeBot ? BOT_LABEL[e.activeBot] : "—"}</b></div>
        <div className="flex items-center justify-between text-[11.5px] mt-1"><span className="na-muted">Signal</span><b className="n">{e.signal ? `${e.signal.right} ${hm(e.signal.bar)}` : "—"}</b></div>
      </div>
    </nav>
  );
}

export default function NiftyAscent({ onExit }) {
  const [tab, setTab] = useState(tabFromPath);
  const [theme, setTheme] = useTheme();
  const topRef = useRef(null), rootRef = useRef(null);
  const go = (id) => {
    setTab(id);
    const url = `${BASE}/${id}`;
    if (window.location.pathname !== url) window.history.pushState({ na: id }, "", url);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (!window.location.pathname.startsWith(`${BASE}/`)) window.history.replaceState({ na: tab }, "", `${BASE}/${tab}`);
    const onPop = () => { if (window.location.pathname.startsWith(BASE)) setTab(tabFromPath()); };
    window.addEventListener("popstate", onPop);
    const onKey = (ev) => {
      if (ev.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const i = Number(ev.key);
      if (i >= 1 && i <= Math.min(9, WORKSPACES.length)) go(WORKSPACES[i - 1].id);
    };
    window.addEventListener("keydown", onKey);
    const prevTitle = document.title;
    document.title = "NIFTY ASCENT · thetalab";
    const stopLive = startLivePolling();
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("keydown", onKey); document.title = prevTitle; ascent.pause(); stopLive(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const el = topRef.current, root = rootRef.current;
    if (!el || !root) return;
    const ro = new ResizeObserver(() => root.style.setProperty("--na-top-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const S = useAscent();
  const W = WORKSPACES.find((w) => w.id === tab) ?? WORKSPACES[0];
  const C = W.C;
  const needsEngine = !["trade-journal", "analytics", "risk-settings", "backtest"].includes(W.id);
  const showEmpty = S.source === "LIVE" && !S.mirror && needsEngine;
  const btEmpty = S.source === "BACKTEST" && !S.bt.data && needsEngine;
  return (
    <div className="na-root" ref={rootRef}>
      <div className="na-top" ref={topRef}>
        <Header onExit={onExit} theme={theme} setTheme={setTheme} />
        {S.source === "LIVE" ? <LiveBand /> : S.source === "BACKTEST" ? <BacktestBand /> : <SimBand />}
      </div>
      <div className="na-shell">
        <Rail tab={tab} go={go} />
        <main className="na-main" id="na-main">
          <Suspense fallback={<div className="skeleton" style={{ height: 420, borderRadius: 14 }} />}>
            <div className="na-ws" key={`${tab}-${S.source}`}>{showEmpty ? <LiveEmpty /> : btEmpty ? <BacktestEmpty go={go} /> : <C go={go} />}</div>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
