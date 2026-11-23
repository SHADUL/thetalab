/** Risk & Settings — controls, execution/risk settings, and the locked research rules. */
import { useState } from "react";
import { useState as useStateR } from "react";
import { Play, Prohibit, Skull, LockOpen, Lock, Power } from "@phosphor-icons/react";
import { useAscent, ascent, defaultExec, btRules, liveNextRules } from "./store.js";
import { Card, WsHead, Badge, KV, Reason } from "./ui.jsx";
import { num } from "./format.js";
import { RESEARCH_RULES_V1, LIVE_PAPER_RULES } from "../../nifty-ascent/core/rules.ts";
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
  // Rules of the source on screen: live paper (V1 + owner-approved filters), backtest (V1 or its variant), simulation (V1).
  const R = S.source === "LIVE" ? (S.live?.settings?.session?.rules ?? liveNextRules() ?? LIVE_PAPER_RULES) : S.source === "BACKTEST" ? btRules() : RESEARCH_RULES_V1;
  const e = S.replay.engine;
  const [form, setForm] = useState(() => ({ ...S.exec }));
  const changed = FIELDS.some(([k]) => Number(form[k]) !== S.exec[k]);
  const save = () => ascent.setExec(Object.fromEntries(FIELDS.map(([k]) => [k, Number(form[k])])));
  return (
    <>
      <WsHead title="Risk & Settings" desc="Research rules are locked; execution and risk settings are adjustable and versioned. Every limit is enforced by the engine, not the page." />
      {S.source !== "LIVE" && (<>
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
        <Card title="Execution & risk settings" sub={`${S.source === "BACKTEST" ? "BACKTEST (defaults mirror live paper)" : "SIMULATION"} · version ${S.exec.version} · replay restarts from 09:10 and re-runs to the current time when saved`}
          tools={<><button className="na-chipbtn" onClick={() => { ascent.resetExec(); setForm(defaultExec(S.source)); }}>Defaults</button><button className="na-chipbtn" data-on={changed} disabled={!changed} onClick={save}>Save new version</button></>}>
          {FIELDS.map(([k, label, hint, step]) => (
            <div className="na-field" key={k} data-changed={Number(form[k]) !== S.exec[k] ? "true" : undefined}>
              <label htmlFor={`na-${k}`}>{label}</label>
              <small>{hint}</small>
              <input id={`na-${k}`} type="number" step={step} value={form[k]} onChange={(ev) => setForm({ ...form, [k]: ev.target.value })} />
            </div>
          ))}
        </Card>
      </div>
      </>)}
      {S.source === "LIVE" && <LiveSettingsCard L={S.live} />}
      {S.source === "LIVE" && <LivePaperControls L={S.live} />}
      <LiveServiceCard L={S.live} />
      <div className="na-grid na-two">
        <Card title={<span className="flex items-center gap-2"><Lock size={14} weight="bold" />Research rules {R.version}</span>} sub={`${S.source === "LIVE" ? "Live paper" : S.source === "BACKTEST" ? "Backtest" : "Simulation"} · fixed research specification (OptionsBuyer.in data + your Q1–Q15 decisions${R.minOrWidth || R.rollExpiryWithinDays ? " + the opening-range and expiry-roll filters" : ""}). Changing any of these requires a new strategy version.`}>
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
            ["Minimum opening range", R.minOrWidth ? `${R.minOrWidth} pts — narrower days are skipped (both bots)` : "off"],
            ["Day-before-expiry roll", R.rollExpiryWithinDays ? `nearest expiry ≤ ${R.rollExpiryWithinDays} day away → next expiry` : "off"],
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
    <Card title={`Live server · real Kite data (${L?.mode === "PAPER" ? "live paper" : "observe only"})`}
      sub={L?.mode === "PAPER" ? "Read-only status. Paper fills only — no real order can ever be sent." : "Read-only. LIVE PAPER — NOT ENABLED: the live engine records signals but cannot place paper or real orders."} style={{ marginBottom: 12 }}
      tools={<Badge tone={L?.mode === "PAPER" ? "accent" : "warn"}>{L?.mode === "PAPER" ? `LIVE PAPER · ${L.livePaper === "RUNNING" ? "RUNNING" : "READY · PAUSED"}` : "LIVE PAPER — NOT ENABLED"}</Badge>}>
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
            [L?.mode === "PAPER" ? "Signal" : "Signal (recorded, not traded)", e?.signal ? `${e.signal.bot} ${e.signal.right} · close ${fmt(e.signal.close)}` : "—"],
            ["Would select", e?.wouldSelect ? (e.wouldSelect.ok ? `${e.wouldSelect.tradingsymbol} (exp ${e.wouldSelect.expiry})` : e.wouldSelect.code) : "—"],
          ]} />
        </div>
      )}
    </Card>
  );
}

