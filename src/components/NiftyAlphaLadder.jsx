import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Stack, Lightning, Target, Clock, ShieldCheck, Gear, X, ArrowUpRight, ArrowDownRight, Pulse, Lock,
  CheckCircle, Hourglass, ChartLineUp, Waveform, CaretRight, Info,
} from "@phosphor-icons/react";
import { inr } from "./swingFormat.js";
import { OAT_VARS, EASE, dirLabel, dirTone, signed, pts, msToNextWindow, fmtDuration, useTicker } from "./alphaFormat.js";
import { Card, Pill, Stat, PayoffChart, EngineCard, ActivityCard } from "./alphaUi.jsx";

// Nifty Alpha Ladder (hedged133) — SHADOW only. AUTO is intentionally
// locked: no broker-order code exists anywhere in this strategy's tree,
// nothing here can set execution_mode to AUTO, and the AUTO chip is a
// read-only status, not a control.

const API = "/api/options-autotrade";
const POLL_MS = 20_000;
const UNIT_BUDGET = 340_000; // θ39 for this structure

/** Expiry P&L (₹) of the 4:1:5 ladder at index S: V⁻(S) = 4(A−S)⁺ − 5(A−W−S)⁺ + (A−2W−S)⁺, minus the debit; bullish mirrors about A. */
function ladderCurve(direction, atm, wing, debit, scale) {
  const pos = (x) => Math.max(x, 0);
  const out = [];
  for (let s = atm - 3 * wing; s <= atm + 3 * wing; s += 10) {
    const x = direction < 0 ? s : 2 * atm - s;
    const v = 4 * pos(atm - x) - 5 * pos(atm - wing - x) + pos(atm - 2 * wing - x);
    out.push({ spot: s, pnl: scale * (v - debit) });
  }
  return out;
}

