/** Shared NIFTY ASCENT building blocks. Pure presentation — no data access. */
import { memo } from "react";
import { istTime, hm } from "./format.js";

export function Card({ title, sub, tools, glow, className = "", bodyClass = "na-card-b", children, style, inactive }) {
  return (
    <section className={`na-card ${glow ? "na-card-glow" : ""} ${inactive ? "na-inactive" : ""} ${className}`} style={style} data-label={inactive || undefined}>
      {(title || tools) && (
        <header className="na-card-h">
          <div className="min-w-0">
            {title && <div className="na-card-t">{title}</div>}
            {sub && <div className="na-card-s">{sub}</div>}
          </div>
          {tools && <div className="na-card-tools">{tools}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Pill({ k, children, tone, live, optional, title }) {
  return (
    <span className="na-pill" data-tone={tone} data-optional={optional ? "true" : undefined} title={title}>
      {live !== undefined && <span className="na-dot" data-live={live ? "true" : "false"} style={{ color: tone === "gain" ? "var(--c-gain)" : tone === "loss" ? "var(--c-loss)" : tone === "warn" ? "var(--c-warn)" : tone === "accent" ? "var(--c-accent)" : "var(--c-faint)" }} />}
      {k && <span className="k">{k}</span>}
      <b>{children}</b>
    </span>
  );
}

export function Badge({ tone, lg, children, title }) {
  return <span className={`na-badge ${lg ? "na-badge-lg" : ""}`} data-tone={tone} title={title}>{children}</span>;
}

export function Kpi({ label, value, sub, tone, children }) {
  return (
    <div className="na-card na-kpi">
      <div className="lbl">{label}</div>
      <div className={`na-kpi-v ${tone ? `na-${tone}` : ""}`}>{value}</div>
      {sub != null && <div className="na-kpi-sub">{sub}</div>}
      {children}
    </div>
  );
}

export function Meter({ value, max, tone }) {
  const p = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return <div className="na-meter" data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}><span style={{ width: `${p * 100}%` }} /></div>;
}

export function Check({ ok, na }) {
  if (na) return <span className="na-check" data-ok="false" aria-label="not applicable">–</span>;
  return <span className="na-check" data-ok={ok ? "true" : "false"} aria-label={ok ? "yes" : "no"}>{ok ? "✓" : "✕"}</span>;
}

export function PnL({ value, className = "" }) {
  if (value == null) return <span className={`na-muted ${className}`}>—</span>;
  const t = value > 0 ? "gain" : value < 0 ? "loss" : "muted";
  const s = value > 0 ? "▲ +" : value < 0 ? "▼ −" : "";
  return <span className={`na-${t} ${className}`} style={{ fontVariantNumeric: "tabular-nums" }}>{s}₹{Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>;
}

export function SideBadge({ right, lg }) {
  if (!right) return <Badge lg={lg}>—</Badge>;
  return <Badge tone={right === "CE" ? "gain" : "loss"} lg={lg}>{right === "CE" ? "▲ BUY CE" : "▼ BUY PE"}</Badge>;
}

const KIND_DOT = { TRANSITION: "SIGNAL", SIGNAL: "SIGNAL", FILL: "ENTRY", ORDER: "PENDING", STOP: "EXIT", RISK: "REJECT", DATA: "DATA", CONTROL: "ENGINE" };

/** Audit timeline: transitions and key events, newest first. */
export function Timeline({ events, limit = 16, filter }) {
  const rows = (filter ? events.filter(filter) : events).slice(-limit).reverse();
  if (!rows.length) return <div className="na-note">No events yet.</div>;
  return (
    <div className="na-tl">
      {rows.map((e) => (
        <div key={e.seq} className="na-tl-row">
          <div className="na-tl-t">{e.bar != null ? hm(e.bar) : istTime(e.at).slice(0, 5)}<div className="na-faint" style={{ fontSize: 9.5 }}>{istTime(e.at)}</div></div>
          <div><div className="na-tl-dot" data-k={KIND_DOT[e.kind] ?? "SIGNAL"} /></div>
          <div className="min-w-0">
            <div className="na-tl-title">
              {e.kind === "TRANSITION" ? <>{(e.from ?? "").replaceAll("_", " ")} <span className="na-faint">→</span> {e.to.replaceAll("_", " ")}</> : e.trigger.replaceAll("_", " ")}
              <span className="na-faint" style={{ fontWeight: 500, fontSize: 10, marginLeft: 6, letterSpacing: ".06em" }}>{e.kind}{e.bot ? ` · ${e.bot === "GAP_AND_GO" ? "GAP-AND-GO" : "WILLIAMS"}` : ""}</span>
            </div>
            <div className="na-tl-detail">{e.reason}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** ASCENT mark: a rising, stepping path. */
export function AscentGlyph({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 19h4l3-5 3 3 4-8 4-4" stroke="currentColor" strokeOpacity=".35" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      <path className="na-glyph-run" d="M3 19h4l3-5 3 3 4-8 4-4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" pathLength="60" />
      <path d="M16 5h5v5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Empty({ children }) {
  return <div className="na-note" style={{ padding: "26px 8px", textAlign: "center" }}>{children}</div>;
}

export const Spark = memo(function Spark({ values, height = 60, color = "var(--c-accent)", baseline }) {
  const w = 300;
  const vs = values.filter((v) => v != null);
  if (vs.length < 2) return <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} aria-hidden="true" />;
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => height - 3 - ((v - lo) / (hi - lo)) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      {baseline != null && <line x1="0" x2={w} y1={y(baseline)} y2={y(baseline)} stroke="var(--c-line-2)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}
      <path d={`${d}L${w},${height}L0,${height}Z`} fill={color} opacity=".08" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
});

export function WsHead({ title, desc, children }) {
  return (
    <div className="na-ws-head">
      <div className="min-w-0">
        <div className="na-ws-title">{title}</div>
        {desc && <div className="na-ws-desc">{desc}</div>}
      </div>
      {children && <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{children}</div>}
    </div>
  );
}

/** Key/value list. rows: [label, value, tone?] */
export function KV({ rows, wide }) {
  return (
    <dl className={`na-kv ${wide ? "na-kv-wide" : ""}`}>
      {rows.filter(Boolean).map(([k, v, t], i) => (
        <div key={i} style={{ display: "contents" }}><dt>{k}</dt><dd className={t ? `na-${t}` : ""}>{v}</dd></div>
      ))}
    </dl>
  );
}

export function Reason({ tone, tag, children }) {
  return (
    <div className="na-reason" data-tone={tone}>
      {tag && <span className="na-badge" data-tone={tone} style={{ flexShrink: 0 }}>{tag}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
