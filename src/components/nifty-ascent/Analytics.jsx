/** Analytics — computed only from recorded sessions; sources never mixed. */
import { useEffect, useMemo, useState } from "react";
import { useAscent, ascent } from "./store.js";
import { Card, Kpi, WsHead, PnL, Spark, Badge } from "./ui.jsx";
import { num, pct, dur, BOT_LABEL, EXIT_LABEL, REASON_LABEL } from "./format.js";

function stats(trades) {
  const n = trades.length;
  const w = trades.filter((t) => t.net > 0), l = trades.filter((t) => t.net <= 0);
  const gw = w.reduce((s, t) => s + t.net, 0), gl = -l.reduce((s, t) => s + t.net, 0);
  let peak = 0, cum = 0, dd = 0; const curve = [0];
  for (const t of trades) { cum += t.net; curve.push(cum); peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return {
    n, win: n ? (w.length / n) * 100 : null, gross: trades.reduce((s, t) => s + t.gross, 0), net: cum, avgW: w.length ? gw / w.length : null, avgL: l.length ? -gl / l.length : null,
    pf: gl > 0 ? gw / gl : null, dd, curve, hold: n ? trades.reduce((s, t) => s + (t.exitAt - t.entryAt) / 1000, 0) / n : null,
  };
}

function Compare({ title, groups }) {
  return (
    <Card title={title} bodyClass="">
      <table className="na-table">
        <thead><tr><th>Group</th><th className="r">Trades</th><th className="r">Win %</th><th className="r">Net</th><th className="r">Avg net</th></tr></thead>
        <tbody>{groups.map(([label, ts]) => { const s = stats(ts); return (
          <tr key={label}><td>{label}</td><td className="r">{s.n}</td><td className="r">{s.win == null ? "—" : `${num(s.win, 0)}%`}</td><td className="r"><PnL value={s.n ? s.net : null} /></td><td className="r"><PnL value={s.n ? s.net / s.n : null} /></td></tr>
        ); })}</tbody>
      </table>
    </Card>
  );
}

export default function Analytics() {
  useAscent();
  const [source, setSource] = useState("REPLAY");
  const runs = ascent.runs();
  const { trades, sessions } = useMemo(() => ({ trades: runs.map((r) => r.engine.trade).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date)), sessions: runs.map((r) => r.engine) }), [runs]);
  const s = stats(trades);
  const reasons = {}, elig = { eligible: 0, forbidden: 0, notReached: 0 };
  for (const e of sessions) {
    if (e.standDown) reasons[e.standDown.reason] = (reasons[e.standDown.reason] ?? 0) + 1;
    if (!e.standDown || e.standDown.reason === "no_break") elig.notReached++;
    else if (e.williamsEligible) elig.eligible++;
    else elig.forbidden++;
  }
  const exits = {}; for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  const noTrade = sessions.filter((e) => !e.trade).length;
  const by = (f) => (v) => trades.filter((t) => f(t) === v);
  return (
    <>
      <WsHead title="Analytics" desc="Calculated only from recorded sessions. Replay, live paper and historical research are separate and never combined.">
        <div className="na-seg" role="group" aria-label="Source">
          {[["REPLAY", "Replay (simulation)"], ["LIVE", "Live paper"], ["HIST", "Historical research"]].map(([k, l]) => <button key={k} data-on={source === k} onClick={() => setSource(k)}>{l}</button>)}
        </div>
      </WsHead>
      {source === "LIVE" ? <LiveAnalytics /> : source !== "REPLAY" ? (
        <Card><div className="na-note" style={{ padding: 18 }}>Historical research mode is optional and not built. It would replay real NIFTY 1-minute history for the signal side; option premiums would be modelled and labelled as such. No numbers are shown rather than invented ones.</div></Card>
      ) : (
        <>
          <div className="na-banner" style={{ marginBottom: 12 }}><Badge tone="warn">SIMULATION</Badge><span>These figures come from {sessions.length} hand-built fixture sessions designed to exercise each rule. They say nothing about how the strategy performs on real markets.</span></div>
          <div className="na-grid na-kpis" style={{ marginBottom: 12 }}>
            <Kpi label="Paper trades" value={s.n} sub={`${trades.filter((t) => t.bot === "GAP_AND_GO").length} Gap-and-Go · ${trades.filter((t) => t.bot === "WILLIAMS").length} Williams`} />
            <Kpi label="Win rate" value={s.win == null ? "—" : pct(s.win, 0, { sign: false })} />
            <Kpi label="Gross P&L" value={<PnL value={s.gross} />} />
            <Kpi label="Net P&L" value={<PnL value={s.net} />} sub="after modelled costs" />
            <Kpi label="Avg winner / loser" value={<><PnL value={s.avgW} /> <span className="na-faint">/</span> <PnL value={s.avgL} /></>} />
            <Kpi label="Profit factor" value={s.pf == null ? "—" : num(s.pf, 2)} />
            <Kpi label="Max drawdown" value={<PnL value={s.dd} />} />
            <Kpi label="Avg holding" value={s.hold == null ? "—" : dur(Math.round(s.hold))} sub={`${noTrade} no-trade days`} />
          </div>
          <div className="na-grid na-split-l" style={{ marginBottom: 12 }}>
            <Card title="Equity curve (net, replay)" sub="Cumulative net P&L by fixture date">
              <Spark values={s.curve} height={150} baseline={0} color={s.net >= 0 ? "var(--c-gain)" : "var(--c-loss)"} />
            </Card>
            <Card title="Exits and stand-downs">
              <div style={{ display: "grid", gap: 8 }}>
                {Object.entries(EXIT_LABEL).map(([k, l]) => <div key={k} className="na-rule"><span /><span>{l}</span><b className="n">{exits[k] ?? 0}</b></div>)}
                <div className="lbl" style={{ marginTop: 6 }}>Gap-and-Go stand-downs</div>
                {["opposite_first", "filled", "no_break"].map((k) => <div key={k} className="na-rule"><span /><span>{REASON_LABEL[k]}</span><b className="n">{reasons[k] ?? 0}</b></div>)}
                <div className="lbl" style={{ marginTop: 6 }}>Williams eligibility after a qualifying handover</div>
                <div className="na-rule"><span /><span>Eligible / forbidden / no qualifying handover</span><b className="n">{elig.eligible} / {elig.forbidden} / {elig.notReached}</b></div>
              </div>
            </Card>
          </div>
          <div className="na-grid na-three">
            <Compare title="Gap-and-Go vs Williams" groups={["GAP_AND_GO", "WILLIAMS"].map((b) => [BOT_LABEL[b], by((t) => t.bot)(b)])} />
            <Compare title="CE vs PE" groups={["CE", "PE"].map((r) => [r, by((t) => t.right)(r)])} />
            <Compare title="Gap up vs gap down" groups={["UP", "DOWN"].map((d) => [`Gap ${d}`, by((t) => t.gapDirection)(d)])} />
            <Compare title="Small vs large gaps" groups={[["< 0.2%", trades.filter((t) => t.gapPct < 0.2)], ["0.2–0.5%", trades.filter((t) => t.gapPct >= 0.2 && t.gapPct < 0.5)], ["≥ 0.5%", trades.filter((t) => t.gapPct >= 0.5)]]} />
            <Compare title="Entry time of day" groups={[["Before 11:00", trades.filter((t) => t.signalBar < 660)], ["11:00–13:00", trades.filter((t) => t.signalBar >= 660 && t.signalBar < 780)], ["After 13:00", trades.filter((t) => t.signalBar >= 780)]]} />
            <Compare title="Exit type" groups={Object.keys(EXIT_LABEL).map((k) => [EXIT_LABEL[k], by((t) => t.exitReason)(k)])} />
          </div>
        </>
      )}
    </>
  );
}

