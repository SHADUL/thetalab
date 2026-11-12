/**
 * NIFTY PULSE — 1-Second Options Intelligence.
 *
 * A self-contained trading-terminal workspace inside ThetaLab. Two sources:
 * LIVE PAPER (the server's paper engine on real NIFTY prices from the shared
 * Kite stream) and SIMULATION (deterministic replay in the browser). Paper
 * only in both: there is no order path. Address: /nifty-pulse/<workspace>.
 */
import { useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from "react";
import {
  ArrowLeft, Gauge, Broadcast, Cpu, Stack, Receipt, ChartBar, ShieldCheck, SlidersHorizontal,
  Play, Pause, ArrowCounterClockwise, Sun, Moon, Lock, Warning,
} from "@phosphor-icons/react";
import "./nifty-pulse.css";
import { pulse, usePulse } from "./store.js";
import { Pill, PulseGlyph, PulseWave } from "./ui.jsx";
import { istTime, secs } from "./format.js";
import CommandCenter from "./CommandCenter.jsx";

const LiveMarket = lazy(() => import("./LiveMarket.jsx"));
const StrategyEngine = lazy(() => import("./StrategyEngine.jsx"));
const SpreadBuilder = lazy(() => import("./SpreadBuilder.jsx"));
const PaperTrades = lazy(() => import("./PaperTrades.jsx"));
const Analytics = lazy(() => import("./Analytics.jsx"));
const RiskControl = lazy(() => import("./RiskControl.jsx"));
const Settings = lazy(() => import("./Settings.jsx"));

const WORKSPACES = [
  { id: "command-center", label: "Command Center", icon: Gauge, C: CommandCenter },
  { id: "live-market", label: "Live Market", icon: Broadcast, C: LiveMarket },
  { id: "strategy-engine", label: "Strategy Engine", icon: Cpu, C: StrategyEngine },
  { id: "spread-builder", label: "Spread Builder", icon: Stack, C: SpreadBuilder },
  { id: "paper-trades", label: "Paper Trades", icon: Receipt, C: PaperTrades },
  { id: "analytics", label: "Analytics", icon: ChartBar, C: Analytics },
  { id: "risk-control", label: "Risk Control", icon: ShieldCheck, C: RiskControl },
  { id: "settings", label: "Settings", icon: SlidersHorizontal, C: Settings },
];
const BASE = "/nifty-pulse";

function tabFromPath() {
  const seg = window.location.pathname.slice(BASE.length).replace(/^\/+/, "").split("/")[0];
  return WORKSPACES.some((w) => w.id === seg) ? seg : "command-center";
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("thetalab-theme") || "light"; } catch { return "light"; }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("thetalab-theme", theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, setTheme];
}

function feedPill(s) {
  if (s.mode !== "LIVE") return { tone: "warn", text: "NOT USED", title: "Simulation mode uses deterministic replay data; the Kite stream is not used." };
  const L = s.live;
  if (L.enabled === false || L.error) return { tone: "loss", text: "UNAVAILABLE", title: L.error ?? L.reason ?? "Live service not running" };
  if (L.enabled == null) return { tone: "warn", text: "CHECKING", title: "Contacting the live paper service" };
  const f = L.feed;
  if (!f) return { tone: "warn", text: "WAITING" };
  if (f.connected && f.indexQuote) return { tone: "gain", text: "CONNECTED", live: true, title: `Shared Kite stream · ${f.subscribed} instruments · ${f.reconnects} connects` };
  if (f.connected) return { tone: "warn", text: "NO NIFTY TICK", title: "Stream connected; waiting for the first NIFTY index price" };
  return { tone: s.marketOpen ? "loss" : undefined, text: s.marketOpen ? "DISCONNECTED" : "IDLE", title: f.lastError ? `Last error: ${f.lastError}` : "The shared stream connects 09:00–15:45 IST on trading days" };
}

