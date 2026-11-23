/** Williams workspace — the conditional backup bot. */
import { useAscent, view } from "./store.js";
import { Card, Badge, WsHead, KV, Reason, SideBadge } from "./ui.jsx";
import { lastIndex } from "./derive.js";
import { num, pct, hm, istTime, dur, REASON_LABEL } from "./format.js";
import { barStart, RESEARCH_RULES_V1 as R } from "../../nifty-ascent/core/rules.ts";

function bucket(e) {
  if (!e.gap) return null;
  if (e.gap.direction === "NONE") return "none";
  return e.williamsEligible ? (e.gap.pct < 0.35 ? "small" : "large") : "mid";
}

export default function Williams() {
  const S = useAscent();
  const { engine: e, now } = view(S);
  const w = e.williams, px = lastIndex(e)?.price;
  const armed = e.state === "WILLIAMS_ARMED";
  const active = !!e.handover;
  const sigW = e.signal?.bot === "WILLIAMS" ? e.signal : null;
  const b = bucket(e);
  const noBreak = e.standDown?.reason === "no_break";
  const msToCut = barStart(e.date, R.williamsLastBar + 1) - now;
  const status = sigW ? { tone: "gain", tag: "TRIGGERED", text: `First trigger: close ${num(sigW.close, 2)} ${sigW.right === "CE" ? ">" : "<"} ${num(sigW.level, 2)} at ${hm(sigW.bar)} → BUY ${sigW.right}${sigW.bar === e.handover?.bar ? " (same bar as the handover — Q15)" : ""}.` }
    : armed ? { tone: "accent", tag: "ARMED", text: `Evaluating confirmed closes from ${hm(e.williamsStartBar)} through 14:29. The first level to break wins, regardless of the original gap direction.` }
    : e.outcome?.reason === "williams_no_trigger" ? { tone: "warn", tag: "NO TRIGGER", text: "Neither Williams level broke by the 14:29 close." }
    : noBreak ? { tone: "warn", tag: "NOT ACTIVATED", text: "Gap-and-Go ended with `no_break`, which never activates Williams (Q4)." }
    : e.standDown && !e.williamsEligible ? { tone: "loss", tag: "FORBIDDEN", text: `Gap ${pct(e.gap.pct, 4, { sign: false })} is in [0.2%, 0.5%) — Williams may not trade today.` }
    : e.signal?.bot === "GAP_AND_GO" ? { tone: undefined, tag: "NOT NEEDED", text: "Gap-and-Go took the day's trade; Williams never runs after a Gap-and-Go entry." }
    : e.outcome?.reason === "no_gap" ? { tone: "warn", tag: "NOT ACTIVATED", text: "Zero gap — no Gap-and-Go stand-down, so no Williams (Q14)." }
    : { tone: undefined, tag: "INACTIVE", text: "Williams stays inactive unless Gap-and-Go stands down with `opposite_first` or `filled` and the gap size is eligible." };

  const rows = [
    { id: "small", cond: "Gap below 0.2%", res: "eligible after a qualifying handover", ok: true },
    { id: "mid", cond: "Gap 0.2% to below 0.5%", res: "ineligible", ok: false },
    { id: "large", cond: "Gap 0.5% or above", res: "eligible after a qualifying handover", ok: true },
    { id: "nobreak", cond: "Gap-and-Go `no_break`", res: "ineligible regardless of gap size", ok: false },
  ];
  const todayRow = noBreak ? "nobreak" : b;

  return (
    <>
      <WsHead title="Williams" desc="Backup bot · only after `opposite_first` or `filled` · gap < 0.2% or ≥ 0.5% · levels = 09:15 reference ± 50% of the previous day's close range · until 14:29" />
      <div className="na-grid na-split-l" style={{ marginBottom: 12 }}>
        <Card title="Williams levels" sub="Previous day's highest and lowest 1-minute CLOSE (not candle highs/lows)" glow inactive={!active && !sigW ? "INACTIVE" : undefined}>
          <div className="na-grid na-two" style={{ gap: 14 }}>
            <KV rows={[
              ["Previous day", e.prev.date],
              ["Highest 1-min close", w ? num(w.prevHighClose, 2) : "—"],
              ["Lowest 1-min close", w ? num(w.prevLowClose, 2) : "—"],
              ["Range R", w ? num(w.range, 2) : "—"],
              ["Today's reference", e.reference ? num(e.reference.price, 2) : "—"],
            ]} />
            <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
              <div className="na-card" style={{ padding: 12, boxShadow: "none" }}>
                <div className="lbl">CE trigger · ref + 0.5 R</div>
                <div className="na-big na-ce">{w ? num(w.ceLevel, 2) : "—"}</div>
                <div className="na-note">{w && px != null ? (px > w.ceLevel ? `NIFTY is ${num(px - w.ceLevel, 2)} pts above this level` : `${num(w.ceLevel - px, 2)} pts above NIFTY`) : ""}</div>
              </div>
              <div className="na-card" style={{ padding: 12, boxShadow: "none" }}>
                <div className="lbl">PE trigger · ref − 0.5 R</div>
                <div className="na-big na-pe">{w ? num(w.peLevel, 2) : "—"}</div>
                <div className="na-note">{w && px != null ? (px < w.peLevel ? `NIFTY is ${num(w.peLevel - px, 2)} pts below this level` : `${num(px - w.peLevel, 2)} pts below NIFTY`) : ""}</div>
              </div>
            </div>
          </div>
        </Card>
        <Card title="Eligibility matrix" sub={e.gap ? `Today: gap ${pct(e.gap.pct, 4, { sign: false })} ${e.gap.direction}` : "Today's gap is measured at 09:15"}>
          <div className="na-matrix">
            {rows.map((r) => (
              <div key={r.id} className="na-mrow" data-today={todayRow === r.id ? "true" : undefined}>
                <div><b>{r.cond}</b><div className="na-muted" style={{ fontSize: 11 }}>{r.res}</div></div>
                <Badge tone={r.ok ? "gain" : "loss"}>{r.ok ? "eligible" : "blocked"}</Badge>
              </div>
            ))}
          </div>
          <div className="na-note" style={{ marginTop: 10 }}>Boundaries are exact: 0.1999% eligible · 0.2000% blocked · 0.4999% blocked · 0.5000% eligible.</div>
        </Card>
      </div>
      <div className="na-grid na-two">
        <Card title="Handover" sub="Gap-and-Go stand-down is processed first, then eligibility, then the Williams trigger on the same bar">
          <KV rows={[
            ["Gap-and-Go stand-down", e.standDown ? `${e.standDown.reason} · ${hm(e.standDown.bar)} · close ${num(e.standDown.close, 2)}` : "—", e.standDown ? "warn" : undefined],
            ["Handover reason", e.handover ? e.handover.reason : "—"],
            ["Handover bar / time", e.handover ? `${hm(e.handover.bar)} · confirmed ${istTime(e.handover.at)}` : "—"],
            ["Williams evaluation starts", e.williamsStartBar != null ? `${hm(e.williamsStartBar)} (the handover bar itself)` : "—"],
            ["Cutoff", `14:29 bar${armed && msToCut > 0 ? ` · ${dur(Math.ceil(msToCut / 1000))} left` : ""}`],
            ["Distance to CE / PE", armed && w && px != null ? `${num(w.ceLevel - px, 2)} / ${num(px - w.peLevel, 2)} pts` : "—"],
          ]} />
        </Card>
        <Card title="Williams state">
          <Reason tone={status.tone} tag={status.tag}>{status.text}</Reason>
          {sigW && <div className="flex items-center gap-2" style={{ marginTop: 10 }}><SideBadge right={sigW.right} lg /><span className="na-muted" style={{ fontSize: 12 }}>enters on the next bar · one Williams trade only</span></div>}
          {e.outcome && !sigW && <div className="na-note" style={{ marginTop: 10 }}>Session outcome: {REASON_LABEL[e.outcome.reason] ?? e.outcome.reason}</div>}
        </Card>
      </div>
    </>
  );
}
