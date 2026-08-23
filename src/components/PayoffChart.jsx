import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea, ResponsiveContainer } from "recharts";
import { motion } from "framer-motion";
import { ChartPolar } from "@phosphor-icons/react";
import { inr, sgn, fi, fm } from "../lib/format";

/* Chart colours resolve from the same tokens as the rest of the app, so a
   theme switch repaints the visualisation without a second palette. */
const tok = (n, f) => (typeof window === "undefined" ? f
  : getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
const C = () => ({
  gain: tok("--c-gain", "#067A55"), loss: tok("--c-loss", "#C8342B"),
  ink: tok("--c-text", "#111318"), ink2: tok("--c-text-2", "#5F6673"),
  accent: tok("--c-accent", "#1D4ED8"), warn: tok("--c-warn", "#9A6B12"),
  grid: tok("--c-grid", "#EAECEF"), muted: tok("--c-muted", "#878E9A"),
  faint: tok("--c-faint", "#AEB4BE"), surface: tok("--c-surface", "#fff"),
  line: tok("--c-line", "#E6E8EC"),
});

function Dot({ label, color, dashed }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
      <svg width="16" height="4" aria-hidden>
        <line x1="0" y1="2" x2="16" y2="2" stroke={color} strokeWidth="2"
          strokeDasharray={dashed ? "4 3" : undefined} />
      </svg>{label}
    </span>
  );
}

export default function PayoffChart({ data, spot, sigma, breakevens, legs, greeks, hasLegs, theme }) {
  const K = C();
  const { gain: GAIN, loss: LOSS, ink: INK, ink2: INK2, accent: BRAND, warn: GOLD,
          grid: HAIR, muted: MUTED, faint: FAINT, surface: SURF, line: LINE } = K;
  return (
    <section className="panel-e p-4 sm:p-5">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-[14.5px] font-semibold tracking-[-0.015em]">Payoff</h2>
        <div className="flex items-center gap-4">
          <Dot label="At expiry" color={INK} />
          <Dot label="Today" color={BRAND} dashed />
        </div>
      </div>

      {hasLegs ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}
          className="h-[280px] sm:h-[330px] -ml-2">
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 22, right: 12, left: 4, bottom: 4 }}>
              <defs>
                <linearGradient id="gGain" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={GAIN} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={GAIN} stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gLoss" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stopColor={LOSS} stopOpacity={0.26} />
                  <stop offset="100%" stopColor={LOSS} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={HAIR} vertical={false} strokeDasharray="0" />
              {sigma && (
                <ReferenceArea x1={Math.round(spot - 2 * sigma)} x2={Math.round(spot + 2 * sigma)}
                  fill={BRAND} fillOpacity={0.035} strokeOpacity={0} />
              )}
              {sigma && (
                <ReferenceArea x1={Math.round(spot - sigma)} x2={Math.round(spot + sigma)}
                  fill={BRAND} fillOpacity={0.045} strokeOpacity={0} />
              )}
              <XAxis dataKey="S" tick={{ fill: MUTED, fontSize: 11 }} tickFormatter={fi}
                axisLine={{ stroke: HAIR }} tickLine={false} className="num" />
              <YAxis width={56} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={(v) => (Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(1) + "L" : Math.round(v / 1000) + "k")} />
              <Tooltip
                cursor={{ stroke: FAINT, strokeDasharray: "3 3" }}
                contentStyle={{ background: SURF, border: `1px solid ${LINE}`, borderRadius: 10,
                  fontSize: 12.5, boxShadow: "var(--e-3)", padding: "9px 11px", color: INK }}
                itemStyle={{ padding: "1px 0" }}
                labelFormatter={(v) => `NIFTY ${fi(v)}`}
                formatter={(v, n) => [sgn(v), n === "exp" ? "At expiry" : "Today"]} />
              <ReferenceLine y={0} stroke={FAINT} />
              <Area dataKey="pos" stroke="none" fill="url(#gGain)" isAnimationActive animationDuration={220} />
              <Area dataKey="neg" stroke="none" fill="url(#gLoss)" isAnimationActive animationDuration={220} />
              <Line dataKey="exp" stroke={INK} strokeWidth={2} dot={false} animationDuration={220} />
              <Line dataKey="now" stroke={BRAND} strokeWidth={1.9} strokeDasharray="5 4" dot={false} animationDuration={220} />
              {legs.map((l) => (
                <ReferenceLine key={l.id} x={l.strike} stroke={l.side === "SELL" ? LOSS : GAIN}
                  strokeOpacity={0.42} strokeWidth={1}
                  label={{ value: `${l.side[0]}${l.strike}${l.right === "CE" ? "c" : "p"}`,
                    fill: l.side === "SELL" ? LOSS : GAIN, fontSize: 9.5, position: "insideTop" }} />
              ))}
              {breakevens.map((b) => (
                <ReferenceLine key={b} x={b} stroke={GOLD} strokeDasharray="3 3"
                  label={{ value: fi(b), fill: GOLD, fontSize: 10.5, position: "insideBottomLeft" }} />
              ))}
              <ReferenceLine x={Math.round(spot)} stroke={INK2} strokeWidth={1.2}
                label={{ value: `Spot ${fi(spot)}`, fill: INK2, fontSize: 11, position: "top" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </motion.div>
      ) : (
        <div className="h-[280px] sm:h-[330px] flex flex-col items-center justify-center text-center px-8">
          <ChartPolar size={22} weight="regular" className="text-faint mb-3" />
          <p className="lbl mb-1.5">Awaiting a position</p>
          <p className="text-[12.5px] text-muted max-w-[260px] leading-relaxed">
            Construct one in the wizard, or pick <b className="text-gain">B</b> / <b className="text-loss">S</b> on
            any premium in the chain.
          </p>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-line">
        {[["Delta", fm(greeks.delta, 1), greeks.delta],
          ["Theta / day", hasLegs ? inr(greeks.theta) : "—", greeks.theta],
          ["Gamma", fm(greeks.gamma, 4), 0],
          ["Vega", hasLegs ? inr(greeks.vega) : "—", 0]].map(([k, v, sig]) => (
          <div key={k} className="min-w-0">
            <div className="lbl">{k}</div>
            <div className={`n text-[15px] mt-1 truncate ${
              sig > 0 ? "text-gain" : sig < 0 ? "text-loss" : "text-ink"}`}>{v}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
