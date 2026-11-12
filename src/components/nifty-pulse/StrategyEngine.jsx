import { Fragment } from "react";
import { Lock } from "@phosphor-icons/react";
import { Card, Badge, Check, DirBadge } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import { istTime, num, pct, secs, inr } from "./format.js";

function Stage({ n, title, state, children }) {
  return (
    <div className="np-stage">
      <div className="np-stage-box" data-state={state}>
        <div className="flex items-center justify-between"><span className="np-stage-n">0{n}</span>
          <Badge tone={state === "ok" ? "gain" : state === "active" ? "accent" : state === "block" ? "loss" : undefined}>{state === "ok" ? "OK" : state === "active" ? "ACTIVE" : state === "block" ? "BLOCKED" : "IDLE"}</Badge>
        </div>
        <div className="np-stage-t">{title}</div>
        <div className="np-stage-v">{children}</div>
      </div>
    </div>
  );
}

function Pipeline({ s }) {
  const e = pulse.engine;
  const ind = s.indicators;
  const sig = s.signal;
  const recent = (t) => t != null && s.now - t <= 3000;
  const lastDec = e.decisions[e.decisions.length - 1];
  const cands = e.lastCandidates;
  const candAt = e.lastCandidatesAt;
  return (
    <div className="np-pipe">
      <Stage n={1} title="Market data" state={s.sample?.valid ? "ok" : "block"}>
        {s.sample ? `${s.sample.status} · ${s.sample.ticks} tick${s.sample.ticks === 1 ? "" : "s"}` : "waiting"}<br />age {secs(s.dataAgeMs)}<br /><span className="np-faint">source: {s.mode === "LIVE" ? "live Kite stream" : "simulation"}</span>
      </Stage>
      <Stage n={2} title="1-second sampler" state={ind?.ready ? "ok" : "block"}>
        {ind?.ready ? `${Math.min(ind.validRun, 99999)} valid s` : `${ind?.validRun ?? 0} / ${ind?.needed ?? 61} valid s`}<br />fresh limit {secs(s.config.tickFreshnessMs)}
      </Stage>
      <Stage n={3} title="Indicators" state={ind?.ready ? "ok" : "idle"}>
        {ind?.ready ? <>R5 {pct(ind.r5, 4)}<br />R15 {pct(ind.r15, 4)}<br />MA60 {num(ind.ma60, 2)}</> : "waiting for buffer"}
      </Stage>
      <Stage n={4} title="Signal" state={sig?.direction !== "NEUTRAL" ? "active" : ind?.ready ? "ok" : "idle"}>
        {sig ? <>{sig.direction}<br />{sig.agreement.count}/4 {sig.agreement.side?.toLowerCase() ?? ""} rules</> : "—"}
      </Stage>
      <Stage n={5} title="Spread selection" state={recent(candAt) ? "active" : candAt ? "ok" : "idle"}>
        {candAt ? <>{cands.length} candidates<br />{cands.filter((c) => c.eligible).length} liquid & priced<br /><span className="np-faint">at {istTime(candAt)}</span></> : "no attempt yet"}
      </Stage>
      <Stage n={6} title="Risk engine" state={lastDec ? (lastDec.approved ? (recent(lastDec.at) ? "active" : "ok") : "block") : "idle"}>
        {lastDec ? <>{lastDec.approved ? "Approved" : "Rejected"} · {istTime(lastDec.at)}<br /><span style={{ overflowWrap: "anywhere" }}>{lastDec.reason ? lastDec.reason.slice(0, 64) : "all checks pass"}</span></> : "no decision yet"}
      </Stage>
      <Stage n={7} title="Paper broker" state={s.position ? "active" : s.tradesCount ? "ok" : "idle"}>
        {s.position ? <>{s.position.id}<br />{s.position.status}</> : "flat"}<br />{s.tradesCount} closed today<br /><span className="np-faint">no exchange orders</span>
      </Stage>
    </div>
  );
}

function RuleMatrix({ s }) {
  const sig = s.signal;
  const rows = sig?.rules ?? [];
  return (
    <div className="np-tablewrap">
      <table className="np-table">
        <thead><tr><th>Rule</th><th className="r">Current</th><th className="r">Bullish needs</th><th className="c">Bull</th><th className="r">Bearish needs</th><th className="c">Bear</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((r) => (
            <tr key={r.key}><td>{r.label}</td><td className="r n">{r.value}</td><td className="r n np-muted">{r.bullTarget}</td><td className="c"><Check ok={r.bull} /></td><td className="r n np-muted">{r.bearTarget}</td><td className="c"><Check ok={r.bear} /></td></tr>
          )) : <tr><td colSpan={6} className="np-muted">{s.statusReason}</td></tr>}
          <tr><td>Entry gating</td><td colSpan={5} className="np-muted" style={{ whiteSpace: "normal" }}>No active position · cooldown complete · daily trade limit · data freshness · liquid spread exists · risk engine approval</td></tr>
        </tbody>
        <tfoot><tr><td colSpan={6} style={{ padding: "8px 10px", fontSize: 11.5 }}>
          Result: <b>{sig?.direction ?? "NEUTRAL"}</b> · bull {sig?.bullAgree ?? 0}/4 · bear {sig?.bearAgree ?? 0}/4 — all four must agree; entries are never forced.
        </td></tr></tfoot>
      </table>
    </div>
  );
}