function Header({ onExit, theme, setTheme }) {
  const s = usePulse((x) => x);
  const age = s.dataAgeMs;
  const feedTone = !s.sample ? "warn" : s.sample.status === "STALE" || s.sample.status === "NO_DATA" ? "loss" : "gain";
  const feedLabel = !s.sample ? "WAITING" : s.sample.status === "STALE" ? "STALE" : s.sample.status === "NO_DATA" ? "WAITING" : "FRESH";
  const riskTone = s.riskStatus === "OK" ? "gain" : s.riskStatus === "KILL" || s.riskStatus === "LIMIT" ? "loss" : "warn";
  const kite = feedPill(s);
  return (
    <header className="np-header">
      <button className="np-back" onClick={onExit} title="Return to ThetaLab">
        <ArrowLeft size={14} weight="bold" />
        <img src="/favicon.svg" alt="" width={14} height={14} />
        <b>theta<span className="text-accent">lab</span></b>
      </button>
      <div className="np-brand">
        <div className="np-mark"><PulseGlyph size={22} /></div>
        <div className="min-w-0">
          <div className="np-title">NIFTY <span>PULSE</span></div>
          <div className="np-sub">1-Second Options Intelligence</div>
        </div>
        <PulseWave />
      </div>
      <div className="np-pills" role="status" aria-live="off">
        <Pill k="Market" tone={s.marketOpen ? "gain" : undefined} live={s.marketOpen}>{s.marketOpen ? "OPEN" : "CLOSED"} · {s.tag}</Pill>
        <Pill k="Kite feed" tone={kite.tone} live={kite.live} title={kite.title}>{kite.text}</Pill>
        <Pill k="Data" tone={feedTone} live={feedTone === "gain"}>{feedLabel}{age != null ? ` · ${secs(age)}` : ""}</Pill>
        <Pill k="Engine" tone={s.running ? "accent" : "warn"} live={s.running}>{s.killSwitch ? "KILLED" : s.running ? "RUNNING" : "STOPPED"}</Pill>
        <Pill k="Mode" tone="accent"><Lock size={10} weight="bold" style={{ marginRight: 3, verticalAlign: -1 }} />PAPER ONLY</Pill>
        <Pill k="Risk" tone={riskTone}>{s.riskStatus}</Pill>
        <Pill k="Preset" optional title={s.config.description}>{s.config.name.replace("Strategy A — ", "A · ")}{s.config.immutable ? "" : ` v${s.config.version}`}</Pill>
      </div>
      <button className="np-icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}

function SourceSwitch({ mode }) {
  return (
    <div className="np-seg" role="group" aria-label="Data source">
      <button data-on={mode === "LIVE"} onClick={() => pulse.setSource("LIVE")} title="Server paper engine on real NIFTY prices">Live paper</button>
      <button data-on={mode === "SIMULATION"} onClick={() => pulse.setSource("SIMULATION")} title="Deterministic replay in this browser">Simulation</button>
    </div>
  );
}

function LiveBand() {
  const s = usePulse((x) => x);
  const L = s.live;
  const down = L.enabled === false || !!L.error;
  const ins = L.instruments;
  const rec = L.recorder;
  const st = L.store;
  return (
    <div className="np-simband np-liveband" data-down={down} role="note">
      <span className="np-simtag np-livetag">LIVE PAPER</span>
      {down ? (
        <span className="np-long"><Warning size={13} weight="fill" style={{ display: "inline-block", verticalAlign: -2, marginRight: 4 }} />
          {L.error ?? L.reason ?? "The live paper service is not running."} <span className="np-muted">Switch to Simulation to explore with replay data.</span></span>
      ) : (
        <>
          <span className="np-long">
            Real NIFTY prices from the shared Kite stream · every fill is a <b>paper fill</b> — no order is ever sent
            {ins?.expiry ? <> · expiry <b className="n">{ins.expiry}</b> · lot <b className="n">{ins.lotSize}</b></> : null}
          </span>
          <span className="np-short">Real prices · <b>paper fills only</b></span>
        </>
      )}
      <span className="n np-muted">{s.now ? `${istTime(s.now)} IST` : ""}</span>
      {L.notice && <span className="np-loss" style={{ fontSize: 12 }}>{L.notice}</span>}
      <div className="np-simctl">
        {!down && <span className="np-faint" style={{ fontSize: 11.5 }} title={rec?.paused ?? undefined}>
          Recorder {rec?.enabled ? (rec.recording ? `on · ${rec.totalMb} MB` : "paused") : "off"} · Storage {st?.enabled ? (st.migrationApplied === false ? "migration not applied" : st.migrationApplied ? "on" : "…") : "off"}
        </span>}
        <SourceSwitch mode={s.mode} />
      </div>
    </div>
  );
}

const SPEEDS = [1, 5, 20, 60];
const JUMPS = ["09:15", "10:30", "12:00", "13:30", "15:00"];

function SimBand() {
  const s = usePulse((x) => x);
  return (
    <div className="np-simband" role="note">
      <span className="np-simtag">SIMULATION</span>
      <span className="np-long">
        Deterministic replay · seed <b className="n">{s.seed}</b> · synthetic NIFTY prices, ticks and option quotes — <b>not market data</b>. Paper execution only.
      </span>
      <span className="np-short">Synthetic data — <b>not market data</b> · paper only</span>
      <span className="n np-muted">SIM {istTime(s.now)} IST</span>
      <div className="np-simctl">
        <button className="np-chipbtn" onClick={() => (s.playing ? pulse.pause() : pulse.play())} disabled={s.done} aria-label={s.playing ? "Pause replay" : "Play replay"}>
          {s.playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}{s.playing ? "Pause" : s.done ? "Session ended" : "Play"}
        </button>
        <div className="np-seg" role="group" aria-label="Replay speed">
          {SPEEDS.map((x) => <button key={x} data-on={s.speed === x} onClick={() => pulse.setSpeed(x)}>{x}×</button>)}
        </div>
        <select className="np-chipbtn" aria-label="Jump to time" value="" onChange={(e) => e.target.value && pulse.jumpTo(e.target.value)}>
          <option value="">Jump to…</option>
          {JUMPS.map((j) => <option key={j} value={j}>{j} IST</option>)}
        </select>
        <button className="np-chipbtn" onClick={() => pulse.restart(s.seed)} title="Restart the session from 09:15"><ArrowCounterClockwise size={13} />Restart</button>
        <button className="np-chipbtn" onClick={() => pulse.restart(s.seed + 1)} title="New synthetic session with the next seed">Seed +1</button>
        <SourceSwitch mode={s.mode} />
      </div>
    </div>
  );
}

function Band() {
  const mode = usePulse((x) => x.mode);
  return mode === "LIVE" ? <LiveBand /> : <SimBand />;
}

function Rail({ tab, go }) {
  const s = usePulse((x) => x);
  return (
    <nav className="np-rail" aria-label="NIFTY PULSE workspaces">
      <div className="lbl np-rail-label">Workspaces</div>
      {WORKSPACES.map((w, i) => {
        const Icon = w.icon;
        return (
          <button key={w.id} className="np-navbtn" aria-current={tab === w.id ? "page" : undefined} onClick={() => go(w.id)} title={w.label}>
            <Icon size={17} weight={tab === w.id ? "fill" : "regular"} />
            <span>{w.label}</span>
            <span className="np-navkey">{i + 1}</span>
          </button>
        );
      })}
      <div className="np-rail-foot">
        <div className="lbl" style={{ marginBottom: 6 }}>Risk today</div>
        <div className="flex items-center justify-between text-[11.5px]"><span className="np-muted">Trades</span><b className="n">{s.tradesToday}/{s.config.maxTradesPerDay}</b></div>
        <div className="flex items-center justify-between text-[11.5px] mt-1"><span className="np-muted">Loss used</span><b className="n">₹{Math.round(s.lossUsed).toLocaleString("en-IN")}/{(s.config.maxDailyLoss / 1000).toFixed(0)}k</b></div>
        <div className="flex items-center justify-between text-[11.5px] mt-1"><span className="np-muted">Position</span><b className="n">{s.position ? s.position.id.replace(/^NP-(SIM-)?/, "#") : "Flat"}</b></div>
      </div>
    </nav>
  );
}

export default function NiftyPulse({ onExit }) {
  const [tab, setTab] = useState(tabFromPath);
  const [theme, setTheme] = useTheme();
  const topRef = useRef(null);
  const rootRef = useRef(null);

  const go = (id) => {
    setTab(id);
    const url = `${BASE}/${id}`;
    if (window.location.pathname !== url) window.history.pushState({ np: id }, "", url);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (!window.location.pathname.startsWith(`${BASE}/`)) window.history.replaceState({ np: tab }, "", `${BASE}/${tab}`);
    const onPop = () => { if (window.location.pathname.startsWith(BASE)) setTab(tabFromPath()); };
    window.addEventListener("popstate", onPop);
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = Number(e.key);
      if (i >= 1 && i <= WORKSPACES.length) go(WORKSPACES[i - 1].id);
    };
    window.addEventListener("keydown", onKey);
    const prevTitle = document.title;
    document.title = "NIFTY PULSE · thetalab";
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("keydown", onKey); document.title = prevTitle; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sticky offsets follow the real header height (it wraps on small screens).
  useLayoutEffect(() => {
    const el = topRef.current, root = rootRef.current;
    if (!el || !root) return;
    const ro = new ResizeObserver(() => root.style.setProperty("--np-top-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = WORKSPACES.find((w) => w.id === tab) ?? WORKSPACES[0];
  const C = W.C;
  return (
    <div className="np-root" ref={rootRef}>
      <div className="np-top" ref={topRef}>
        <Header onExit={onExit} theme={theme} setTheme={setTheme} />
        <Band />
      </div>
      <div className="np-shell">
        <Rail tab={tab} go={go} />
        <main className="np-main" id="np-main">
          <Suspense fallback={<div className="skeleton" style={{ height: 420, borderRadius: 14 }} />}>
            <div className="np-ws" key={tab}><C go={go} /></div>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