/** LIVE PAPER statistics from the server's filled paper trades only. */
function LiveAnalytics() {
  const S = useAscent();
  useEffect(() => { ascent.loadLiveHistory(); }, []);
  const trades = [...(S.liveHistory?.trades ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const s = stats(trades);
  if (!trades.length) return <Card><div className="na-note" style={{ padding: 18 }}>{S.liveHistory ? "No live paper trades recorded yet. Statistics appear once real paper trades exist — none are invented." : "Loading…"}</div></Card>;
  return (
    <>
      <div className="na-banner" data-tone="accent" style={{ marginBottom: 12 }}><Badge tone="accent">LIVE PAPER</Badge><span>{trades.length} paper trade(s) on real Kite data. A small sample says little about long-run performance.</span></div>
      <div className="na-grid na-kpis" style={{ marginBottom: 12 }}>
        <Kpi label="Paper trades" value={s.n} /><Kpi label="Win rate" value={s.win == null ? "—" : pct(s.win, 0, { sign: false })} />
        <Kpi label="Gross P&L" value={<PnL value={s.gross} />} /><Kpi label="Net P&L" value={<PnL value={s.net} />} />
        <Kpi label="Avg winner / loser" value={<><PnL value={s.avgW} /> <span className="na-faint">/</span> <PnL value={s.avgL} /></>} />
        <Kpi label="Profit factor" value={s.pf == null ? "—" : num(s.pf, 2)} /><Kpi label="Max drawdown" value={<PnL value={s.dd} />} />
        <Kpi label="Avg holding" value={s.hold == null ? "—" : dur(Math.round(s.hold))} />
      </div>
      <Card title="Equity curve (net, live paper)"><Spark values={s.curve} height={150} baseline={0} color={s.net >= 0 ? "var(--c-gain)" : "var(--c-loss)"} /></Card>
    </>
  );
}
