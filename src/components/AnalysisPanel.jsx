import { useState } from "react";
import {
  ComposedChart, LineChart, BarChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ReferenceArea, ResponsiveContainer,
} from "recharts";
import { motion } from "framer-motion";
import { CaretDoubleUp, CaretDoubleDown, Minus, Plus, ChartPolar } from "@phosphor-icons/react";
import { inr, sgn, fm, fi, cnt, cx } from "../lib/format";
import AnimatedNumber from "./AnimatedNumber";

/* Chart colours resolve from the same tokens as everything else, so a theme
   switch repaints the visualisation without a second palette. */
const tok = (n, f) => (typeof window === "undefined" ? f
  : getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
const C = () => ({
  gain: tok("--c-gain", "#067A55"), loss: tok("--c-loss", "#C8342B"),
  ink: tok("--c-text", "#0F1729"), ink2: tok("--c-text-2", "#5A6478"),
  accent: tok("--c-accent", "#1D4ED8"), warn: tok("--c-warn", "#9A6B12"),
  grid: tok("--c-grid", "#E7ECF3"), muted: tok("--c-muted", "#8590A5"),
  faint: tok("--c-faint", "#AEB7C6"), surface: tok("--c-surface", "#fff"),
  line: tok("--c-line", "#E2E7EF"),
});

const TABS = [
  ["payoff", "Payoff Chart"], ["mtm", "MTM"], ["strategy", "Strategy"],
  ["oi", "OI"], ["straddle", "Rolling Straddle"],
];

const Metric = ({ label, value, sub, arrow, tone, major }) => (
  <div className="metric">
    <div className="metric-k">{label}</div>
    <div className={cx("n metric-v", major && "is-major",
      tone === "up" && "is-up", tone === "down" && "is-down")}>
      {value}
    </div>
    {sub && (
      <span className="n metric-sub">
        {arrow && <span className="metric-arrow">{arrow === "up" ? "▲" : "▼"}</span>}
        {sub}
      </span>
    )}
  </div>
);

/* A stepper that reads as one control: − [value] + */
function Stepper({ value, onChange, step = 1, fmtv, suffix, width = 62 }) {
  return (
    <span className="stepper">
      <button onClick={() => onChange(value - step)}><Minus size={10} weight="bold" /></button>
      <span className="n stepper-v" style={{ width }}>
        {fmtv ? fmtv(value) : value}{suffix}
      </span>
      <button onClick={() => onChange(value + step)}><Plus size={10} weight="bold" /></button>
    </span>
  );
}

/* The two curves are the whole point of the chart and neither is self-evident,
   so they are named on it rather than left to be guessed at. */
const LineKey = ({ color, dashed, label, hint }) => (
  <span className="legend-key" title={hint}>
    <svg width="18" height="4" aria-hidden>
      <line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="2.5"
        strokeDasharray={dashed ? "4 3" : undefined} strokeLinecap="round" />
    </svg>
    {label}
  </span>
);

function Empty({ children }) {
  return (
    <div className="chart-empty">
      <ChartPolar size={22} weight="regular" className="text-faint mb-3" />
      <p className="text-[12.5px] text-muted max-w-[280px] leading-relaxed">{children}</p>
    </div>
  );
}

export default function AnalysisPanel({
  tab, setTab, stats, payoff, spot, sigma, hasLegs,
  targetSpot, setTargetSpot, ivShift, setIvShift, targetDate, setTargetDate,
  targetPnl, yDomain, xDomain, targetDates, targetIsExpiry, nearExpiry, mixedExpiries, symbol = "NIFTY",
  dates, dayIdx, mtm, oiRows, straddleSeries, maxPain,
  wizard, collapsed, setCollapsed, theme,
}) {
  const [showSettings, setShowSettings] = useState(true);
  const K = C();
  void theme;   // re-read tokens whenever the theme flips

  const fmtAxis = (v) => (Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + "L"
    : Math.abs(v) >= 1000 ? Math.round(v / 1000) + "k" : Math.round(v));
  const tipStyle = {
    background: K.surface, border: `1px solid ${K.line}`, borderRadius: 10,
    fontSize: 12.5, boxShadow: "var(--e-3)", padding: "9px 11px", color: K.ink,
  };
  const shortDate = (d) => new Date(d + "T00:00:00")
    .toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

  /* Return on capital as its own line under a P&L-style figure, direction
     carried by a small triangle rather than a +/- sign doing double duty
     with the currency figure above it. */
  const pctArrow = (v, base) => (base ? `${fm((Math.abs(v) / base) * 100, 1)}%` : null);
  const arrowOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : null);

  return (
    <section className="panel-e deskpanel">
      <div className="panel-head is-tabs">
        <div className="tabrail">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cx("tab", tab === k && "is-on")}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {tab === "payoff" && (
            <label className="chip cursor-pointer">
              <input type="checkbox" className="tickbox" checked={showSettings}
                onChange={(e) => setShowSettings(e.target.checked)} />
              Payoff Settings
            </label>
          )}
          <button className="chip" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? <CaretDoubleDown size={10} weight="bold" />
                       : <CaretDoubleUp size={10} weight="bold" />}
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      {collapsed ? null : (
        <>
          {/* ── metrics strip ─────────────────────────────────────────── */}
          <div className="metricrow">
            <Metric label="Est. Margin"
              value={hasLegs ? <AnimatedNumber value={stats?.margin} format={inr} /> : "—"} />
            <Metric label="P&L" major
              value={hasLegs ? <AnimatedNumber value={stats?.pnl} format={sgn} /> : "—"}
              sub={hasLegs && stats?.margin ? pctArrow(stats.pnl, stats.margin) : null}
              arrow={hasLegs ? arrowOf(stats?.pnl) : null}
              tone={stats?.pnl > 0 ? "up" : stats?.pnl < 0 ? "down" : null} />
            <Metric label="Max Profit" major
              value={hasLegs
                ? (Number.isFinite(stats?.maxP) ? <AnimatedNumber value={stats.maxP} format={inr} /> : "Unlimited")
                : "—"}
              sub={hasLegs && stats?.margin && Number.isFinite(stats?.maxP) ? pctArrow(stats.maxP, stats.margin) : null}
              arrow={hasLegs && Number.isFinite(stats?.maxP) ? arrowOf(stats.maxP) : null} tone="up" />
            <Metric label="Max Loss" major
              value={hasLegs
                ? (Number.isFinite(stats?.maxL) ? <AnimatedNumber value={stats.maxL} format={inr} /> : "Unlimited")
                : "—"}
              sub={hasLegs && stats?.margin && Number.isFinite(stats?.maxL) ? pctArrow(stats.maxL, stats.margin) : null}
              arrow={hasLegs && Number.isFinite(stats?.maxL) ? arrowOf(stats.maxL) : null} tone="down" />
            <Metric label="R:R" value={hasLegs && stats?.rr
              ? <>1 : <AnimatedNumber value={stats.rr} format={(v) => fm(v, 1)} /></> : "—"} />
            <Metric label="POP" value={hasLegs && stats?.pop != null
              ? <AnimatedNumber value={stats.pop} format={(v) => fm(v, 2) + "%"} /> : "—"} />
            <Metric label="Net Credit"
              value={hasLegs ? <AnimatedNumber value={stats?.credit} format={sgn} /> : "—"}
              tone={stats?.credit > 0 ? "up" : stats?.credit < 0 ? "down" : null} />
            <Metric label="Breakevens"
              value={hasLegs && stats?.bes?.length ? stats.bes.map(fi).join(" · ") : "—"}
              sub={hasLegs && stats?.bes?.length && spot
                ? ` (${fm(((stats.bes[0] - spot) / spot) * 100, 1)}%)` : null} />
          </div>

          {/* ── tab body ──────────────────────────────────────────────── */}
          <div className="tabbody">
            {tab === "payoff" && (hasLegs ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ duration: 0.35 }} className="chart-wrap has-legend">
                <div className="chart-legend">
                  <LineKey color={K.gain} label={`At expiry · ${shortDate(nearExpiry)}`}
                    hint="What the position settles at, priced at the nearest leg expiry" />
                  <LineKey color={K.accent} dashed
                    label={`At target date · ${shortDate(targetDate)}`}
                    hint="What the position is worth on the target date set below, with time value still in it" />
                </div>
                <div className="chart-plot">
                <ResponsiveContainer>
                  <ComposedChart data={payoff} margin={{ top: 22, right: 20, left: 4, bottom: 4 }}>
                    <defs>
                      <linearGradient id="pGain" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={K.gain} stopOpacity={0.24} />
                        <stop offset="100%" stopColor={K.gain} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="pLoss" x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0%" stopColor={K.loss} stopOpacity={0.2} />
                        <stop offset="100%" stopColor={K.loss} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={K.grid} vertical={false} strokeOpacity={0.7} />
                    {sigma && [2, 1].map((n) => (
                      <ReferenceArea key={n} x1={Math.round(spot - n * sigma)}
                        x2={Math.round(spot + n * sigma)} fill={K.accent}
                        fillOpacity={n === 1 ? 0.055 : 0.032} strokeOpacity={0}
                        label={{ value: `±${n}σ`, fill: K.muted, fontSize: 10, position: "insideTopRight" }} />
                    ))}
                    {/* A NUMBER axis, not a category one. Spot, the breakevens
                        and each leg's strike are arbitrary values that will not
                        coincide with any of the 141 sampled prices, and on a
                        category axis a reference line only draws where its x
                        matches a category exactly — so all of them silently
                        vanished. Positioning by value puts them back. */}
                    <XAxis dataKey="S" type="number" domain={xDomain ?? ["dataMin", "dataMax"]}
                      allowDataOverflow={false} tick={{ fill: K.muted, fontSize: 11.5 }}
                      tickFormatter={fi} axisLine={{ stroke: K.grid }} tickLine={false}
                      interval="preserveStartEnd" minTickGap={56} />
                    <YAxis width={58} tick={{ fill: K.muted, fontSize: 11.5 }} axisLine={false}
                      tickLine={false} tickFormatter={fmtAxis}
                      domain={yDomain} allowDataOverflow={false} />
                    <Tooltip cursor={{ stroke: K.faint, strokeDasharray: "3 3" }}
                      contentStyle={tipStyle} itemStyle={{ padding: "1px 0" }}
                      labelFormatter={(v) => `${symbol} ${fi(v)}`}
                      formatter={(v, n) => [sgn(v), n === "exp" ? "At expiry" : "At target date"]} />
                    <ReferenceLine y={0} stroke={K.faint} />
                    {/* Animated rather than isAnimationActive={false}: switching day/
                        session used to redraw this curve in one instant jump. Recharts
                        tweens point-for-point between the old and new arrays (same length,
                        same x's), so this reads as the curve moving, not flickering. */}
                    <Area dataKey="pos" stroke="none" fill="url(#pGain)"
                      isAnimationActive animationDuration={550} animationEasing="ease-out" />
                    <Area dataKey="neg" stroke="none" fill="url(#pLoss)"
                      isAnimationActive animationDuration={550} animationEasing="ease-out" />
                    <Line dataKey="exp" stroke={K.gain} strokeWidth={2.6} dot={false}
                      strokeLinecap="round"
                      isAnimationActive animationDuration={550} animationEasing="ease-out" />
                    <Line dataKey="tgt" stroke={K.accent} strokeWidth={2.2} strokeDasharray="7 5"
                      dot={false} strokeLinecap="round"
                      isAnimationActive animationDuration={550} animationEasing="ease-out" />
                    {/* One vertical line per leg used to be drawn here. A
                        four-leg condor turned that into eight lines on one
                        chart once the axis fix below made them actually
                        render — spot, two breakevens, four strikes, cluttering
                        exactly the reading the chart exists to make easy. Each
                        strike is already visible in the Positions table and in
                        the shape of the curve itself, so nothing is lost by
                        leaving it off the chart; spot and the breakevens are
                        the levels worth marking directly on the price axis. */}
                    {stats?.bes?.map((b) => (
                      <ReferenceLine key={b} x={b} stroke={K.warn} strokeDasharray="3 3"
                        label={{ value: fi(b), fill: K.warn, fontSize: 10.5, fontWeight: 600,
                          position: "insideBottomLeft" }} />
                    ))}
                    <ReferenceLine x={Math.round(targetSpot ?? spot)} stroke={K.ink2} strokeWidth={1.2}
                      label={{ value: `${symbol} Spot : ${fm(targetSpot ?? spot, 1)}`,
                        fill: K.ink2, fontSize: 11, fontWeight: 600, position: "top" }} />
                  </ComposedChart>
                </ResponsiveContainer>
                </div>
                {targetPnl != null && (
                  <div className={cx("target-chip n", targetPnl >= 0 ? "is-up" : "is-down")}>
                    Target P&amp;L:{" "}
                    <AnimatedNumber value={targetPnl}
                      format={(v) => sgn(v) + (stats?.margin ? ` (${fm((v / stats.margin) * 100, 1)}%)` : "")} />
                  </div>
                )}
              </motion.div>
            ) : (
              <Empty>
                No position yet. Pick <b className="text-gain">B</b> or <b className="text-loss">S</b> on
                any premium in the chain, or build one in the Strategy tab.
              </Empty>
            ))}

            {tab === "mtm" && (hasLegs ? (
              <div className="chart-wrap">
                <ResponsiveContainer>
                  <ComposedChart data={mtm} margin={{ top: 20, right: 14, left: 2, bottom: 2 }}>
                    <CartesianGrid stroke={K.grid} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate}
                      tick={{ fill: K.muted, fontSize: 10.5 }} axisLine={{ stroke: K.grid }} tickLine={false} />
                    <YAxis width={52} tick={{ fill: K.muted, fontSize: 10.5 }} axisLine={false}
                      tickLine={false} tickFormatter={fmtAxis} />
                    <Tooltip contentStyle={tipStyle}
                      labelFormatter={(d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN",
                        { weekday: "short", day: "2-digit", month: "short" })}
                      formatter={(v, n) => (n === "pnl" ? [sgn(v), "P&L"] : [fi(v), "Spot"])} />
                    <ReferenceLine y={0} stroke={K.faint} />
                    <ReferenceLine x={dates[dayIdx]} stroke={K.ink2} strokeWidth={1.2}
                      label={{ value: "today", fill: K.ink2, fontSize: 10, position: "top" }} />
                    <Line dataKey="pnl" stroke={K.accent} strokeWidth={2}
                      dot={{ r: 2.5, fill: K.accent, strokeWidth: 0 }} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : <Empty>Mark-to-market appears once a position is open — it replays the P&amp;L session by session.</Empty>)}

            {tab === "strategy" && <div className="wizard-slot">{wizard}</div>}

            {tab === "oi" && (
              <div className="chart-wrap">
                <ResponsiveContainer>
                  <BarChart data={oiRows} margin={{ top: 20, right: 14, left: 2, bottom: 2 }} barGap={0}>
                    <CartesianGrid stroke={K.grid} vertical={false} />
                    <XAxis dataKey="strike" tick={{ fill: K.muted, fontSize: 10 }} tickFormatter={fi}
                      axisLine={{ stroke: K.grid }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis width={52} tick={{ fill: K.muted, fontSize: 10.5 }} axisLine={false}
                      tickLine={false} tickFormatter={cnt} />
                    <Tooltip contentStyle={tipStyle} labelFormatter={(v) => `Strike ${fi(v)}`}
                      formatter={(v, n) => [cnt(v), n === "callOI" ? "Call OI" : "Put OI"]} />
                    <Bar dataKey="callOI" fill={K.loss} fillOpacity={0.75} animationDuration={200} />
                    <Bar dataKey="putOI" fill={K.gain} fillOpacity={0.75} animationDuration={200} />
                    {maxPain != null && (
                      <ReferenceLine x={maxPain} stroke={K.warn} strokeDasharray="4 3"
                        label={{ value: `max pain ${fi(maxPain)}`, fill: K.warn, fontSize: 10, position: "top" }} />
                    )}
                    {/* The OI profile is a genuine category axis of strikes, so
                        this has to land on one that exists — the grid is 50 on
                        NIFTY and 100 on SENSEX, so it is snapped to the nearest
                        strike actually plotted rather than assuming either. */}
                    {oiRows?.length > 0 && (
                      <ReferenceLine stroke={K.ink2} strokeWidth={1.2}
                        x={oiRows.reduce((a, r) =>
                          Math.abs(r.strike - spot) < Math.abs(a - spot) ? r.strike : a,
                          oiRows[0].strike)}
                        label={{ value: "spot", fill: K.ink2, fontSize: 10, position: "top" }} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {tab === "straddle" && (
              <div className="chart-wrap">
                <ResponsiveContainer>
                  <LineChart data={straddleSeries} margin={{ top: 20, right: 14, left: 2, bottom: 2 }}>
                    <CartesianGrid stroke={K.grid} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate}
                      tick={{ fill: K.muted, fontSize: 10.5 }} axisLine={{ stroke: K.grid }} tickLine={false} />
                    <YAxis width={52} tick={{ fill: K.muted, fontSize: 10.5 }} axisLine={false}
                      tickLine={false} />
                    <Tooltip contentStyle={tipStyle}
                      labelFormatter={(d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN",
                        { weekday: "short", day: "2-digit", month: "short" })}
                      formatter={(v, n) => (n === "premium" ? [fm(v, 1), "ATM straddle"] : [fi(v), "Spot"])} />
                    <ReferenceLine x={dates[dayIdx]} stroke={K.ink2} strokeWidth={1.2}
                      label={{ value: "today", fill: K.ink2, fontSize: 10, position: "top" }} />
                    <Line dataKey="premium" stroke={K.accent} strokeWidth={2}
                      dot={{ r: 2.5, fill: K.accent, strokeWidth: 0 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ── scenario controls ─────────────────────────────────────── */}
          {tab === "payoff" && showSettings && (
            <div className="ctrlrow">
              <span className="ctrl">
                <span className="ctrl-k">Change IV:</span>
                <Stepper value={Math.round(ivShift * 100)} step={5}
                  onChange={(v) => setIvShift(Math.max(-90, Math.min(300, v)) / 100)}
                  fmtv={(v) => (v > 0 ? "+" : "") + v} suffix="%" width={46} />
              </span>
              <span className="ctrl">
                <span className="ctrl-k">Target On:</span>
                <select className="ctrlsel n" value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}>
                  {targetDates.map((d) => (
                    <option key={d} value={d}>
                      {new Date(d + "T00:00:00").toLocaleDateString("en-IN",
                        { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
                      {d === nearExpiry ? " · expiry" : ""}
                    </option>
                  ))}
                </select>
              </span>
              <span className="ctrl">
                <span className="ctrl-k">Change Spot:</span>
                <Stepper value={Math.round(targetSpot ?? spot ?? 0)} step={50}
                  onChange={setTargetSpot} fmtv={fi} width={64} />
                <span className={cx("n ctrl-pct",
                  (targetSpot ?? spot) > spot ? "text-gain" : (targetSpot ?? spot) < spot ? "text-loss" : "text-muted")}>
                  {spot ? `${((targetSpot ?? spot) - spot) / spot > 0 ? "+" : ""}${fm((((targetSpot ?? spot) - spot) / spot) * 100, 1)}%` : "—"}
                </span>
                <button className="ctrl-reset" onClick={() => { setTargetSpot(Math.round(spot)); setIvShift(0); }}>
                  Reset
                </button>
              </span>
              <span className="ctrl-note">
                {mixedExpiries
                  ? `Expiry curve is priced at the nearest leg expiry (${new Date(nearExpiry + "T00:00:00")
                      .toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}); longer-dated legs keep time value`
                  : targetIsExpiry ? "Target is expiry — intrinsic value"
                  : "IV held constant as spot moves"}
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
