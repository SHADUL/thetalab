import { useMemo } from "react";
import { motion } from "framer-motion";
import { Pulse, Waveform } from "@phosphor-icons/react";
import { inr } from "./swingFormat.js";
import { EASE } from "./alphaFormat.js";

// Shared premium building blocks for the hedged strategy dashboards (Nifty
// Alpha Edge, Nifty Alpha Ladder): one visual system, one implementation.
// Pages render inside a `.oat-page` wrapper (index.css) for the glass and
// atmosphere layers.

// ------------------------------------------------------------------ primitives

export function Card({ title, icon: Icon, right, children, className = "", delay = 0 }) {
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

export function Pill({ tone = "neutral", children, icon: Icon }) {
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

export function Stat({ label, value, tone, sub }) {
  const color = tone === "gain" ? "var(--c-gain)" : tone === "loss" ? "var(--c-loss)" : "var(--c-text)";
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-1">{label}</div>
      <div className="font-display text-[19px] sm:text-[21px] font-bold n leading-none truncate" style={{ color }}>{value}</div>
      {sub && <div className="text-[10.5px] text-faint mt-1 truncate">{sub}</div>}
    </div>
  );
}

export function Toggle({ on, onClick, disabled, label }) {
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

/**
 * Expiry payoff chart. `markers`: [{ value, label, color, top? }] vertical
 * reference lines (ATM, wings, break-evens); `spot` draws the live index.
 */
const W = 640, H = 220, pad = { l: 8, r: 8, t: 14, b: 26 };

export function PayoffChart({ curve, markers = [], spot }) {
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
      {markers.filter((m) => Number.isFinite(m.value)).map((m) => marker(m.value, m.label, m.color, true, m.top))}
      {spot && inRange(spot) && (
        <g>
          <line x1={view.x(spot)} x2={view.x(spot)} y1={pad.t} y2={H - pad.b} stroke="var(--oat-accent)" strokeWidth="1.5" />
          <circle cx={view.x(spot)} cy={pad.t + 2} r="4" fill="var(--oat-accent)" />
          <text x={view.x(spot) + 6} y={pad.t + 6} fontSize="10" fill="var(--oat-accent)" fontWeight="700">NIFTY {spot.toFixed(0)}</text>
        </g>
      )}
      <text x={W - pad.r} y={view.y(view.maxY) - 4} textAnchor="end" fontSize="10" fill="var(--c-gain)" fontWeight="600">max gain {inr(Math.round(view.maxY))}</text>
      <text x={W - pad.r} y={view.y(view.minY) + 12} textAnchor="end" fontSize="10" fill="var(--c-loss)" fontWeight="600">max loss {inr(Math.round(Math.abs(view.minY)))}</text>
    </svg>
  );
}

export function EngineCard({ engine, footer, delay = 0.1 }) {
  const pct = (n) => Math.min(100, (n / engine.warmup.target) * 100);
  const ready = engine.warmup.bid >= engine.warmup.target && engine.warmup.ask >= engine.warmup.target;
  const w = engine.worker;
  const fresh = w && Date.now() - Date.parse(w.updated_at) < 3 * 60_000;
  return (
    <Card title="Signal engine" icon={Waveform} delay={delay} right={<Pill tone={fresh && w.status === "HEALTHY" ? "gain" : "neutral"} icon={Pulse}>{fresh ? w.status : "OFFLINE"}</Pill>}>
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
        {footer && <div className="text-[10.5px] text-faint">{footer}</div>}
      </div>
    </Card>
  );
}

export function ActivityCard({ events, delay = 0.15 }) {
  const tone = { error: "var(--c-loss)", warn: "var(--c-warn)", info: "var(--oat-accent)" };
  return (
    <Card title="Activity" icon={Pulse} delay={delay}>
      {events.length === 0 ? <div className="text-[11.5px] text-faint py-4">Nothing yet.</div> : (
        <ol className="relative flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-1">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="mt-1.5 shrink-0 rounded-full" style={{ width: 7, height: 7, background: tone[e.level] ?? "var(--c-muted)" }} />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[10px] text-faint n">
                  <span>{new Date(e.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  {e.mode && <span className="font-semibold">{e.mode}</span>}
                  {e.kind && <span>{e.kind.replaceAll("_", " ")}</span>}
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

