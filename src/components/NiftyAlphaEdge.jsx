import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lightning, Target, Clock, ShieldCheck, Power, Gear, X, ArrowUpRight, ArrowDownRight, Pulse, Lock,
  Warning, CheckCircle, Hourglass, ChartLineUp, Waveform, CaretRight,
} from "@phosphor-icons/react";
import { inr } from "./swingFormat.js";

// Nifty Alpha Edge (hedged131) — weekly order-flow-directed vertical
// credit spread. Reads one consolidated summary from the API; every action
// (settings, AUTO enable, close, kill switch) goes through its own guarded
// endpoint. AUTO can only be switched on with a typed confirmation.

const API = "/api/options-autotrade";
// The page's --oat-* tokens are scoped to .oat-page; portalled UI (the
// settings drawer) lives outside it and needs them passed explicitly.
const OAT_VARS = { "--oat-accent": "#5A55F7", "--oat-accent-2": "#6A63FF", "--oat-blue": "#3B82F6", "--oat-hairline": "rgba(20, 30, 55, 0.07)" };
const POLL_MS = 20_000;
const EASE = [0.2, 0.8, 0.2, 1];

const dirLabel = (d) => (d > 0 ? "BULLISH" : d < 0 ? "BEARISH" : "—");
const dirTone = (d) => (d > 0 ? "var(--c-gain)" : d < 0 ? "var(--c-loss)" : "var(--c-muted)");
const signed = (n) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${inr(Math.abs(n))}`);
const pts = (n, dp = 2) => (n == null ? "—" : Number(n).toFixed(dp));

function istNow() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, h: Number(g("hour")) % 24, m: Number(g("minute")), s: Number(g("second")), wd: g("weekday") };
}

/** Milliseconds until the next Wednesday 09:31 IST signal window (0 while a window is open). */
function msToNextWindow() {
  const n = istNow();
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = order.indexOf(n.wd);
  const minutes = n.h * 60 + n.m;
  if (today === 3 && minutes >= 571 && minutes <= 871) return 0;
  let days = (3 - today + 7) % 7;
  if (days === 0 && minutes > 871) days = 7;
  const secondsToday = n.h * 3600 + n.m * 60 + n.s;
  return (days * 86400 + 571 * 60 - secondsToday) * 1000;
}

function fmtDuration(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function useTicker(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

// ------------------------------------------------------------------ primitives

function Card({ title, icon: Icon, right, children, className = "", delay = 0 }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE, delay }}
      className={`oat-glass rounded-[var(--radius-lg)] p-4 sm:p-5 ${className}`}
    >
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <div className="flex items-center gap-2">
            {Icon && <span className="flex items-center justify-center rounded-[8px]" style={{ width: 26, height: 26, background: "var(--c-accent-soft)", color: "var(--oat-accent)" }}><Icon size={14} weight="bold" /></span>}
            <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
          </div>
          {right}
        </div>
      )}
      {children}
    </motion.section>
  );
}

function Pill({ tone = "neutral", children, icon: Icon }) {
  const tones = {
    gain: { bg: "var(--c-gain-soft)", fg: "var(--c-gain)" },
    loss: { bg: "var(--c-loss-soft)", fg: "var(--c-loss)" },
    warn: { bg: "var(--c-warn-soft)", fg: "var(--c-warn)" },
    accent: { bg: "var(--c-accent-soft)", fg: "var(--oat-accent)" },
    neutral: { bg: "var(--c-surface-3)", fg: "var(--c-text-2)" },
  }[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10.5px] font-semibold tracking-wide whitespace-nowrap" style={{ background: tones.bg, color: tones.fg }}>
      {Icon && <Icon size={11} weight="bold" />}{children}
    </span>
  );
}

function Stat({ label, value, tone, sub }) {
  const color = tone === "gain" ? "var(--c-gain)" : tone === "loss" ? "var(--c-loss)" : "var(--c-text)";
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-1">{label}</div>
      <div className="font-display text-[19px] sm:text-[21px] font-bold n leading-none truncate" style={{ color }}>{value}</div>
      {sub && <div className="text-[10.5px] text-faint mt-1 truncate">{sub}</div>}
    </div>
  );
}

function Toggle({ on, onClick, disabled, label }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-pressed={on} aria-label={label}
      className="relative shrink-0 rounded-full transition-colors"
      style={{ width: 36, height: 20, background: on ? "var(--oat-accent)" : "var(--c-line-2)", opacity: disabled ? 0.45 : 1 }}>
      <motion.span layout transition={{ duration: 0.2, ease: EASE }} className="absolute top-[2px] rounded-full bg-white"
        style={{ width: 16, height: 16, left: on ? 18 : 2, boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
    </button>
  );
}

// ------------------------------------------------------------------ payoff chart

function PayoffChart({ curve, position, spot }) {
  const W = 640, H = 220, pad = { l: 8, r: 8, t: 14, b: 26 };
  const view = useMemo(() => {
    if (!curve?.length) return null;
    const xs = curve.map((p) => p.spot), ys = curve.map((p) => p.pnl);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0);
    const span = maxY - minY || 1;
    const x = (v) => pad.l + ((v - minX) / (maxX - minX)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - (minY - span * 0.08)) / (span * 1.16)) * (H - pad.t - pad.b);
    const line = curve.map((p, i) => `${i ? "L" : "M"}${x(p.spot).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(" ");
    const zero = y(0);
    const area = `${line} L${x(maxX).toFixed(1)},${zero.toFixed(1)} L${x(minX).toFixed(1)},${zero.toFixed(1)} Z`;
    return { x, y, line, area, zero, minX, maxX, maxY, minY };
  }, [curve]);
  if (!view) return null;
  const atm = Number(position.atm), be = Number(position.breakeven);
  const wing = atm + (position.direction < 0 ? 1 : -1) * Number(position.wing_points);
  const inRange = (v) => v >= view.minX && v <= view.maxX;
  const marker = (v, label, color, dash, top = false) => inRange(v) && (
    <g key={label}>
      <line x1={view.x(v)} x2={view.x(v)} y1={pad.t} y2={H - pad.b} stroke={color} strokeWidth="1" strokeDasharray={dash ? "3 3" : undefined} opacity="0.75" />
      <text x={view.x(v)} y={top ? pad.t + 24 : H - 9} textAnchor="middle" fontSize="10" fill={color} fontWeight="600"
        stroke="var(--c-surface-2)" strokeWidth={top ? 3 : 0} paintOrder="stroke">{label}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Payoff at expiry">
      <defs>
        <clipPath id="ane-above"><rect x="0" y="0" width={W} height={view.zero} /></clipPath>
        <clipPath id="ane-below"><rect x="0" y={view.zero} width={W} height={H - view.zero} /></clipPath>
        <linearGradient id="ane-gain" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--c-gain)" stopOpacity="0.28" /><stop offset="100%" stopColor="var(--c-gain)" stopOpacity="0.02" /></linearGradient>
        <linearGradient id="ane-loss" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stopColor="var(--c-loss)" stopOpacity="0.26" /><stop offset="100%" stopColor="var(--c-loss)" stopOpacity="0.02" /></linearGradient>
      </defs>
      <path d={view.area} fill="url(#ane-gain)" clipPath="url(#ane-above)" />
      <path d={view.area} fill="url(#ane-loss)" clipPath="url(#ane-below)" />
      <line x1={pad.l} x2={W - pad.r} y1={view.zero} y2={view.zero} stroke="var(--c-line-2)" strokeWidth="1" />
      <path d={view.line} fill="none" stroke="var(--oat-accent)" strokeWidth="2" strokeLinejoin="round" />
      {marker(atm, `ATM ${atm}`, "var(--c-text-2)", true)}
      {marker(wing, `Wing ${wing}`, "var(--c-muted)", true)}
      {Number.isFinite(be) && marker(be, `BE ${be.toFixed(0)}`, "var(--c-warn)", true, true)}
      {spot && inRange(spot) && (
        <g>
          <line x1={view.x(spot)} x2={view.x(spot)} y1={pad.t} y2={H - pad.b} stroke="var(--oat-accent)" strokeWidth="1.5" />
          <circle cx={view.x(spot)} cy={pad.t + 2} r="4" fill="var(--oat-accent)" />
          <text x={view.x(spot) + 6} y={pad.t + 6} fontSize="10" fill="var(--oat-accent)" fontWeight="700">NIFTY {spot.toFixed(0)}</text>
        </g>
      )}
      <text x={W - pad.r} y={view.y(view.maxY) - 4} textAnchor="end" fontSize="10" fill="var(--c-gain)" fontWeight="600">max gain {inr(view.maxY)}</text>
      <text x={W - pad.r} y={view.y(view.minY) + 12} textAnchor="end" fontSize="10" fill="var(--c-loss)" fontWeight="600">max loss {inr(Math.abs(view.minY))}</text>
    </svg>
  );
}

