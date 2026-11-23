/** Command Center — the flagship NIFTY ASCENT dashboard. */
import { useAscent, ascent, view } from "./store.js";
import { Card, Kpi, Badge, PnL, SideBadge, Timeline, WsHead, KV, Reason, Check } from "./ui.jsx";
import AscentChart, { OverlayToggles } from "./AscentChart.jsx";
import { flow, FLOW_TITLES, explain, nextAction, lastIndex, positionPnl } from "./derive.js";
import { num, pct, hm, istTime, BOT_LABEL, REASON_LABEL } from "./format.js";

function FlowStrip({ e }) {
  const nodes = flow(e);
  return (
    <div className="na-flow" role="list" aria-label="Strategy flow">
      {nodes.map((n, i) => (
        <div key={i} className="na-node" data-s={n.s} role="listitem" aria-current={n.s === "active" ? "step" : undefined}>
          <div className="na-node-n"><span className="na-node-dot" />{String(i + 1).padStart(2, "0")} · {n.s === "done" ? "done" : n.s === "active" ? "now" : n.s === "blocked" ? "stopped" : n.s === "skipped" ? "skipped" : "waiting"}</div>
          <div className="na-node-t">{FLOW_TITLES[i]}</div>
          <div className="na-node-v">{n.v}</div>
        </div>
      ))}
    </div>
  );
}