/** Owner controls for the LIVE PAPER engine on the server. Paper only — there is no order path. */
function LivePaperControls({ L }) {
  const [msg, setMsg] = useStateR(null);
  const [busy, setBusy] = useStateR(false);
  const paper = L?.enabled && L.mode === "PAPER";
  const P = L?.paper;
  const act = async (fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setMsg(null);
    const r = await fn();
    setMsg(r); setBusy(false);
  };
  return (
    <Card title="Live paper engine · server" sub="Real Kite quotes, PAPER fills only — no real Zerodha order can ever be sent" glow style={{ marginBottom: 12 }}
      tools={<Badge tone={paper ? (L.engine?.engineStatus === "RUNNING" ? "gain" : "accent") : "warn"}>{paper ? (L.engine?.engineStatus ?? "NO ENGINE YET") : "LIVE PAPER — NOT ENABLED"}</Badge>}>
      {!paper ? <Reason tone="warn" tag="OBSERVE ONLY">The server runs NIFTY ASCENT in observe mode. Live paper mode is switched on separately on the server, only after your approval.</Reason> : (
        <div className="na-grid na-two" style={{ gap: 16 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <button className="na-stop" data-kind="start" disabled={busy} onClick={() => act(() => ascent.liveControl("START"), "START the live PAPER engine for today? It will paper-trade NIFTY ASCENT on real Kite quotes. No real orders are ever placed.")}><Play size={18} weight="fill" />START LIVE PAPER</button>
            <button className="na-chipbtn" style={{ height: 40, justifyContent: "center" }} disabled={busy} onClick={() => act(() => ascent.liveControl("STOP_ENTRIES"))}><Prohibit size={15} />STOP NEW ENTRIES — keep managing the open position</button>
            <button className="na-stop" disabled={busy} onClick={() => act(() => ascent.liveControl("KILL"), "KILL / FLATTEN: block entries and close any open PAPER position at the first fresh bid?")}><Skull size={18} weight="fill" />KILL / FLATTEN</button>
            <button className="na-chipbtn" style={{ height: 34, justifyContent: "center" }} disabled={busy || !P?.killSwitch} onClick={() => act(() => ascent.liveControl("RELEASE"))}><LockOpen size={14} />Release kill switch</button>
            <button className="na-chipbtn" style={{ height: 38, justifyContent: "center" }} data-on={!!P?.autoStart} disabled={busy}
              onClick={() => act(() => ascent.setAutoStart(!P?.autoStart), P?.autoStart ? "Turn auto-start OFF? The paper engine will stay PAUSED each day until you press START." : "Turn auto-start ON? From now on the paper engine STARTS automatically each trading day (before 09:15) and paper-trades during market hours. Paper only.")}>
              <Power size={15} />Auto-start each trading day: <b>{P?.autoStart ? "ON" : "OFF"}</b>
            </button>
            {msg && <Reason tone={msg.ok ? "gain" : "loss"} tag={msg.ok ? "OK" : "REFUSED"}>{msg.message}</Reason>}
          </div>
          <KV rows={[
            ["Engine", L.engine ? `${L.engine.engineStatus} · ${L.engine.state.replaceAll("_", " ")}` : "not created yet (08:50 on trading days)"],
            ["Single-engine lease", P?.leaseOk ? "held by this server" : "NOT held — entries blocked", P?.leaseOk ? undefined : "loss"],
            ["Database", P?.store?.migrationApplied === false ? "migration NOT applied" : P?.storeOk ? "OK" : `ERROR — ${P?.store?.lastError ?? ""}`, P?.storeOk && P?.store?.migrationApplied !== false ? undefined : "loss"],
            ["Kill switch", P?.killSwitch ? "ON" : "off", P?.killSwitch ? "loss" : undefined],
            ["Auto-start", P?.autoStart ? "ON" : "OFF"],
            ["Entries blocked because", P?.blockedReason ?? "—"],
            ["Positions today", L.engine ? `${L.engine.positionsToday}/1` : "—"],
            ["Today's paper trade", L.engine?.trade ? `${L.engine.trade.tradingsymbol} · net ₹${Math.round(L.engine.trade.net)}` : "—"],
          ]} />
        </div>
      )}
    </Card>
  );
}

/**
 * Live paper execution & risk settings plus the two strategy filters, edited by the owner.
 * Saved on the server for the NEXT session that has not started yet; the running session's
 * settings are pinned for the day and never change mid-session. Paper only.
 */
function LiveSettingsCard({ L }) {
  const st = L?.settings;
  const next = st?.next;
  const [form, setForm] = useStateR(null);
  const [msg, setMsg] = useStateR(null);
  const [busy, setBusy] = useStateR(false);
  if (!L?.enabled) return null;
  if (!next) return <Card title="Live paper settings" style={{ marginBottom: 12 }}><Reason tone="warn" tag="UNAVAILABLE">The server has not reported its live settings yet (older server version or service not running).</Reason></Card>;
  const base = { ...Object.fromEntries(FIELDS.map(([k]) => [k, next.exec[k]])), minOrWidth: next.variant.minOrWidth, rollExpiryWithinDays: next.variant.rollExpiryWithinDays };
  const f = form ?? base;
  const changed = Object.keys(base).some((k) => Number(f[k]) !== Number(base[k]));
  const set = (patch) => { setForm({ ...f, ...patch }); setMsg(null); };
  const sess = st.session;
  const save = async () => {
    const execPatch = Object.fromEntries(FIELDS.map(([k]) => [k, Number(f[k])]));
    const variant = { minOrWidth: Number(f.minOrWidth), rollExpiryWithinDays: Number(f.rollExpiryWithinDays) };
    const lines = Object.keys(base).filter((k) => Number(f[k]) !== Number(base[k])).map((k) => `${k}: ${base[k]} → ${f[k]}`).join("\n");
    if (!window.confirm(`Save these LIVE PAPER settings?\n\n${lines}\n\nThey apply from the next session that has not started yet${sess ? ` (today's ${sess.date} session keeps ${sess.configVersion})` : ""}. Paper only — no real orders.`)) return;
    setBusy(true);
    const r = await ascent.saveLiveSettings({ exec: execPatch, variant });
    setMsg(r); setBusy(false);
    if (r.ok) setForm(null);
  };
  const orOn = Number(f.minOrWidth) > 0, rollOn = Number(f.rollExpiryWithinDays) > 0;
  return (
    <Card title="Live paper · execution, risk & strategy filters" glow style={{ marginBottom: 12 }}
      sub={`Next session: ${next.rules.version} / ${next.exec.version}${next.savedAt ? ` · saved ${new Date(next.savedAt).toLocaleString("en-IN")}` : " · built-in defaults"}${sess ? ` · today's ${sess.date} session is fixed at ${sess.configVersion}` : ""}`}
      tools={<><button className="na-chipbtn" disabled={!changed || busy} onClick={() => { setForm(null); setMsg(null); }}>Discard</button><button className="na-chipbtn" data-on={changed} disabled={!changed || busy} onClick={save}>Save for next session</button></>}>
      <div className="na-grid na-two" style={{ gap: 16 }}>
        <div>
          {FIELDS.map(([k, label, hint, step]) => (
            <div className="na-field" key={k} data-changed={Number(f[k]) !== Number(base[k]) ? "true" : undefined}>
              <label htmlFor={`na-live-${k}`}>{label}</label>
              <small>{hint}</small>
              <input id={`na-live-${k}`} type="number" step={step} value={f[k]} disabled={busy} onChange={(ev) => set({ [k]: ev.target.value })} />
            </div>
          ))}
        </div>
        <div>
          <div className="na-field" data-changed={Number(f.minOrWidth) !== Number(base.minOrWidth) ? "true" : undefined}>
            <label htmlFor="na-live-or">Skip narrow opening range</label>
            <small>No trade that day (either bot) when the 09:15–09:45 range is narrower than this many points.</small>
            <div className="flex items-center gap-2">
              <button className="na-chipbtn" data-on={orOn ? "true" : undefined} disabled={busy} onClick={() => set({ minOrWidth: orOn ? 0 : 60 })}>{orOn ? "On" : "Off"}</button>
              <input id="na-live-or" type="number" min={0} step={5} value={f.minOrWidth} disabled={busy || !orOn} style={{ width: 64 }} onChange={(ev) => set({ minOrWidth: ev.target.value })} aria-label="Minimum opening-range width in points" />
            </div>
          </div>
          <div className="na-field" data-changed={Number(f.rollExpiryWithinDays) !== Number(base.rollExpiryWithinDays) ? "true" : undefined}>
            <label>Day before expiry → next expiry</label>
            <small>When the nearest weekly expiry is 1 day away, buy the following week&apos;s contract. Expiry day itself always rolls.</small>
            <button className="na-chipbtn" data-on={rollOn ? "true" : undefined} disabled={busy} onClick={() => set({ rollExpiryWithinDays: rollOn ? 0 : 1 })}>{rollOn ? "On" : "Off"}</button>
          </div>
          <div className="na-note" style={{ marginTop: 8 }}>
            Saved settings apply from the next session that has not started yet (the engine is created at 08:50 on trading days). A running session keeps its settings for the whole day, so a restart mid-day can never change them. Backtest 2024–2026: the opening-range filter helped only in 2026 and cut profit in 2024 and 2025; the expiry roll was mixed.
          </div>
          {msg && <Reason tone={msg.ok ? "gain" : "loss"} tag={msg.ok ? "SAVED" : "REFUSED"}>{msg.message}</Reason>}
        </div>
      </div>
    </Card>
  );
}