// ------------------------------------------------------------------ cards

function SignalCard({ signal, decision }) {
  if (!signal) {
    return (
      <Card title="This week's signal" icon={Lightning} delay={0.05}>
        <div className="flex items-start gap-3">
          <Hourglass size={22} className="text-faint shrink-0 mt-0.5" />
          <div className="text-[12px] text-ink2 leading-relaxed">
            No signal yet this week. The order-flow engine evaluates every minute on <b>Wednesday 09:31–14:31 IST</b> and fires once G2 crosses ±9.0, or at the 14:30 cutoff.
          </div>
        </div>
      </Card>
    );
  }
  const D = decision?.direction ?? signal.final_direction;
  const steps = [
    { k: "Large orders (d1)", v: dirLabel(signal.d1), c: dirTone(signal.d1), sub: `A1 ${Math.round(Number(signal.area1)).toLocaleString("en-IN")}` },
    { k: "Imbalance (d2)", v: dirLabel(signal.d2), c: dirTone(signal.d2), sub: `G2 ${Number(signal.g2_at_signal).toFixed(2)} · ${signal.path}` },
    { k: "Alignment", v: signal.alpha === 1 ? "ALIGNED → fade" : "DIVERGENT → follow G1", c: "var(--c-text)", sub: `base ${dirLabel(signal.base_direction)}` },
    { k: "Variation C", v: decision?.variationCActed ? "FLIPPED to bearish" : "no change", c: decision?.variationCActed ? "var(--c-warn)" : "var(--c-text-2)", sub: decision?.vixAvailable ? `VIX ${Number(decision.vix).toFixed(2)} (cut-off 12.5)` : "VIX unavailable — inert" },
  ];
  const instant = signal.signal_instant ? new Date(signal.signal_instant).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <Card title="This week's signal" icon={Lightning} delay={0.05} right={<Pill tone="accent" icon={CheckCircle}>FIRED {instant}</Pill>}>
      <div className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <motion.div key={s.k} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 * i, duration: 0.3, ease: EASE }}
            className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2" style={{ background: "var(--c-surface-2)" }}>
            <div className="min-w-0">
              <div className="text-[10.5px] text-muted">{s.k}</div>
              <div className="text-[10px] text-faint n truncate">{s.sub}</div>
            </div>
            <div className="text-[12px] font-bold text-right" style={{ color: s.c }}>{s.v}</div>
          </motion.div>
        ))}
      </div>
      <div className="mt-3.5 flex items-center justify-between rounded-[12px] px-3.5 py-3" style={{ background: D > 0 ? "var(--c-gain-soft)" : "var(--c-loss-soft)" }}>
        <span className="text-[11px] font-semibold text-muted tracking-wide">WEEK DIRECTION</span>
        <span className="flex items-center gap-1.5 font-display text-[20px] font-bold" style={{ color: dirTone(D) }}>
          {D > 0 ? <ArrowUpRight size={20} weight="bold" /> : <ArrowDownRight size={20} weight="bold" />}{dirLabel(D)}
        </span>
      </div>
      <div className="text-[10.5px] text-faint mt-2">Fixed for the week — never re-evaluated after publication.</div>
    </Card>
  );
}