export function DecisionPanel({ e, now }) {
  const ix = lastIndex(e);
  const px = ix?.price;
  const ex = explain(e, now);
  const up = e.gap?.direction === "UP";
  const lvl = e.state === "GAP_GO_ARMED" && e.or ? (up ? e.or.upsideBand : e.or.downsideBand) : null;
  const dist = lvl != null && px != null ? (up ? lvl - px : px - lvl) : null;
  const oppHit = e.standDown?.reason === "opposite_first";
  return (
    <Card title="Decision panel" sub="Why the engine is doing what it is doing" glow>
      <div style={{ display: "grid", gap: 12 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge lg tone={e.activeBot === "WILLIAMS" ? "accent" : e.activeBot ? "gain" : undefined}>{e.activeBot ? BOT_LABEL[e.activeBot] : "No bot active"}</Badge>
          <Badge tone={e.state === "DATA_ERROR" ? "loss" : undefined}>{e.state.replaceAll("_", " ")}</Badge>
        </div>
        <Reason tone={ex.tone} tag={ex.tag}>{ex.text}</Reason>
        <KV rows={[
          ["Directional gap bias", e.gap ? `${e.gap.direction === "UP" ? "▲ UP → CE only" : e.gap.direction === "DOWN" ? "▼ DOWN → PE only" : "◆ none"}` : "—"],
          ["OR width", e.or ? `${num(e.or.width, 2)} pts` : `${e.orCollected}/31 closes`],
          ["Current breakout level", lvl != null ? num(lvl, 2) : e.williams && e.state === "WILLIAMS_ARMED" ? `CE ${num(e.williams.ceLevel, 2)} / PE ${num(e.williams.peLevel, 2)}` : e.signal ? `${num(e.signal.level, 2)} (triggered ${hm(e.signal.bar)})` : "—"],
          ["Distance to trigger", dist != null && e.state === "GAP_GO_ARMED" ? `${num(dist, 2)} pts` : e.state === "WILLIAMS_ARMED" && px != null ? `CE ${num(e.williams.ceLevel - px, 2)} · PE ${num(px - e.williams.peLevel, 2)}` : "—"],
          ["Opposite band", e.or ? (oppHit ? `BROKEN first at ${hm(e.standDown.bar)}` : "not broken") : "—", oppHit ? "warn" : undefined],
          ["Gap filled", e.gapFill ? `YES · ${istTime(e.gapFill.exchTs)} @ ${num(e.gapFill.price, 2)}` : e.gap ? "not yet" : "—", e.gapFill ? "warn" : undefined],
          ["Williams eligibility (gap size)", e.williamsEligible == null ? "—" : e.williamsEligible ? `eligible · ${pct(e.gap.pct, 4, { sign: false })}` : `forbidden · ${pct(e.gap.pct, 4, { sign: false })}`, e.williamsEligible === false ? "loss" : undefined],
          ["Williams levels", e.williams ? `CE > ${num(e.williams.ceLevel, 2)} · PE < ${num(e.williams.peLevel, 2)}` : "—"],
          ["Entry eligibility", e.positionsToday >= 1 ? "used (1/1 today)" : e.entriesAllowed ? "allowed" : `blocked · engine ${e.engineStatus}`],
          ["Next action", nextAction(e)],
        ]} />
      </div>
    </Card>
  );
}

export default function CommandCenter() {
  const S = useAscent();
  const { engine: e, now, live } = view(S);
  const ix = lastIndex(e);
  const pnl = e.trade ? e.trade.net : positionPnl(e)?.gross ?? null;
  const f = ascent.fixture();
  return (
    <>
      <WsHead title="Command Center" desc={live ? <>LIVE PAPER view — real NIFTY data from the server engine (read-only mirror). Session {e.date}.</> : <>Fixture <b>{f.title}</b> — {f.summary}</>} />
      <div className="na-grid na-kpis10" style={{ marginBottom: 12 }}>
        <Kpi label="NIFTY" value={ix ? num(ix.price, 2) : "—"} sub={ix ? `${ix.forming ? "forming" : "last close"} · ${istTime(ix.ts)}` : "waiting"} />
        <Kpi label="Prev 15:15 close" value={num(e.prevClose, 2)} sub={`${e.prev.date} · bar 15:15`} />
        <Kpi label="Today 09:15 ref" value={e.reference ? num(e.reference.price, 2) : "—"} sub={e.reference ? `first tick ${istTime(e.reference.exchTs, true)}` : "first tick ≥ 09:15:00"} />
        <Kpi label="Gap points" value={e.gap ? num(e.gap.points, 2, { sign: true }) : "—"} tone={e.gap ? (e.gap.points > 0 ? "gain" : e.gap.points < 0 ? "loss" : undefined) : undefined} />
        <Kpi label="Gap %" value={e.gap ? pct(e.gap.pct, 4, { sign: false }) : "—"} sub={e.williamsEligible == null ? "" : e.williamsEligible ? "Williams-eligible size" : "Williams-forbidden size"} />
        <Kpi label="Direction" value={e.gap ? (e.gap.direction === "UP" ? "▲ UP" : e.gap.direction === "DOWN" ? "▼ DOWN" : "◆ NONE") : "—"} tone={e.gap?.direction === "UP" ? "gain" : e.gap?.direction === "DOWN" ? "loss" : undefined} />
        <Kpi label="Active bot" value={e.activeBot ? BOT_LABEL[e.activeBot] : "—"} sub={e.standDown ? `G&G stood down: ${e.standDown.reason}` : ""} />
        <Kpi label="Signal" value={e.signal ? <SideBadge right={e.signal.right} /> : "—"} sub={e.signal ? `${hm(e.signal.bar)} close ${num(e.signal.close, 2)}` : ""} />
        <Kpi label="Positions today" value={`${e.positionsToday}/1`} sub="across both bots" />
        <Kpi label="Paper P&L" value={<PnL value={pnl} />} sub={e.trade ? "net, after costs" : e.position ? "gross mark at bid" : "no position"} />
      </div>

      <Card title="Strategy flow" sub="Opening range → Gap-and-Go → handover check → Williams → entry → position → exit" className="mb-3" style={{ marginBottom: 12 }}>
        <FlowStrip e={e} />
      </Card>

      <div className="na-grid na-cc-main" style={{ marginBottom: 12 }}>
        <Card title="NIFTY · 1-minute" sub="Signals use confirmed 1-minute CLOSES only; the grey candle is still forming" tools={<OverlayToggles />} bodyClass="">
          <div style={{ padding: "6px 4px 2px" }}><AscentChart kind="index" height={430} /></div>
        </Card>
        <DecisionPanel e={e} now={now} />
      </div>

      <div className="na-grid na-split-l">
        <Card title="State-transition timeline" sub="Every transition with its bar, trigger, prices and config version">
          <Timeline events={e.events} limit={14} />
        </Card>
        <Card title="Session outcome">
          {e.outcome ? (
            <div style={{ display: "grid", gap: 10 }}>
              <Reason tone={e.outcome.kind === "TRADE" ? ((e.trade?.net ?? 0) >= 0 ? "gain" : "loss") : e.outcome.kind === "DATA_ERROR" ? "loss" : "warn"} tag={e.outcome.kind.replace("_", " ")}>
                {REASON_LABEL[e.outcome.reason] ?? e.outcome.reason}{e.outcome.detail ? <div className="na-muted" style={{ marginTop: 3 }}>{e.outcome.detail}</div> : null}
              </Reason>
              {e.trade && <KV rows={[
                ["Bot", BOT_LABEL[e.trade.bot]], ["Contract", e.trade.tradingsymbol], ["Entry → exit", `₹${num(e.trade.entryPremium, 2)} → ₹${num(e.trade.exitPremium, 2)}`],
                ["Gross", <PnL key="g" value={e.trade.gross} />], ["Costs", `₹${num(e.trade.costs, 2)}`], ["Net", <PnL key="n" value={e.trade.net} />],
              ]} />}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="na-rule"><Check ok={!!e.or} /><span>Opening range complete (31/31)</span><span className="na-muted n">{e.orCollected}/31</span></div>
              <div className="na-rule"><Check ok={!!e.standDown || !!e.signal} /><span>Gap-and-Go decided</span><span className="na-muted">{e.signal?.bot === "GAP_AND_GO" ? "signal" : e.standDown?.reason ?? "pending"}</span></div>
              <div className="na-rule"><Check ok={e.positionsToday > 0} /><span>Position taken</span><span className="na-muted">{e.positionsToday}/1</span></div>
              <div className="na-note">The session is still running in the replay.</div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
