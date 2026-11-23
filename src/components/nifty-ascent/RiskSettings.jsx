/** Risk & Settings — controls, execution/risk settings, and the locked research rules. */
import { useState } from "react";
import { Play, Prohibit, Skull, LockOpen, Lock } from "@phosphor-icons/react";
import { useAscent, ascent } from "./store.js";
import { Card, WsHead, Badge, KV, Reason } from "./ui.jsx";
import { num } from "./format.js";
import { RESEARCH_RULES_V1 as R, DEFAULT_EXECUTION } from "../../nifty-ascent/core/rules.ts";
import { COST_MODEL } from "../../nifty-ascent/core/costs.ts";

const FIELDS = [
  ["paperCapital", "Paper capital ₹", "independent of NIFTY PULSE", 1000],
  ["lots", "Lots per trade", "quantity = lots × instrument-master lot size", 1],
  ["maxPremiumOutlay", "Max premium outlay ₹", "premium × qty + estimated entry fees", 500],
  ["maxTheoreticalLoss", "Max theoretical trade loss ₹", "full premium + fees (option can expire worthless)", 500],
  ["dailyLossCutoff", "Daily realized loss cutoff ₹", "blocks new entries", 500],
  ["maxQuoteAgeMs", "Max quote age (ms)", "fills only on fresher quotes", 100],
  ["maxSpreadPct", "Max bid/ask spread % of mid", "entry liquidity gate", 0.1],
  ["minDailyVolume", "Min daily volume (contracts)", "entry liquidity gate", 50],
  ["slippage", "Simulated slippage (fraction)", "applied against every fill", 0.0005],
];

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export default function RiskSettings() {
  const S = useAscent();
  const e = S.replay.engine;
  const [form, setForm] = useState(() => ({ ...S.exec }));
  const changed = FIELDS.some(([k]) => Number(form[k]) !== S.exec[k]);
  const save = () => ascent.setExec(Object.fromEntries(FIELDS.map(([k]) => [k, Number(form[k])])));
  return (
    <>
      <WsHead title="Risk & Settings" desc="Research rules are locked; execution and risk settings are adjustable and versioned. Every limit is enforced by the engine, not the page." />
      <div className="na-grid na-risk" style={{ marginBottom: 12 }}>
        <Card title="Replay engine controls · SIMULATION only" sub="These act on the replay session in this browser — not on the live server" glow>
          <div style={{ display: "grid", gap: 10 }}>
            <div className="flex items-center gap-2"><span className="na-muted" style={{ fontSize: 12 }}>Engine</span><Badge tone={e.engineStatus === "RUNNING" ? "accent" : e.engineStatus === "KILLED" ? "loss" : "warn"} lg>{e.engineStatus.replace("_", " ")}</Badge></div>
            <button className="na-stop" data-kind="start" onClick={() => ascent.control("START")} disabled={e.killed}><Play size={18} weight="fill" />START REPLAY ENGINE</button>
            <button className="na-chipbtn" style={{ height: 40, justifyContent: "center" }} onClick={() => ascent.control("STOP_ENTRIES")}><Prohibit size={15} />STOP NEW ENTRIES — keep managing the open position</button>
            <button className="na-stop" onClick={() => ascent.control("KILL")}><Skull size={18} weight="fill" />KILL / FLATTEN REPLAY</button>
            <button className="na-chipbtn" style={{ height: 34, justifyContent: "center" }} onClick={() => ascent.control("RELEASE")} disabled={!e.killed}><LockOpen size={14} />Release kill switch</button>
            <div className="na-note">KILL blocks entries, cancels a pending entry and closes an open paper position at the first fresh bid. Live paper is NOT ENABLED; when it is (after your approval) the live engine will have its own controls and start PAUSED every day.</div>
          </div>
        </Card>
        <Card title="Execution & risk settings" sub={`Version ${S.exec.version} · replay restarts from 09:10 and re-runs to the current time when saved`}
          tools={<><button className="na-chipbtn" onClick={() => { ascent.resetExec(); setForm({ ...DEFAULT_EXECUTION }); }}>Defaults</button><button className="na-chipbtn" data-on={changed} disabled={!changed} onClick={save}>Save new version</button></>}>
          {FIELDS.map(([k, label, hint, step]) => (
            <div className="na-field" key={k} data-changed={Number(form[k]) !== S.exec[k] ? "true" : undefined}>
              <label htmlFor={`na-${k}`}>{label}</label>
              <small>{hint}</small>
              <input id={`na-${k}`} type="number" step={step} value={form[k]} onChange={(ev) => setForm({ ...form, [k]: ev.target.value })} />
            </div>
          ))}
        </Card>
      </div>
      <LiveServiceCard L={S.live} />
      <div className="na-grid na-two">
        <Card title={<span className="flex items-center gap-2"><Lock size={14} weight="bold" />Research rules {R.version}</span>} sub="Fixed research specification (OptionsBuyer.in data + your Q1–Q15 decisions). Changing any of these requires a new strategy version.">
          <KV wide rows={[
            ["Opening range", `${R.orBarCount} one-minute closes ${hhmm(R.orFirstBar)}–${hhmm(R.orLastBar)}`],
            ["Gap-and-Go bands", `OR edge ± ${R.bandFraction * 100}% of OR width, strict close beyond`],
            ["Gap-and-Go window", `${hhmm(R.gapGoFirstBar)}–${hhmm(R.gapGoLastBar)} bars`],
            ["Stand-downs", "opposite_first · filled (tick-based, Q3) · no_break"],
            ["Williams gap filter", `< ${R.williamsLowGapPct}% or ≥ ${R.williamsHighGapPct}%`],
            ["Williams levels", `09:15 ref ± ${R.williamsFraction * 100}% of previous-day close range`],
            ["Williams window", `handover bar (Q15) – ${hhmm(R.williamsLastBar)}`],
            ["Option", `${R.itmPoints} pts ITM from the signal close (Q7), ties deeper ITM (Q8), next expiry on expiry day (Q9 — PROVISIONAL, unverified against OptionsBuyer.in)`],
            ["Fixed stop", `premium close ≤ ${R.fixedStopFactor * 100}% of entry`],
            ["Trail", `arms on a close > ${R.trailActivationFactor * 100}% · exits ≤ ${R.trailStopFactor * 100}% of the highest close`],
            ["Time exit", `${hhmm(R.timeExitMinute)}:00, first fresh bid (Q11)`],
            ["Positions per day", `${R.maxPositionsPerDay} across both bots`],
          ]} />
        </Card>
        <Card title="Cost model & data policy">
          <KV rows={[
            ["Cost model", COST_MODEL.version],
            ["Brokerage", `₹${COST_MODEL.brokeragePerOrder} per order`],
            ["STT", `${COST_MODEL.sttSellRate * 100}% of sell premium`],
            ["Exchange txn", `${num(COST_MODEL.txnRate * 100, 5)}% both sides`],
            ["SEBI · stamp · GST", `₹${COST_MODEL.sebiPerCrore}/cr · ${COST_MODEL.stampBuyRate * 100}% buy · ${COST_MODEL.gstRate * 100}%`],
            ["Bar grace", `${S.exec.barGraceMs} ms after each minute`],
            ["Stale index tick", `> ${S.exec.maxIndexLagMs} ms old on receipt → dropped`],
            ["Previous-day bars needed", `${S.exec.minPrevDayBars} of 375`],
          ]} />
          <div style={{ marginTop: 10 }}><Reason tone="warn" tag="POLICY">A missing NIFTY minute inside an active signal window (09:46–12:00 or Williams to 14:29) is treated as DATA_ERROR: the first breakout can’t be determined, so no trade is taken. Confirmed by the owner on 23 Nov 2026.</Reason></div>
          <div className="na-note" style={{ marginTop: 10 }}>Recording and replay of real sessions (tick recorder) arrive with live integration and stay off until you approve.</div>
        </Card>
      </div>
    </>
  );
}

