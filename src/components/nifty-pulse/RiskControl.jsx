import { useState } from "react";
import { StopCircle, Play, Lightning, ShieldCheck } from "@phosphor-icons/react";
import { Card, Badge, Meter, Timeline } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import { inr, istTime, secs } from "./format.js";

function Ring({ value, max, label }) {
  const r = 30, c = 2 * Math.PI * r, p = max ? Math.min(1, value / max) : 0;
  return (
    <svg width="76" height="76" viewBox="0 0 76 76" role="img" aria-label={label}>
      <circle cx="38" cy="38" r={r} fill="none" stroke="var(--c-surface-3)" strokeWidth="6" />
      <circle cx="38" cy="38" r={r} fill="none" stroke={value ? "var(--c-warn)" : "var(--c-gain)"} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 38 38)" style={{ transition: "stroke-dashoffset .5s" }} />
      <text x="38" y="42" textAnchor="middle" fontSize="15" fontWeight="650" fill="var(--c-text)" style={{ fontVariantNumeric: "tabular-nums" }}>{value ? `${value}s` : "✓"}</text>
    </svg>
  );
}

function Tile({ k, v, sub, children, tone }) {
  return (
    <div className="np-card" style={{ padding: "12px 13px", display: "flex", flexDirection: "column", gap: 5 }}>
      <div className="lbl">{k}</div>
      <div className={`n ${tone ? `np-${tone}` : ""}`} style={{ fontSize: 17, fontWeight: 650 }}>{v}</div>
      {sub && <div className="np-card-s">{sub}</div>}
      {children}
    </div>
  );
}