function EngineCard({ engine }) {
  const pct = (n) => Math.min(100, (n / engine.warmup.target) * 100);
  const ready = engine.warmup.bid >= engine.warmup.target && engine.warmup.ask >= engine.warmup.target;
  const w = engine.worker;
  const fresh = w && Date.now() - Date.parse(w.updated_at) < 3 * 60_000;
  return (
    <Card title="Signal engine" icon={Waveform} delay={0.1} right={<Pill tone={fresh && w.status === "HEALTHY" ? "gain" : "neutral"} icon={Pulse}>{fresh ? w.status : "OFFLINE"}</Pill>}>
      <div className="flex flex-col gap-3">
        {[["BID", engine.warmup.bid], ["ASK", engine.warmup.ask]].map(([k, v]) => (
          <div key={k}>
            <div className="flex items-center justify-between text-[10.5px] mb-1">
              <span className="text-muted font-semibold">G1 warm-up · {k}</span>
              <span className="n text-ink2">{Number(v).toLocaleString("en-IN")} / 150,000</span>
            </div>
            <div className="h-[6px] rounded-full overflow-hidden" style={{ background: "var(--c-surface-3)" }}>
              <motion.div initial={{ width: 0 }} animate={{ width: `${pct(v)}%` }} transition={{ duration: 0.8, ease: EASE }} className="h-full rounded-full"
                style={{ background: pct(v) >= 100 ? "var(--c-gain)" : "linear-gradient(90deg, var(--oat-accent), var(--oat-accent-2))" }} />
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between text-[11px] pt-1">
          <span className="text-muted">Large-order classifier</span>
          <span className="font-semibold" style={{ color: ready ? "var(--c-gain)" : "var(--c-warn)" }}>{ready ? "ACTIVE" : "WARMING UP"}</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted">Today's session</span>
          <span className="font-semibold" style={{ color: engine.sessionQuality === "VALID" ? "var(--c-gain)" : "var(--c-loss)" }}>{engine.sessionQuality === "VALID" ? "VALID" : "INVALID FOR NEW SIGNAL"}</span>
        </div>
        {engine.sessionReason && <div className="text-[10.5px] text-faint">{engine.sessionReason}</div>}
        <div className="text-[10.5px] text-faint">Shared with Nifty Alpha Ladder — one NIFTY-futures depth feed, one weekly decision.</div>
      </div>
    </Card>
  );
}

function PositionCard({ position, payoff, live, onClose, closing }) {
  if (!position) {
    return (
      <Card title="Position" icon={ChartLineUp}>
        <div className="flex flex-col items-center text-center py-8 gap-2">
          <ChartLineUp size={30} className="text-faint" />
          <div className="text-[13px] font-semibold text-ink2">No position this week</div>
          <div className="text-[11.5px] text-faint max-w-[340px]">When the weekly signal fires, a 200-point vertical credit spread opens on the next weekly expiry: the protective wing first, then the ATM short.</div>
        </div>
      </Card>
    );
  }
  const open = ["ACTIVE", "EXITING", "ENTERING"].includes(position.status);
  const pnl = open ? Number(position.unrealized_pnl ?? 0) : Number(position.realized_pnl ?? 0);
  const statusTone = { ACTIVE: "gain", EXITING: "warn", ENTERING: "accent", CLOSED: "neutral", FAILED: "loss", CLOSE_FAILED: "loss", RECONCILIATION_REQUIRED: "loss" }[position.status] ?? "neutral";
  return (
    <Card title="Position" icon={ChartLineUp}
      right={<div className="flex items-center gap-1.5"><Pill tone={position.mode === "AUTO" ? "loss" : "accent"}>{position.mode}</Pill><Pill tone={statusTone}>{position.status.replace("_", " ")}</Pill></div>}>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <div className="font-display text-[17px] font-bold flex items-center gap-2" style={{ color: dirTone(position.direction) }}>
            {position.direction > 0 ? <ArrowUpRight size={18} weight="bold" /> : <ArrowDownRight size={18} weight="bold" />}{position.structure}
          </div>
          <div className="text-[11px] text-faint mt-0.5 n">Expiry {position.expiry} · {position.units} unit{position.units === 1 ? "" : "s"} × lot {position.lot_size} = {position.quantity} qty</div>
        </div>
        <div className="sm:text-right">
          <div className="text-[10.5px] text-muted font-semibold tracking-wide">{open ? "UNREALIZED" : "REALIZED"}</div>
          <div className="font-display text-[26px] font-bold n leading-none" style={{ color: pnl >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{signed(pnl)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Credit" value={`${pts(position.credit_points)} pts`} />
        <Stat label="Max gain" value={inr(position.max_gain ?? 0)} tone="gain" />
        <Stat label="Max loss" value={inr(position.max_loss ?? 0)} tone="loss" />
        <Stat label="Break-even" value={pts(position.breakeven, 1)} />
      </div>
      {payoff && <div className="rounded-[12px] p-2 mb-4" style={{ background: "var(--c-surface-2)" }}><PayoffChart curve={payoff} position={position} spot={open ? live?.spot : null} /></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px] n">
          <thead><tr className="text-[10px] text-muted text-left">
            <th className="font-semibold py-1.5">#</th><th className="font-semibold">Leg</th><th className="font-semibold">Contract</th>
            <th className="font-semibold text-right">Entry</th><th className="font-semibold text-right">LTP</th><th className="font-semibold text-right">Exit</th>
          </tr></thead>
          <tbody>
            {(position.legs ?? []).map((l) => (
              <tr key={l.id} style={{ borderTop: "1px solid var(--oat-hairline)" }}>
                <td className="py-2 text-faint">{l.leg_index + 1}</td>
                <td><span className="font-bold" style={{ color: l.side === "BUY" ? "var(--c-gain)" : "var(--c-loss)" }}>{l.side}</span> <span className="text-faint">{l.side === "BUY" ? "wing" : "short"}</span></td>
                <td className="font-medium">{l.strike} {l.option_right}</td>
                <td className="text-right">{pts(l.entry_fill)}</td>
                <td className="text-right text-ink2">{pts(l.last_price)}</td>
                <td className="text-right">{pts(l.exit_fill)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {position.status === "ACTIVE" && (
        <div className="flex justify-end mt-4">
          <button onClick={() => onClose(position)} disabled={closing} className="topstep" style={{ color: "var(--c-loss)", borderColor: "var(--c-loss-soft)" }}>
            <X size={12} weight="bold" />{closing ? "Closing…" : position.mode === "AUTO" ? "Close now (real orders)" : "Close now"}
          </button>
        </div>
      )}
    </Card>
  );
}

function MonitorCard({ position, live }) {
  useTicker(1000);
  if (!position || !["ACTIVE", "EXITING"].includes(position.status)) return null;
  const n = istNow();
  const wdTarget = n.wd === "Mon" || n.wd === "Tue" ? 400 : 300;
  const f0 = Number(position.f0);
  const target = f0 + position.direction * wdTarget;
  const fut = live?.future ?? (position.last_future ? Number(position.last_future) : null);
  const travelled = fut ? Math.max(0, Math.min(wdTarget, position.direction * (fut - f0))) : 0;
  const pct = (travelled / wdTarget) * 100;
  const exitAt = Date.parse(`${position.expiry}T15:10:00+05:30`);
  return (
    <Card title="Exit monitor" icon={Target} delay={0.05}
      right={<Pill tone="neutral" icon={Clock}>Scheduled exit in {fmtDuration(exitAt - Date.now())}</Pill>}>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="F0 (entry future)" value={f0.toFixed(1)} sub={position.future_symbol} />
        <Stat label="Current future" value={fut ? fut.toFixed(1) : "—"} tone={fut ? (position.direction * (fut - f0) >= 0 ? "gain" : "loss") : undefined} sub={fut ? `${position.direction * (fut - f0) >= 0 ? "+" : ""}${(position.direction * (fut - f0)).toFixed(1)} pts in favour` : ""} />
        <Stat label={`Target (${wdTarget} pts)`} value={target.toFixed(1)} sub={wdTarget === 400 ? "Mon/Tue distance" : "Wed–Fri distance"} />
      </div>
      <div className="h-[10px] rounded-full overflow-hidden" style={{ background: "var(--c-surface-3)" }}>
        <motion.div animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: EASE }} className="h-full rounded-full"
          style={{ background: "linear-gradient(90deg, var(--oat-accent), var(--c-gain))" }} />
      </div>
      <div className="flex items-center justify-between text-[10.5px] text-faint mt-1.5">
        <span>{travelled.toFixed(0)} / {wdTarget} pts toward target</span>
        <span>No stop — loss is capped by the spread width</span>
      </div>
    </Card>
  );
}

function HistoryCard({ positions }) {
  const rows = positions.filter((p) => p.status !== "ENTERING");
  return (
    <Card title="Weekly history" icon={Clock} delay={0.1}>
      {rows.length === 0 ? <div className="text-[11.5px] text-faint py-4">No weeks traded yet.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px] n">
            <thead><tr className="text-[10px] text-muted text-left">
              <th className="font-semibold py-1.5">Week</th><th className="font-semibold">Mode</th><th className="font-semibold">Direction</th>
              <th className="font-semibold">Structure</th><th className="font-semibold text-right">Credit</th><th className="font-semibold pl-4">Outcome</th><th className="font-semibold text-right">P&L</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const v = p.status === "CLOSED" ? Number(p.realized_pnl ?? 0) : p.status === "ACTIVE" || p.status === "EXITING" ? Number(p.unrealized_pnl ?? 0) : null;
                return (
                  <tr key={p.id} className="oat-row" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
                    <td className="py-2">{p.week_key}</td>
                    <td><Pill tone={p.mode === "AUTO" ? "loss" : "accent"}>{p.mode}</Pill></td>
                    <td className="font-semibold" style={{ color: dirTone(p.direction) }}>{dirLabel(p.direction)}</td>
                    <td className="text-ink2">{p.status === "FAILED" ? "—" : p.structure}</td>
                    <td className="text-right">{pts(p.credit_points)}</td>
                    <td className="text-[10.5px] text-muted pl-4">{p.status === "CLOSED" ? (p.exit_reason ?? "").replace("_", " ") : p.status === "FAILED" ? `skipped: ${p.exit_reason ?? ""}` : p.status}</td>
                    <td className="text-right font-semibold" style={{ color: v == null ? "var(--c-faint)" : v >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{v == null ? "—" : signed(v)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ActivityCard({ events }) {
  const tone = { error: "var(--c-loss)", warn: "var(--c-warn)", info: "var(--oat-accent)" };
  return (
    <Card title="Activity" icon={Pulse} delay={0.15}>
      {events.length === 0 ? <div className="text-[11.5px] text-faint py-4">Nothing yet.</div> : (
        <ol className="relative flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-1">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="mt-1.5 shrink-0 rounded-full" style={{ width: 7, height: 7, background: tone[e.level] ?? "var(--c-muted)" }} />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[10px] text-faint n">
                  <span>{new Date(e.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  {e.mode && <span className="font-semibold">{e.mode}</span>}
                  <span>{e.kind.replaceAll("_", " ")}</span>
                </div>
                <div className="text-[11.5px] text-ink2 leading-snug">{e.message}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ settings

function SettingsDrawer({ open, onClose, row, onSaved }) {
  const [draft, setDraft] = useState(row ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [typed, setTyped] = useState("");
  useEffect(() => { setDraft(row ?? {}); setError(null); setConfirmAuto(false); setTyped(""); }, [row, open]);

  const save = (extra = {}) => {
    setSaving(true); setError(null);
    fetch(`${API}?resource=alpha-edge-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      shadow_enabled: !!draft.shadow_enabled, shadow_capital: Number(draft.shadow_capital), auto_capital: Number(draft.auto_capital),
      active_broker: draft.active_broker, unit_budget: Number(draft.unit_budget), kill_switch: !!draft.kill_switch, auto_enabled: !!draft.auto_enabled, ...extra,
    }) })
      .then((r) => r.json())
      .then((b) => { if (b.error) { setError(b.message || b.error); return; } onSaved(); onClose(); })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };
  const wantsAutoOn = !!draft.auto_enabled && !row?.auto_enabled;
  const field = (k, label, hint) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-ink2">{label}</span>
      <input type="number" value={draft[k] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
        className="px-3 py-2 rounded-[10px] n text-[13px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }} />
      {hint && <span className="text-[10.5px] text-faint">{hint}</span>}
    </label>
  );
  const units = (cap) => Math.floor((Number(cap) || 0) / (Number(draft.unit_budget) || 125000));

  // Portalled to <body>: the page wrapper isolates its stacking context
  // (for the glass/atmosphere layers), which would otherwise trap this
  // drawer underneath the app's top bar.
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-40" style={{ background: "rgba(15,23,41,.28)" }} />
          <motion.aside initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.32, ease: EASE }}
            className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[420px] overflow-y-auto p-5 flex flex-col gap-5"
            style={{ ...OAT_VARS, background: "var(--c-surface)", boxShadow: "-20px 0 50px rgba(15,23,41,.12)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[17px] font-bold">Strategy settings</h2>
              <button onClick={onClose} aria-label="Close settings" className="text-muted"><X size={18} /></button>
            </div>

            <div className="rounded-[14px] p-4 flex flex-col gap-3" style={{ background: "var(--c-surface-2)" }}>
              <div className="flex items-center justify-between">
                <div><div className="text-[13px] font-semibold">SHADOW</div><div className="text-[10.5px] text-faint">Simulated fills against live quotes. Never touches the broker.</div></div>
                <Toggle on={!!draft.shadow_enabled} onClick={() => setDraft((d) => ({ ...d, shadow_enabled: !d.shadow_enabled }))} label="SHADOW enabled" />
              </div>
              {field("shadow_capital", "SHADOW allocation (₹)", `${units(draft.shadow_capital)} unit(s) at ₹${Number(draft.unit_budget || 125000).toLocaleString("en-IN")} each — fixed, never your real balance`)}
            </div>

            <div className="rounded-[14px] p-4 flex flex-col gap-3" style={{ background: "var(--c-loss-soft)" }}>
              <div className="flex items-center justify-between">
                <div><div className="text-[13px] font-semibold flex items-center gap-1.5"><Lock size={13} weight="bold" />AUTO — real orders</div><div className="text-[10.5px] text-faint">Places real orders on your broker account.</div></div>
                <Toggle on={!!draft.auto_enabled} onClick={() => setDraft((d) => ({ ...d, auto_enabled: !d.auto_enabled }))} label="AUTO enabled" />
              </div>
              {field("auto_capital", "AUTO allocation (₹)", `${units(draft.auto_capital)} unit(s); 0 sizes to zero (no orders)`)}
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-ink2">Broker</span>
                <div className="seg-track">
                  {["KITE", "GROWW"].map((b) => (
                    <button key={b} className="seg flex-1" data-on={draft.active_broker === b} onClick={() => setDraft((d) => ({ ...d, active_broker: b }))}>{b}</button>
                  ))}
                </div>
              </label>
              {wantsAutoOn && (
                <div className="rounded-[10px] p-3 flex flex-col gap-2" style={{ background: "var(--c-surface)", border: "1px solid var(--c-loss)" }}>
                  <div className="flex items-start gap-2 text-[11px] text-ink2"><Warning size={15} className="shrink-0 mt-px" style={{ color: "var(--c-loss)" }} />
                    <p>Enabling AUTO lets this strategy place real orders on {draft.active_broker}: a protective BUY then an ATM SELL each signal week, and closing orders at exit. Type <b>ENABLE AUTO</b> to confirm.</p></div>
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="ENABLE AUTO" className="px-3 py-2 rounded-[8px] text-[12.5px] font-semibold tracking-wide" style={{ border: "1px solid var(--c-line)" }} />
                </div>
              )}
            </div>

            {field("unit_budget", "Capital per unit (₹)", "θ39 — the document's default is ₹1,25,000 per spread unit")}

            {error && <div className="text-[11.5px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
            <div className="flex gap-2 mt-auto">
              <button onClick={onClose} className="topstep flex-1 justify-center" style={{ height: 38 }}>Cancel</button>
              <button onClick={() => save(wantsAutoOn ? { confirm: typed.trim() } : {})} disabled={saving || (wantsAutoOn && typed.trim() !== "ENABLE AUTO")}
                className="flex-1 rounded-[8px] text-[12.5px] font-semibold text-white" style={{ height: 38, background: "var(--oat-accent)", opacity: saving || (wantsAutoOn && typed.trim() !== "ENABLE AUTO") ? 0.5 : 1 }}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ------------------------------------------------------------------ page

export default function NiftyAlphaEdge() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState(null);
  useTicker(1000);

  const load = useCallback(() => {
    fetch(`${API}?resource=alpha-edge-summary`).then((r) => r.json())
      .then((b) => { if (b.error) setError(b.message || b.error); else { setError(null); setData(b); } })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);

  const closePosition = (p) => {
    const msg = p.mode === "AUTO"
      ? `Close ${p.structure} now with REAL orders on ${p.broker}? The short is bought back first, then the wing is sold.`
      : `Close this SHADOW ${p.structure} now at the live touch?`;
    if (!window.confirm(msg)) return;
    setClosing(true);
    fetch(`${API}?resource=alpha-edge-close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positionId: p.id }) })
      .then((r) => r.json()).then((b) => setNotice(b.message || (b.ok ? "Exit submitted." : "Exit failed.")))
      .catch((e) => setNotice(e.message)).finally(() => { setClosing(false); load(); });
  };
  const kill = () => {
    if (!window.confirm("Engage the kill switch? No new entries and AUTO is disabled. Open positions continue to be managed and exited.")) return;
    fetch(`${API}?resource=alpha-edge-kill`, { method: "POST" }).then(() => load());
  };
  const resume = () => {
    fetch(`${API}?resource=alpha-edge-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kill_switch: false }) }).then(() => load());
  };

  if (data?.needsMigration) {
    return (
      <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-8">
        <Card title="Setup required" icon={Warning}>
          <div className="text-[12.5px] text-ink2">Run <code className="n">src/nifty-alpha-edge/migrations/001_alpha_edge_schema.sql</code> in the Supabase SQL editor, then reload.</div>
        </Card>
      </div>
    );
  }

  const s = data?.settings;
  const positions = data?.positions ?? [];
  const closed = positions.filter((p) => p.status === "CLOSED");
  const realized = closed.reduce((a, p) => a + Number(p.realized_pnl ?? 0), 0);
  const wins = closed.filter((p) => Number(p.realized_pnl) > 0).length;
  const active = data?.active ?? null;
  const focus = data?.focus ?? null;
  const weekPnl = active ? Number(active.unrealized_pnl ?? 0) : null;
  const nextWindow = msToNextWindow();

  const status = active ? { label: active.status === "EXITING" ? "EXITING" : "POSITION LIVE", tone: "gain", icon: Pulse }
    : data?.signal ? { label: "SIGNAL FIRED", tone: "accent", icon: Lightning }
      : nextWindow === 0 ? { label: "EVALUATING", tone: "warn", icon: Waveform }
        : { label: `NEXT WINDOW IN ${fmtDuration(nextWindow)}`, tone: "neutral", icon: Hourglass };

  return (
    <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-5 sm:py-7">
      {/* Hero */}
      <motion.header initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}
        className="oat-hero rounded-[var(--radius-lg)] px-4 py-4 sm:px-6 sm:py-5 mb-4" style={{ border: "1px solid var(--c-line)", boxShadow: "var(--e-2)" }}>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center rounded-[12px] text-white shrink-0" style={{ width: 42, height: 42, background: "linear-gradient(135deg, var(--oat-accent), var(--oat-blue))", boxShadow: "0 8px 20px rgba(90,85,247,.28)" }}>
              <Lightning size={22} weight="fill" />
            </span>
            <div>
              <h1 className="font-display text-[20px] sm:text-[22px] font-bold tracking-[-0.02em] leading-tight">Nifty Alpha Edge</h1>
              <div className="text-[11.5px] text-muted">hedged131 · weekly order-flow vertical credit spread</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={status.tone} icon={status.icon}>{status.label}</Pill>
            {s && <Pill tone={s.shadowEnabled ? "accent" : "neutral"} icon={ShieldCheck}>SHADOW {s.shadowEnabled ? "ON" : "OFF"}</Pill>}
            {s && <Pill tone={s.autoEnabled ? "loss" : "neutral"} icon={Lock}>AUTO {s.autoEnabled ? `ON · ${s.activeBroker}` : "OFF"}</Pill>}
            <button onClick={() => setSettingsOpen(true)} className="topstep"><Gear size={13} weight="bold" />Settings</button>
            {s?.killSwitch
              ? <button onClick={resume} className="topstep" style={{ color: "var(--c-gain)" }}><Power size={13} weight="bold" />Resume</button>
              : <button onClick={kill} className="topstep" style={{ color: "var(--c-loss)" }}><Power size={13} weight="bold" />Kill switch</button>}
          </div>
        </div>
        <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mt-5 pt-4" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
          <Stat label="THIS WEEK" value={weekPnl == null ? "—" : signed(weekPnl)} tone={weekPnl == null ? undefined : weekPnl >= 0 ? "gain" : "loss"} sub={active ? `${active.mode} · ${active.structure}` : "no open position"} />
          <Stat label="REALIZED (ALL WEEKS)" value={closed.length ? signed(realized) : "—"} tone={closed.length ? (realized >= 0 ? "gain" : "loss") : undefined} sub={`${closed.length} closed`} />
          <Stat label="WIN RATE" value={closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"} sub="break-even ≈ 59% at an 81.5-pt credit" />
          <Stat label="SHADOW SIZE" value={s ? `${Math.floor(s.shadowCapital / s.unitBudget)} units` : "—"} sub={s ? `${inr(s.shadowCapital)} at ${inr(s.unitBudget)}/unit` : ""} />
        </div>
        {s?.killSwitch && <div className="relative mt-3 text-[11px] font-semibold" style={{ color: "var(--c-loss)" }}>Kill switch engaged — no new entries. Open positions are still managed to exit.</div>}
      </motion.header>

      {error && <div className="mb-4 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
      <AnimatePresence>{notice && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 flex items-center justify-between text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-accent-soft)" }}>
          <span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={13} /></button>
        </motion.div>
      )}</AnimatePresence>

      {!data ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {[0, 1, 2].map((i) => <div key={i} className={`oat-glass rounded-[var(--radius-lg)] h-[260px] animate-pulse ${i === 0 ? "lg:col-span-7" : "lg:col-span-5"}`} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 flex flex-col gap-4">
            <PositionCard position={focus} payoff={data.payoff} live={data.live} onClose={closePosition} closing={closing} />
            <MonitorCard position={active} live={data.live} />
            <HistoryCard positions={positions} />
          </div>
          <div className="lg:col-span-5 flex flex-col gap-4">
            <SignalCard signal={data.signal} decision={data.edgeDecision} />
            <EngineCard engine={data.engine} />
            <Card title="How it trades" icon={CaretRight} delay={0.15}>
              <ul className="flex flex-col gap-2 text-[11.5px] text-ink2 leading-snug">
                <li><b>Bearish week:</b> BUY CE ATM+200, then SELL CE ATM.</li>
                <li><b>Bullish week:</b> BUY PE ATM−200, then SELL PE ATM.</li>
                <li><b>Exit:</b> NIFTY future moves 300 pts in favour (400 on Mon/Tue), else expiry-day 15:10 (safety 15:20). No stop.</li>
                <li><b>Order rules:</b> protective wing fills before the short; on exit the short is bought back before the wing is sold.</li>
              </ul>
            </Card>
            <ActivityCard events={data.events} />
          </div>
        </div>
      )}

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} row={data?.settingsRow} onSaved={load} />
    </div>
  );
}
