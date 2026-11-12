/** Shared NIFTY PULSE building blocks. Pure presentation — no data access. */
import { memo } from "react";
import { istTime } from "./format.js";

export function Card({ title, sub, tools, glow, className = "", bodyClass = "np-card-b", children, style }) {
  return (
    <section className={`np-card ${glow ? "np-card-glow" : ""} ${className}`} style={style}>
      {(title || tools) && (
        <header className="np-card-h">
          <div className="min-w-0">
            {title && <div className="np-card-t">{title}</div>}
            {sub && <div className="np-card-s">{sub}</div>}
          </div>
          {tools && <div className="np-card-tools">{tools}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Pill({ k, children, tone, live, optional, title }) {
  return (
    <span className="np-pill" data-tone={tone} data-optional={optional ? "true" : undefined} title={title}>
      {live !== undefined && <span className="np-dot" data-live={live ? "true" : "false"} style={{ color: tone === "gain" ? "var(--c-gain)" : tone === "loss" ? "var(--c-loss)" : tone === "warn" ? "var(--c-warn)" : tone === "accent" ? "var(--c-accent)" : "var(--c-faint)" }} />}
      {k && <span className="k">{k}</span>}
      <b>{children}</b>
    </span>
  );
}

export function Badge({ tone, lg, children, title }) {
  return <span className={`np-badge ${lg ? "np-badge-lg" : ""}`} data-tone={tone} title={title}>{children}</span>;
}

export function Meter({ value, max, tone }) {
  const p = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const t = tone ?? (p >= 1 ? "loss" : p >= 0.7 ? "warn" : undefined);
  return <div className="np-meter" data-tone={t} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}><span style={{ width: `${p * 100}%` }} /></div>;
}

export function Kpi({ label, value, sub, tone, spark, children }) {
  return (
    <div className="np-card np-kpi">
      <div className="lbl">{label}</div>
      <div className={`np-kpi-v ${tone ? `np-${tone}` : ""}`}>{value}</div>
      {sub != null && <div className="np-kpi-sub">{sub}</div>}
      {children}
      {spark && <div className="np-kpi-spark">{spark}</div>}
    </div>
  );
}

/** Tiny SVG sparkline. `values` may contain nulls (gaps). */
export const Spark = memo(function Spark({ values, height = 22, color = "var(--c-accent)", baseline, fill = true }) {
  const w = 120;
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} aria-hidden="true" />;
  const vs = pts.map(([, v]) => v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => height - 2 - ((v - lo) / (hi - lo)) * (height - 4);
  let d = "", run = false;
  values.forEach((v, i) => {
    if (v == null) { run = false; return; }
    d += `${run ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    run = true;
  });
  const first = pts[0], last = pts[pts.length - 1];
  const area = `${d}L${x(last[0]).toFixed(1)},${height}L${x(first[0]).toFixed(1)},${height}Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      {fill && <path d={area} fill={color} opacity=".09" />}
      {baseline != null && <line x1="0" x2={w} y1={y(baseline)} y2={y(baseline)} stroke="var(--c-line-2)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
});

export function Check({ ok }) {
  return <span className="np-check" data-ok={ok ? "true" : "false"} aria-label={ok ? "pass" : "fail"}>{ok ? "✓" : "✕"}</span>;
}

export function DirBadge({ dir, lg }) {
  const tone = dir === "BULLISH" ? "gain" : dir === "BEARISH" ? "loss" : undefined;
  const glyph = dir === "BULLISH" ? "▲" : dir === "BEARISH" ? "▼" : "◆";
  return <Badge tone={tone} lg={lg}>{glyph} {dir ?? "—"}</Badge>;
}

export function PnL({ value, className = "" }) {
  if (value == null) return <span className={`np-muted ${className}`}>—</span>;
  const t = value > 0 ? "gain" : value < 0 ? "loss" : "muted";
  const s = value > 0 ? "▲ +" : value < 0 ? "▼ −" : "";
  return <span className={`np-${t} ${className}`} style={{ fontVariantNumeric: "tabular-nums" }}>{s}₹{Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>;
}

const KIND_TONE = { SIGNAL: "accent", ENTRY: "gain", EXIT: undefined, REJECT: "loss", RISK: "loss", DATA: "warn", PENDING: "warn", EXPIRED: undefined, SELECTION: undefined, ENGINE: "accent" };

export function Timeline({ events, limit = 14, showKind }) {
  const rows = events.slice(-limit).reverse();
  if (!rows.length) return <div className="np-note">No events yet.</div>;
  return (
    <div className="np-tl">
      {rows.map((e) => (
        <div key={e.seq} className="np-tl-row">
          <div className="np-tl-t">{istTime(e.at)}</div>
          <div><div className="np-tl-dot" data-k={e.kind} /></div>
          <div className="min-w-0">
            <div className="np-tl-title">
              {e.title}
              {showKind && <span className="np-faint" style={{ fontWeight: 500, fontSize: 10, marginLeft: 6, letterSpacing: ".06em" }}>{e.kind}</span>}
            </div>
            {e.detail && <div className="np-tl-detail">{e.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
export { KIND_TONE };

export function PulseGlyph({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2 12h4l2.2-5.5 3.6 11 2.6-8 1.6 2.5H22" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Header waveform motif: a static trace plus a travelling highlight. */
export function PulseWave() {
  const d = "M0 12 H22 L27 12 L31 4 L36 20 L41 2 L46 18 L50 12 H70 L74 12 L77 7 L81 16 L84 12 H120";
  return (
    <svg className="np-wave" viewBox="0 0 120 24" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeOpacity=".22" strokeWidth="1.4" strokeLinejoin="round" />
      <path className="np-wave-run" d={d} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" pathLength="300" />
    </svg>
  );
}