export default function RiskControl() {
  const s = usePulse((x) => x);
  const [armKill, setArmKill] = useState(false);
  const c = s.config;
  const margin = s.position ? s.position.widthPts * s.position.qty : 0;
  const audit = pulse.engine.timeline.filter((e) => e.kind === "ENGINE" || e.kind === "RISK" || e.kind === "DATA");
  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Risk Control</div>
          <div className="np-ws-desc">Safety controls for NIFTY PULSE only · AUTO, Naked Sell and Alpha Ladder are separate systems and are never affected</div>
        </div>
      </div>
      <div className="np-grid np-risk">
        <div className="np-grid" style={{ gap: 12 }}>
          <Card glow title="Engine" sub={s.killSwitch ? "Kill switch engaged" : s.running ? "Running — new paper entries allowed" : "Stopped — new entries blocked"}>
            {s.running ? (
              <button className="np-stop" onClick={() => pulse.stopEngine()}><StopCircle size={26} weight="fill" />STOP ENGINE</button>
            ) : (
              <button className="np-stop" data-kind="start" onClick={() => { if (s.killSwitch) pulse.setKill(false); pulse.startEngine(); }}>
                <Play size={22} weight="fill" />{s.killSwitch ? "RELEASE & START" : "START ENGINE"}
              </button>
            )}
            <div className="np-note" style={{ marginTop: 12 }}>
              <b style={{ color: "var(--c-text)" }}>When stopped:</b> new entries are blocked immediately · risk monitoring and protective exits stay active for any open paper position · you can flatten it explicitly below.
            </div>
            <div className="np-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14 }}>
              <button className="np-chipbtn" style={{ height: 38, justifyContent: "center" }} disabled={!s.position} onClick={() => pulse.flatten()}>Flatten paper position</button>
              {armKill ? (
                <button className="np-chipbtn" style={{ height: 38, justifyContent: "center", color: "var(--c-loss)", borderColor: "var(--c-loss)" }} onClick={() => { pulse.setKill(true); setArmKill(false); }}>Confirm kill switch</button>
              ) : (
                <button className="np-chipbtn" style={{ height: 38, justifyContent: "center" }} disabled={s.killSwitch} onClick={() => setArmKill(true)}><Lightning size={14} weight="fill" />Kill switch</button>
              )}
            </div>
            {armKill && <div className="np-note" style={{ marginTop: 8 }}>The kill switch stops the engine and flattens the open paper position at the next valid bid/ask. <button className="link-quiet" style={{ background: "none", border: 0, cursor: "pointer", padding: 0 }} onClick={() => setArmKill(false)}>Cancel</button></div>}
          </Card>
          <Card title="Execution safety" sub="Enforced in the engine, not by hiding buttons">
            {[
              ["Paper trading", "Enabled · paper only"],
              ["Live trading", "Disabled — no order code path"],
              ["Broker orders", "None · fills are simulated"],
              ["Data mode", "SIMULATION (Phase 2)"],
              ["Credentials in browser", "None"],
            ].map(([k, v]) => (
              <div key={k} className="np-rule" style={{ gridTemplateColumns: "18px minmax(0,1fr) auto" }}>
                <ShieldCheck size={16} weight="fill" className="np-gain" /><span>{k}</span><span className="np-card-s">{v}</span>
              </div>
            ))}
          </Card>
        </div>

        <div className="np-grid" style={{ gap: 12 }}>
          <div className="np-grid np-four">
            <Tile k="Engine" v={s.killSwitch ? "Killed" : s.running ? "Running" : "Stopped"} tone={s.running ? "gain" : "warn"} sub={s.config.name} />
            <Tile k="Kill switch" v={s.killSwitch ? "Engaged" : "Released"} tone={s.killSwitch ? "loss" : undefined} sub="NIFTY PULSE only" />
            <Tile k="Capital assumption" v={inr(c.capital)} sub="research account" />
            <Tile k="Feed health" v={s.sample?.valid ? "Fresh" : s.sample ? "Stale" : "Waiting"} tone={s.sample?.valid ? "gain" : "loss"} sub={`age ${secs(s.dataAgeMs)} · ${s.feed.gaps} gaps today`} />
          </div>
          <div className="np-grid np-three">
            <Tile k="Trade risk limit" v={inr(c.maxLossPerTrade)} sub={`worst-case incl. costs · ${c.immutable ? "preset" : `custom v${c.version}`}`}>
              {s.position && <><Meter value={s.position.maxLoss} max={c.maxLossPerTrade} /><div className="np-card-s">open position {inr(s.position.maxLoss)}</div></>}
            </Tile>
            <Tile k="Daily loss limit" v={`${inr(s.lossUsed)} / ${inr(c.maxDailyLoss)}`} tone={s.lossUsed >= c.maxDailyLoss ? "loss" : undefined} sub={s.lossUsed >= c.maxDailyLoss ? "limit reached — entries blocked today" : `${inr(c.maxDailyLoss - s.lossUsed)} remaining`}>
              <Meter value={s.lossUsed} max={c.maxDailyLoss} />
            </Tile>
            <Tile k="Margin allocation (est.)" v={`${inr(margin)} / ${inr(c.maxMarginAllocation)}`} sub="paper estimate — not broker-confirmed">
              <Meter value={margin} max={c.maxMarginAllocation} />
            </Tile>
            <Tile k="Positions" v={`${s.position ? 1 : 0} / ${c.maxConcurrentPositions}`} sub={s.position ? `${s.position.id} · ${s.position.status}` : "flat"} />
            <Tile k="Trades today" v={`${s.tradesToday} / ${c.maxTradesPerDay}`} tone={s.tradesToday >= c.maxTradesPerDay ? "warn" : undefined} sub={s.tradesToday >= c.maxTradesPerDay ? "limit reached" : `${c.maxTradesPerDay - s.tradesToday} remaining`}>
              <Meter value={s.tradesToday} max={c.maxTradesPerDay} />
            </Tile>
            <div className="np-card" style={{ padding: "12px 13px", display: "flex", alignItems: "center", gap: 12 }}>
              <Ring value={s.cooldownLeft} max={c.cooldownSec} label={`Cooldown ${s.cooldownLeft} seconds left`} />
              <div><div className="lbl">Cooldown</div><div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{s.cooldownLeft ? `${s.cooldownLeft}s left` : "Complete"}</div><div className="np-card-s">{c.cooldownSec}s after each close</div></div>
            </div>
          </div>
          <Card title="Last risk rejection" sub={s.lastRejection ? istTime(s.lastRejection.at) + " IST" : "none this session"}>
            <div className="np-reason" data-tone={s.lastRejection ? "loss" : undefined}>
              <Badge tone={s.lastRejection ? "loss" : "gain"}>{s.lastRejection ? "Rejected" : "Clear"}</Badge>
              <span>{s.lastRejection?.reason ?? "No entry has been rejected yet."}</span>
            </div>
          </Card>
          <Card title="Audit trail" sub="Engine starts/stops, kill switch, configuration and data-quality events">
            <div style={{ maxHeight: 300, overflowY: "auto" }}><Timeline events={audit} limit={40} showKind /></div>
          </Card>
        </div>
      </div>
    </>
  );
}