function Funnel({ s }) {
  const st = s.stats;
  const steps = [["Signals (episodes)", st.episodes], ["Entry attempts", st.attempts], ["Paper entries", st.entries]];
  const max = Math.max(1, st.episodes);
  const reasons = Object.entries(st.rejectionReasons).sort((a, b) => b[1] - a[1]);
  const rmax = Math.max(1, ...reasons.map(([, v]) => v));
  return (
    <>
      {steps.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <div className="flex justify-between text-[12px]"><span>{k}</span><b className="n">{v.toLocaleString("en-IN")}</b></div>
          <div className="np-meter" style={{ height: 8, marginTop: 4 }}><span style={{ width: `${(v / max) * 100}%` }} /></div>
        </div>
      ))}
      <div className="flex justify-between text-[12px]" style={{ marginBottom: 14 }}>
        <span className="np-muted">Signal-to-entry conversion</span><b className="n">{st.episodes ? pct((st.entries / st.episodes) * 100, 1, { sign: false }) : "—"}</b>
      </div>
      <div className="lbl" style={{ marginBottom: 6 }}>Rejection reasons</div>
      {reasons.length ? reasons.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 7 }}>
          <div className="flex justify-between text-[11.5px] gap-3"><span style={{ overflowWrap: "anywhere" }}>{k}</span><b className="n">{v}</b></div>
          <div className="np-meter" data-tone="loss" style={{ height: 4, marginTop: 3 }}><span style={{ width: `${(v / rmax) * 100}%` }} /></div>
        </div>
      )) : <div className="np-note">No rejections yet.</div>}
    </>
  );
}

function PresetSpec({ c }) {
  const groups = [
    ["Signal", [["R5 threshold", `±${c.shortReturnThresholdPct}%`], ["R15 threshold", `±${c.longReturnThresholdPct}%`], ["Moving average", `${c.maWindowSec}s`], ["Confirmation", `${c.confirmMin} of ${c.confirmLookback}`]]],
    ["Spread", [["Short strike", `ATM to ${c.shortOtmStepsMax} steps OTM`], ["Width", `${c.widthStepsMin}–${c.widthStepsMax} steps`], ["Min credit", `${c.minCreditPts} pts`], ["Max bid/ask", `${c.maxBidAskPts} pts · ${c.maxBidAskPct}%`]]],
    ["Exits", [["Profit target", `${c.profitTargetPctOfCredit}% of credit`], ["Stop loss", `${c.stopLossPctOfCredit}% of credit`], ["Max hold", `${c.maxHoldSec}s`]]],
    ["Risk", [["Max loss / trade", inr(c.maxLossPerTrade)], ["Daily loss limit", inr(c.maxDailyLoss)], ["Margin allocation", inr(c.maxMarginAllocation)], ["Trades / day", c.maxTradesPerDay], ["Cooldown", `${c.cooldownSec}s`]]],
    ["Costs", [["Round-trip estimate", inr(c.roundTripCostEstimate)], ["Slippage / leg", `${c.slippagePtsPerLeg} pts`], ["Cost model", c.costModel]]],
  ];
  return (
    <div className="np-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 14 }}>
      {groups.map(([g, rows]) => (
        <div key={g}>
          <div className="lbl" style={{ marginBottom: 6 }}>{g}</div>
          <dl className="np-kv" style={{ fontSize: 12 }}>{rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        </div>
      ))}
    </div>
  );
}

function Decisions() {
  const d = pulse.engine.decisions.slice(-14).reverse();
  if (!d.length) return <div className="np-note">No candidate has reached the risk engine yet.</div>;
  return (
    <div className="np-tablewrap">
      <table className="np-table">
        <thead><tr><th>Time</th><th>Signal</th><th>Candidate</th><th>Decision</th><th>Failed checks</th></tr></thead>
        <tbody>
          {d.map((x, i) => (
            <tr key={`${x.at}-${i}`}>
              <td className="n">{istTime(x.at)}</td>
              <td><DirBadge dir={x.direction} /></td>
              <td className="n np-muted">{x.candidateId ? x.candidateId.split(":").slice(-1)[0] : "—"}</td>
              <td><Badge tone={x.approved ? "gain" : "loss"}>{x.approved ? "Approved" : "Rejected"}</Badge></td>
              <td style={{ whiteSpace: "normal", minWidth: 260 }} className="np-muted">{x.checks.filter((k) => !k.pass).map((k) => `${k.label}: ${k.detail}`).join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StrategyEngine() {
  const s = usePulse((x) => x);
  const c = s.config;
  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Strategy Engine</div>
          <div className="np-ws-desc">Strategy A: NIFTY 1S Momentum Credit Spread · evaluated once per second · every stage independent and auditable</div>
        </div>
      </div>
      <Card title="Decision pipeline" sub="Live state of each module this second" style={{ marginBottom: 12 }}>
        <Pipeline s={s} />
      </Card>
      <div className="np-grid np-split-l" style={{ marginBottom: 12 }}>
        <Card title="Momentum rules" sub="Baseline thresholds — changing them requires a new versioned configuration" bodyClass=""><RuleMatrix s={s} /></Card>
        <Card title="Signal → entry funnel" sub="This session"><Funnel s={s} /></Card>
      </div>
      <div className="np-grid np-split-l">
        <Card title={<span className="flex items-center gap-2">{c.name} {c.immutable && <Badge tone="accent"><Lock size={10} weight="bold" />Immutable</Badge>}<Badge>Paper only</Badge></span>}
          sub={`${c.id}@v${c.version} · ${c.description}`}>
          <PresetSpec c={c} />
        </Card>
        <Card title="Risk engine decisions" sub="Every candidate is approved or rejected independently, with its failed checks" bodyClass=""><Decisions /></Card>
      </div>
    </>
  );
}