function SignalFlowCard({ signal }) {
  if (!signal) {
    return (
      <Card title="This week's signal" icon={Lightning} delay={0.05}>
        <div className="flex items-start gap-3">
          <Hourglass size={22} className="text-faint shrink-0 mt-0.5" />
          <div className="text-[12px] text-ink2 leading-relaxed">
            No signal yet this week. The engine evaluates every minute on <b>Wednesday 09:31–14:31 IST</b> (Thursday only on a Wednesday holiday) and fires once G2 crosses ±9.0, or at the 14:30 cutoff.
          </div>
        </div>
      </Card>
    );
  }
  const D = signal.final_direction;
  const steps = [
    { k: "Large orders (d1)", v: dirLabel(signal.d1), c: dirTone(signal.d1), sub: `A1 ${Math.round(Number(signal.area1 ?? 0)).toLocaleString("en-IN")}` },
    { k: "Imbalance (d2)", v: dirLabel(signal.d2), c: dirTone(signal.d2), sub: `G2 ${Number(signal.g2_at_signal ?? 0).toFixed(2)} · ${signal.path}` },
    { k: "Alignment", v: signal.alpha === 1 ? "ALIGNED → fade" : "DIVERGENT → follow G1", c: "var(--c-text)", sub: `base ${dirLabel(signal.base_direction)}` },
    { k: "Variation C", v: signal.variation_c_acted ? "FLIPPED to bearish" : "no change", c: signal.variation_c_acted ? "var(--c-warn)" : "var(--c-text-2)", sub: signal.vix_available ? `VIX ${Number(signal.vix_value).toFixed(2)} (cut-off 12.5)` : "VIX unavailable — inert" },
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

/** The engine's provisional read right now (published once a minute) — what the decision would look like if it were made at this instant. */
function LiveReadCard({ features }) {
  const fresh = features && Date.now() - Date.parse(features.created_at) < 3 * 60_000;
  const row = (k, v, c, sub) => (
    <div className="flex items-center justify-between gap-3 py-1.5" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
      <span className="text-[11px] text-muted">{k}{sub && <span className="text-faint"> · {sub}</span>}</span>
      <span className="text-[12px] font-bold n" style={{ color: c ?? "var(--c-text)" }}>{v}</span>
    </div>
  );
  const g2 = Number(features?.g2 ?? 0);
  const g2Pct = Math.min(100, (Math.abs(g2) / 9) * 100);
  return (
    <Card title="Live order-flow read" icon={Pulse} delay={0.08} right={<Pill tone={fresh ? "gain" : "neutral"}>{fresh ? "LIVE" : "NO FEED"}</Pill>}>
      {!features ? <div className="text-[11.5px] text-faint">No reading yet — published once a minute while the worker runs in market hours.</div> : (
        <>
          <div className="mb-3">
            <div className="flex items-center justify-between text-[10.5px] mb-1">
              <span className="text-muted font-semibold">G2 toward the ±9.0 crossing</span>
              <span className="n font-semibold" style={{ color: dirTone(Math.sign(g2)) }}>{g2.toFixed(2)}</span>
            </div>
            <div className="h-[8px] rounded-full overflow-hidden relative" style={{ background: "var(--c-surface-3)" }}>
              <motion.div animate={{ width: `${g2Pct}%` }} transition={{ duration: 0.6, ease: EASE }} className="h-full rounded-full"
                style={{ background: g2 >= 0 ? "var(--c-gain)" : "var(--c-loss)" }} />
            </div>
          </div>
          {row("G1 large-order net", features.g1 === null ? "—" : Math.round(Number(features.g1)).toLocaleString("en-IN"), undefined, features.g1_active ? "active" : "warming up")}
          {row("d1 (A1 sign)", dirLabel(features.d1), dirTone(features.d1))}
          {row("d2", dirLabel(features.d2), dirTone(features.d2), features.d2_basis === "running_area" ? "provisional" : features.d2_basis)}
          {row("Provisional D", features.final_direction == null ? "—" : dirLabel(features.final_direction), dirTone(features.final_direction))}
          <div className="text-[10.5px] text-faint mt-2">
            {features.session_valid ? "Session valid for a new signal." : "Session invalid for a new signal today."} Updated {new Date(features.created_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}.
          </div>
        </>
      )}
    </Card>
  );
}

function LadderPositionCard({ position }) {
  const legs = useMemo(() => (position?.alpha_ladder_legs ?? []).slice().sort((a, b) => a.placement_order - b.placement_order), [position]);
  if (!position) {
    return (
      <Card title="Position" icon={ChartLineUp}>
        <div className="flex flex-col items-center text-center py-8 gap-2">
          <Stack size={30} className="text-faint" />
          <div className="text-[13px] font-semibold text-ink2">No SHADOW position live</div>
          <div className="text-[11.5px] text-faint max-w-[360px]">When the weekly signal fires, a 4 : 1 : 5 ratio ladder opens on the next weekly expiry — the two long legs first, the 5-lot short last.</div>
        </div>
      </Card>
    );
  }
  const wing = Number(position.strike_step) * 4;
  const atm = Number(position.atm_strike);
  const scale = position.units * position.lot_size;
  const curve = position.net_debit_points != null ? ladderCurve(position.direction, atm, wing, Number(position.net_debit_points), scale) : null;
  const sign = position.direction < 0 ? -1 : 1;
  const open = position.status === "ACTIVE";
  const pnl = open ? null : Number(position.realized_pnl ?? 0);
  return (
    <Card title="Position" icon={ChartLineUp}
      right={<div className="flex items-center gap-1.5"><Pill tone="accent">{position.execution_mode}</Pill><Pill tone={open ? "gain" : "neutral"}>{position.status.replaceAll("_", " ")}</Pill></div>}>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <div className="font-display text-[17px] font-bold flex items-center gap-2" style={{ color: dirTone(position.direction) }}>
            {position.direction > 0 ? <ArrowUpRight size={18} weight="bold" /> : <ArrowDownRight size={18} weight="bold" />}{dirLabel(position.direction)} ratio ladder
          </div>
          <div className="text-[11px] text-faint mt-0.5 n">Expiry {position.expiry} · {position.units} unit{position.units === 1 ? "" : "s"} × lot {position.lot_size}</div>
        </div>
        {pnl !== null && (
          <div className="sm:text-right">
            <div className="text-[10.5px] text-muted font-semibold tracking-wide">REALIZED</div>
            <div className="font-display text-[26px] font-bold n leading-none" style={{ color: pnl >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{signed(pnl)}</div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Net debit" value={`${pts(position.net_debit_points)} pts`} />
        <Stat label="Max gain" value={position.max_gain != null ? inr(position.max_gain) : "—"} tone="gain" />
        <Stat label="Max loss" value={position.max_loss != null ? inr(position.max_loss) : "—"} tone="loss" />
        <Stat label="Tail value" value={position.tail_value != null ? inr(position.tail_value) : "—"} sub="beyond the far wing" />
      </div>
      {curve && (
        <div className="rounded-[12px] p-2 mb-4" style={{ background: "var(--c-surface-2)" }}>
          <PayoffChart curve={curve} markers={[
            { value: atm, label: `ATM ${atm}`, color: "var(--c-text-2)" },
            { value: atm + sign * wing, label: `Short ${atm + sign * wing}`, color: "var(--c-loss)" },
            { value: atm + sign * 2 * wing, label: `Far ${atm + sign * 2 * wing}`, color: "var(--c-muted)" },
            ...(position.break_evens ?? []).map((b, i) => ({ value: Number(b), label: `BE ${Number(b).toFixed(0)}`, color: "var(--c-warn)", top: true, key: i })),
          ]} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px] n whitespace-nowrap [&_th]:pr-3 [&_td]:pr-3 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
          <thead><tr className="text-[10px] text-muted text-left">
            <th className="font-semibold py-1.5">#</th><th className="font-semibold">Leg</th><th className="font-semibold">Contract</th>
            <th className="font-semibold text-right">Ratio</th><th className="font-semibold text-right">Qty</th><th className="font-semibold pl-4">State</th>
          </tr></thead>
          <tbody>
            {legs.map((l) => (
              <tr key={l.id} style={{ borderTop: "1px solid var(--oat-hairline)" }}>
                <td className="py-2 text-faint">{l.placement_order}</td>
                <td><span className="font-bold" style={{ color: l.side === "BUY" ? "var(--c-gain)" : "var(--c-loss)" }}>{l.side}</span></td>
                <td className="font-medium">{l.strike} {l.option_right}</td>
                <td className="text-right">{l.ratio}</td>
                <td className="text-right">{l.quantity}</td>
                <td className="pl-4 text-[10.5px] text-muted">{l.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MonitorPlaceholder({ position }) {
  return (
    <Card title="Exit monitor" icon={Target} delay={0.05}>
      <div className="flex items-start gap-3">
        <Info size={18} className="text-faint shrink-0 mt-0.5" />
        <div className="text-[11.5px] text-ink2 leading-relaxed">
          {position
            ? "The NIFTY-future monitor (300 points in favour Wed–Fri, 400 on Mon/Tue) drives this structure's exit."
            : "Nothing to monitor yet. Once a structure is live, the NIFTY future is tracked against its target: 300 points in favour Wed–Fri, 400 on Mon/Tue."}
        </div>
      </div>
    </Card>
  );
}

function HistoryCard({ positions }) {
  return (
    <Card title="Weekly history" icon={Clock} delay={0.1}>
      {positions.length === 0 ? <div className="text-[11.5px] text-faint py-4">No weeks traded yet.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px] n whitespace-nowrap [&_th]:pr-3 [&_td]:pr-3 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
            <thead><tr className="text-[10px] text-muted text-left">
              <th className="font-semibold py-1.5">Expiry</th><th className="font-semibold">Mode</th><th className="font-semibold">Direction</th>
              <th className="font-semibold text-right">Debit</th><th className="font-semibold pl-4">Outcome</th><th className="font-semibold text-right">P&L</th>
            </tr></thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id} className="oat-row" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
                  <td className="py-2">{p.expiry}</td>
                  <td><Pill tone="accent">{p.execution_mode}</Pill></td>
                  <td className="font-semibold" style={{ color: dirTone(p.direction) }}>{dirLabel(p.direction)}</td>
                  <td className="text-right">{pts(p.net_debit_points)}</td>
                  <td className="pl-4 text-[10.5px] text-muted">{p.status === "CLOSED" ? (p.exit_reason ?? "").replaceAll("_", " ") : p.status.replaceAll("_", " ")}</td>
                  <td className="text-right font-semibold" style={{ color: p.realized_pnl == null ? "var(--c-faint)" : p.realized_pnl >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{p.realized_pnl == null ? "—" : signed(Number(p.realized_pnl))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SettingsDrawer({ open, onClose, settings, onSaved }) {
  const [capital, setCapital] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setCapital(settings?.allocated_capital ?? ""); setError(null); } }, [open, settings]);
  const units = Math.floor((Number(capital) || 0) / UNIT_BUDGET);
  const save = () => {
    setSaving(true); setError(null);
    fetch(`${API}?resource=alpha-ladder-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocated_capital: Number(capital) }) })
      .then((r) => r.json())
      .then((b) => { if (b.error) { setError(b.message || b.error); return; } onSaved(); onClose(); })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };
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
              <div className="text-[13px] font-semibold">SHADOW allocation</div>
              <input type="number" value={capital} onChange={(e) => setCapital(e.target.value)} className="px-3 py-2 rounded-[10px] n text-[13px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }} />
              <span className="text-[10.5px] text-faint">{units} unit{units === 1 ? "" : "s"} at ₹{UNIT_BUDGET.toLocaleString("en-IN")} each. Fixed — never your real balance.</span>
            </div>
            <div className="rounded-[14px] p-4 flex items-start gap-3" style={{ background: "var(--c-surface-2)" }}>
              <Lock size={16} className="shrink-0 mt-0.5 text-muted" />
              <div className="text-[11.5px] text-ink2"><b>AUTO is locked</b> for this strategy. There is no real-order path here; it can only be enabled after a reviewed readiness milestone.</div>
            </div>
            {error && <div className="text-[11.5px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
            <div className="flex gap-2 mt-auto">
              <button onClick={onClose} className="topstep flex-1 justify-center" style={{ height: 38 }}>Cancel</button>
              <button onClick={save} disabled={saving} className="flex-1 rounded-[8px] text-[12.5px] font-semibold text-white" style={{ height: 38, background: "var(--oat-accent)", opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default function NiftyAlphaLadder() {
  const [summary, setSummary] = useState(null);
  const [positions, setPositions] = useState({ active: [], closed: [] });
  const [activity, setActivity] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useTicker(1000);

  const load = useCallback(() => {
    Promise.all([
      fetch(`${API}?resource=alpha-ladder-summary`).then((r) => r.json()),
      fetch(`${API}?resource=alpha-ladder-positions`).then((r) => r.json()),
      fetch(`${API}?resource=alpha-ladder-activity`).then((r) => r.json()),
      fetch(`${API}?resource=alpha-ladder-health`).then((r) => r.json()),
    ])
      .then(([s, p, a, h]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSummary(s);
        setPositions({ active: p?.active ?? [], closed: p?.closed ?? [] });
        setActivity(a?.entries ?? []);
        setHealth(h);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);

  const settings = summary?.settings;
  const allPositions = [...positions.active, ...positions.closed];
  const closed = positions.closed.filter((p) => p.status === "CLOSED");
  const realized = closed.reduce((a, p) => a + Number(p.realized_pnl ?? 0), 0);
  const wins = closed.filter((p) => Number(p.realized_pnl) > 0).length;
  const active = summary?.activePosition ?? positions.active[0] ?? null;
  const signal = summary?.latestSignal;
  const signalThisWeek = signal && (Date.now() - Date.parse(`${signal.signal_date}T00:00:00Z`)) / 86_400_000 <= 7 ? signal : null;
  const nextWindow = msToNextWindow();
  const latestHealth = health?.health?.[0] ?? null;
  const engine = {
    worker: latestHealth,
    warmup: health?.warmup ?? { bid: 0, ask: 0, target: 150_000 },
    sessionQuality: health?.sessionIntegrity?.sessionQuality ?? "VALID",
    sessionReason: health?.sessionIntegrity?.detail ?? null,
  };
  const units = settings ? Math.floor(Number(settings.allocated_capital || 0) / UNIT_BUDGET) : null;

  const status = active ? { label: "POSITION LIVE", tone: "gain", icon: Pulse }
    : signalThisWeek ? { label: "SIGNAL FIRED", tone: "accent", icon: Lightning }
      : nextWindow === 0 ? { label: "EVALUATING", tone: "warn", icon: Waveform }
        : { label: `NEXT WINDOW IN ${fmtDuration(nextWindow)}`, tone: "neutral", icon: Hourglass };

  return (
    <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-5 sm:py-7">
      <motion.header initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}
        className="oat-hero rounded-[var(--radius-lg)] px-4 py-4 sm:px-6 sm:py-5 mb-4" style={{ border: "1px solid var(--c-line)", boxShadow: "var(--e-2)" }}>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center rounded-[12px] text-white shrink-0" style={{ width: 42, height: 42, background: "linear-gradient(135deg, var(--oat-accent), var(--oat-blue))", boxShadow: "0 8px 20px rgba(90,85,247,.28)" }}>
              <Stack size={22} weight="fill" />
            </span>
            <div>
              <h1 className="font-display text-[20px] sm:text-[22px] font-bold tracking-[-0.02em] leading-tight">Nifty Alpha Ladder</h1>
              <div className="text-[11.5px] text-muted">hedged133 · weekly order-flow 4 : 1 : 5 ratio ladder</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={status.tone} icon={status.icon}>{status.label}</Pill>
            <Pill tone="accent" icon={ShieldCheck}>SHADOW</Pill>
            <span title="AUTO is locked until a reviewed readiness milestone — there is no real-order path in this strategy."><Pill tone="neutral" icon={Lock}>AUTO LOCKED</Pill></span>
            <button onClick={() => setSettingsOpen(true)} className="topstep"><Gear size={13} weight="bold" />Settings</button>
          </div>
        </div>
        <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mt-5 pt-4" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
          <Stat label="THIS WEEK" value={active ? dirLabel(active.direction) : signalThisWeek ? dirLabel(signalThisWeek.final_direction) : "—"}
            tone={active ? (active.direction > 0 ? "gain" : "loss") : undefined} sub={active ? "SHADOW ladder live" : signalThisWeek ? "signal fired, no structure yet" : "waiting for the signal"} />
          <Stat label="REALIZED (ALL WEEKS)" value={closed.length ? signed(realized) : "—"} tone={closed.length ? (realized >= 0 ? "gain" : "loss") : undefined} sub={`${closed.length} closed`} />
          <Stat label="WIN RATE" value={closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"} sub="one decision per week" />
          <Stat label="SHADOW SIZE" value={units == null ? "—" : `${units} unit${units === 1 ? "" : "s"}`} sub={settings ? `${inr(Number(settings.allocated_capital || 0))} at ${inr(UNIT_BUDGET)}/unit` : ""} />
        </div>
      </motion.header>

      {error && (
        <div className="mb-4 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>
          {error} — most likely a database migration hasn't been applied yet.
        </div>
      )}

      {!summary && !error ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {[0, 1].map((i) => <div key={i} className={`oat-glass rounded-[var(--radius-lg)] h-[260px] animate-pulse ${i === 0 ? "lg:col-span-7" : "lg:col-span-5"}`} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 flex flex-col gap-4">
            <LadderPositionCard position={active} />
            <MonitorPlaceholder position={active} />
            <HistoryCard positions={allPositions.filter((p) => p.status !== "ACTIVE")} />
          </div>
          <div className="lg:col-span-5 flex flex-col gap-4">
            <SignalFlowCard signal={signalThisWeek} />
            <LiveReadCard features={health?.liveFeatures ?? null} />
            <EngineCard engine={engine} footer={`Depth source: nearest NIFTY future${health?.warmup?.contract ? ` (${health.warmup.contract})` : ""}. Shared with Nifty Alpha Edge.`} />
            <Card title="How it trades" icon={CaretRight} delay={0.15}>
              <ul className="flex flex-col gap-2 text-[11.5px] text-ink2 leading-snug">
                <li><b>Bearish week:</b> BUY 4× PE ATM, BUY 1× PE ATM−400, then SELL 5× PE ATM−200.</li>
                <li><b>Bullish week:</b> the mirror image in calls.</li>
                <li><b>Payoff:</b> peaks at the short strike; the extra long caps the tail.</li>
                <li><b>Exit:</b> NIFTY future 300 pts in favour (400 on Mon/Tue), else the scheduled exit.</li>
              </ul>
            </Card>
            <ActivityCard events={activity} />
          </div>
        </div>
      )}

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSaved={load} />
    </div>
  );
}
