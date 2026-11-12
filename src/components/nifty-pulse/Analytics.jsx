import { useMemo, useState } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell, ReferenceLine } from "recharts";
import { Warning } from "@phosphor-icons/react";
import { Card, Kpi, PnL } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import { computeAnalytics } from "../../nifty-pulse/core/analytics.ts";
import { inr, num, istTime, dur, EXIT_LABEL } from "./format.js";

const tipStyle = { background: "var(--c-surface)", border: "1px solid var(--c-line)", borderRadius: 10, fontSize: 12, boxShadow: "var(--e-2)" };

function Breakdown({ title, rows, labels }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  return (
    <Card title={title} sub={rows.length ? `${rows.reduce((a, r) => a + r.trades, 0)} trades` : "no trades"}>
      {rows.length === 0 ? <div className="np-note">Nothing recorded yet.</div> : rows.map((r) => (
        <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px 74px", gap: 10, alignItems: "center", padding: "5px 0", fontSize: 12 }}>
          <span>{labels?.[r.key] ?? r.key} <span className="np-faint n">· {r.trades} · {r.winRate != null ? `${Math.round(r.winRate * 100)}% win` : ""}</span></span>
          <div style={{ position: "relative", height: 8, background: "var(--c-surface-3)", borderRadius: 4 }}>
            <span style={{ position: "absolute", top: 0, bottom: 0, left: r.net >= 0 ? "50%" : `${50 - (Math.abs(r.net) / max) * 50}%`, width: `${(Math.abs(r.net) / max) * 50}%`, background: r.net >= 0 ? "var(--c-gain)" : "var(--c-loss)", borderRadius: 4 }} />
            <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--c-line-2)" }} />
          </div>
          <span className="n" style={{ textAlign: "right" }}><PnL value={r.net} /></span>
        </div>
      ))}
    </Card>
  );
}