/** Read-only status of the real server service. Never mixed with replay data. */
function LiveServiceCard({ L }) {
  const e = L?.engine;
  const fmt = (v, dp = 2) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp }));
  return (
    <Card title="Live server · real Kite data (observe only)" sub="Read-only. LIVE PAPER — NOT ENABLED: the live engine records signals but cannot place paper or real orders." style={{ marginBottom: 12 }}
      tools={<Badge tone="warn">LIVE PAPER — NOT ENABLED</Badge>}>
      {!L ? <div className="na-note">Checking the server…</div> : !L.enabled ? (
        <Reason tone="warn" tag="NOT OBSERVING">{L.reason}</Reason>
      ) : (
        <div className="na-grid na-two" style={{ gap: 18 }}>
          <KV rows={[
            ["Session date", L.date ?? "—"],
            ["Kite feed (shared stream)", L.stream?.connected ? `CONNECTED · ${L.stream.subscribed} instruments` : "IDLE (connects 09:00–15:45 on trading days)"],
            ["Previous session", L.prep ? `${L.prep.prevDate ?? "—"} · ${L.prep.prevBars ?? 0} bars · 15:15 close ${fmt(L.prep.prevClose1515)}` : "not loaded yet (08:50)"],
            ["Instrument master", L.prep ? `${L.prep.contracts ?? 0} contracts · ${(L.prep.expiries ?? []).join(", ")}` : "—"],
            ["Live engine", e ? `${e.engineStatus} · ${e.state.replaceAll("_", " ")}` : "not created (non-trading day or before 08:50)"],
            ["Pre-subscribed options", (L.presubscribed ?? []).length ? L.presubscribed.join(", ") : "none"],
          ]} />
          <KV rows={[
            ["Today's reference", fmt(e?.reference)],
            ["Gap", e?.gap ? `${e.gap.direction} ${fmt(e.gap.points)} pts · ${fmt(e.gap.pct, 4)}%` : "—"],
            ["Opening range", e?.or ? `${fmt(e.or.low)}–${fmt(e.or.high)} · bands ${fmt(e.or.downsideBand)} / ${fmt(e.or.upsideBand)}` : e ? `${e.orCollected}/31 closes` : "—"],
            ["Stand-down / handover", e?.standDown ? `${e.standDown.reason}${e.handover ? " → Williams" : ""}` : "—"],
            ["Signal (recorded, not traded)", e?.signal ? `${e.signal.bot} ${e.signal.right} · close ${fmt(e.signal.close)}` : "—"],
            ["Would select", e?.wouldSelect ? (e.wouldSelect.ok ? `${e.wouldSelect.tradingsymbol} (exp ${e.wouldSelect.expiry})` : e.wouldSelect.code) : "—"],
          ]} />
        </div>
      )}
    </Card>
  );
}