export default function Analytics() {
  const s = usePulse((x) => x);
  const [src, setSrc] = useState("session");
  const [progress, setProgress] = useState(null);
  const [multi, setMulti] = useState(pulse.analyticsMulti);
  const session = useMemo(() => computeAnalytics(s.trades, s.stats), [s.tradesCount, s.stats.episodes, s.config]); // eslint-disable-line react-hooks/exhaustive-deps
  const isLive = s.mode === "LIVE";
  const cfgKey = `${s.config.id}@v${s.config.version}`;
  const [histErr, setHistErr] = useState(null);
  const multiValid = multi && (isLive ? multi.live : !multi.live && multi.configKey === cfgKey);
  const a = src === "multi" && multiValid ? multi.analytics : session;
  const runMulti = async () => {
    setSrc("multi");
    setHistErr(null);
    if (isLive) {
      try {
        const h = await pulse.liveHistory();
        if (h.store && h.store.migrationApplied === false) setHistErr("Stored history needs the NIFTY PULSE migration (src/nifty-pulse/migrations/001_nifty_pulse.sql).");
        setMulti({ live: true, count: new Set(h.trades.map((t) => t.sessionDay)).size, analytics: computeAnalytics(h.trades, null), trades: h.trades });
      } catch (e) { setHistErr(String(e?.message ?? e)); }
      return;
    }
    setProgress(0);
    const r = await pulse.runMultiSession(20, setProgress);
    setMulti(r);
    setProgress(null);
  };
  const eq = a.equity.map((p, i) => ({ i: i + 1, equity: p.equity, label: `${p.tradeId} · ${istTime(p.t)}` }));
  const label = src === "multi" && multiValid ? `${multi.count} ${isLive ? "live paper" : "synthetic"} session${multi.count === 1 ? "" : "s"}` : `this session (${s.tradesCount} closed)`;
  const dataNote = isLive ? "LIVE prices, PAPER fills — paper results exclude real-world fill quality and are not evidence of real profitability" : "SIMULATION data — not evidence of real-world profitability";
  const fmtPct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Analytics</div>
          <div className="np-ws-desc">Computed only from recorded paper trades · {s.config.name} · {dataNote}</div>
        </div>
        <div className="flex items-center gap-2" style={{ marginLeft: "auto" }}>
          <div className="np-seg" role="group" aria-label="Data set">
            <button data-on={src === "session"} onClick={() => setSrc("session")}>This session</button>
            <button data-on={src === "multi"} onClick={() => (multiValid ? setSrc("multi") : runMulti())}>{isLive ? "All live sessions" : "20 synthetic sessions"}</button>
          </div>
          {src === "multi" && <button className="np-chipbtn" onClick={runMulti} disabled={progress != null}>Re-run</button>}
        </div>
      </div>
      {progress != null && (
        <div className="np-card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="flex justify-between text-[12px]" style={{ marginBottom: 6 }}><span>Replaying 20 synthetic sessions with {cfgKey}…</span><b className="n">{Math.round(progress * 100)}%</b></div>
          <div className="np-meter"><span style={{ width: `${progress * 100}%` }} /></div>
        </div>
      )}
      {histErr && src === "multi" && <div className="np-banner" style={{ marginBottom: 12 }}><Warning size={16} weight="fill" className="np-warn" style={{ flexShrink: 0, marginTop: 1 }} /><span>{histErr}</span></div>}
      {a.sampleWarning && (
        <div className="np-banner" style={{ marginBottom: 12 }}>
          <Warning size={16} weight="fill" className="np-warn" style={{ flexShrink: 0, marginTop: 1 }} />
          <span><b>Insufficient sample.</b> {a.sampleWarning} {isLive ? "These are paper trades on live prices." : "All figures here come from synthetic replay data."}</span>
        </div>
      )}
      <div className="np-grid np-kpis" style={{ marginBottom: 12 }}>
        <Kpi label="Paper trades" value={a.trades} sub={label} />
        <Kpi label="Win rate" value={fmtPct(a.winRate)} sub={`${a.wins} won · ${a.losses} lost${a.flats ? ` · ${a.flats} flat` : ""}`} />
        <Kpi label="Net P&L" value={<PnL value={a.trades ? a.netPnl : null} />} sub={`gross ${inr(a.grossPnl, { sign: true })}`} />
        <Kpi label="Est. costs" value={inr(a.estCosts)} sub={`detailed model ${inr(a.detailedCosts)}`} />
        <Kpi label="Profit factor" value={a.profitFactor != null ? num(a.profitFactor, 2) : "—"} sub="gross wins ÷ gross losses" />
        <Kpi label="Max drawdown" value={a.trades ? <span className="np-loss">{inr(-a.maxDrawdown)}</span> : "—"} sub="peak-to-trough, closed trades" />
        <Kpi label="Avg win · loss" value={<span style={{ fontSize: 16 }}><PnL value={a.avgWin} /> · <PnL value={a.avgLoss} /></span>} sub="per closed trade" />
        <Kpi label="Avg holding" value={a.avgHoldSec != null ? dur(a.avgHoldSec) : "—"} sub={`credit captured ${a.avgCreditCapturedPct != null ? `${num(a.avgCreditCapturedPct, 1)}%` : "—"}`} />
      </div>
      <div className="np-grid np-kpis" style={{ marginBottom: 12, gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
        <Kpi label="Signal-to-entry conversion" value={fmtPct(a.conversion)} sub="entries ÷ signal episodes" />
        <Kpi label="Strategy rejection rate" value={fmtPct(a.rejectionRate)} sub="rejected ÷ entry attempts" />
        <Kpi label="Sessions" value={a.daily.length} sub="with at least one closed trade" />
        <Kpi label="Avg credit captured" value={a.avgCreditCapturedPct != null ? `${num(a.avgCreditCapturedPct, 1)}%` : "—"} sub="gross P&L ÷ entry credit" />
      </div>

      <div className="np-grid np-split-l" style={{ marginBottom: 12 }}>
        <Card title="Cumulative equity" sub={`Net of estimated costs · ${label}`}>
          <div style={{ height: 260 }}>
            {eq.length < 2 ? <div className="np-chart-empty" style={{ position: "relative", height: "100%" }}>Needs at least two closed trades</div> : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={eq} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                  <defs><linearGradient id="npEq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--c-accent)" stopOpacity={0.25} /><stop offset="100%" stopColor="var(--c-accent)" stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                  <XAxis dataKey="i" tick={{ fontSize: 11, fill: "var(--c-muted)" }} tickLine={false} axisLine={{ stroke: "var(--c-line)" }} />
                  <YAxis domain={[(m) => Math.min(0, m), (m) => Math.max(0, m)]} tick={{ fontSize: 11, fill: "var(--c-muted)" }} tickLine={false} axisLine={false} tickFormatter={(v) => inr(v)} width={70} />
                  <ReferenceLine y={0} stroke="var(--c-line-2)" />
                  <Tooltip contentStyle={tipStyle} formatter={(v) => [inr(v, { sign: true }), "Equity"]} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ""} />
                  <Area type="monotone" dataKey="equity" stroke="var(--c-accent)" strokeWidth={2} fill="url(#npEq)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
        <Card title="Daily P&L" sub={`Net, per ${isLive ? "trading" : "synthetic"} session`}>
          <div style={{ height: 260 }}>
            {!a.daily.length ? <div className="np-chart-empty" style={{ position: "relative", height: "100%" }}>No closed trades</div> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={a.daily} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--c-muted)" }} tickLine={false} axisLine={{ stroke: "var(--c-line)" }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis domain={[(m) => Math.min(0, m), (m) => Math.max(0, m)]} tick={{ fontSize: 11, fill: "var(--c-muted)" }} tickLine={false} axisLine={false} tickFormatter={(v) => inr(v)} width={70} />
                  <ReferenceLine y={0} stroke="var(--c-line-2)" />
                  <Tooltip contentStyle={tipStyle} formatter={(v, _n, p) => [`${inr(v, { sign: true })} · ${p.payload.trades} trades`, "Net"]} />
                  <Bar dataKey="net" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    {a.daily.map((d) => <Cell key={d.date} fill={d.net >= 0 ? "var(--c-gain)" : "var(--c-loss)"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      <div className="np-grid np-three" style={{ marginBottom: 12 }}>
        <Breakdown title="By time of day (entry, IST)" rows={a.byHour} />
        <Breakdown title="Bullish vs bearish" rows={a.byDirection} />
        <Breakdown title="By exit reason" rows={a.byExit} labels={EXIT_LABEL} />
        <Breakdown title="By strike width" rows={a.byWidth} />
        <Breakdown title="By holding duration" rows={a.byHold} />
        <Breakdown title="By expiry" rows={a.byExpiry} />
      </div>
      <Card title="By volatility regime" sub="Not available">
        <div className="np-note">A volatility-regime breakdown needs real recorded market data (for example India VIX or realised volatility from live ticks). It is deliberately not computed from synthetic data and will be added once live paper trading has produced a real sample.</div>
      </Card>
    </>
  );
}
