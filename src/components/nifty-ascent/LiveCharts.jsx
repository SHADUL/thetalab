/** Live Charts — NIFTY and the traded option's premium, 1-minute. */
import { useAscent } from "./store.js";
import { Card, Kpi, WsHead, Badge } from "./ui.jsx";
import AscentChart, { OverlayToggles } from "./AscentChart.jsx";
import { lastIndex, premiumNow } from "./derive.js";
import { num, pct, secs, istTime } from "./format.js";

export default function LiveCharts() {
  const S = useAscent();
  const e = S.replay.engine, now = S.replay.t;
  const ix = lastIndex(e);
  const q = premiumNow(e);
  const p = e.position, t = e.trade;
  const entry = p?.entryPremium ?? t?.entryPremium;
  const prem = q?.ltp ?? t?.exitPremium ?? null;
  const chg = entry && prem != null ? ((prem - entry) / entry) * 100 : null;
  const bars = e.index.bars;
  const missing = bars.filter((b) => b.status === "MISSING").length;
  const pb = e.premiumBars();
  const noPrint = pb.filter((b) => b.status === "NO_PRINT").length;
  return (
    <>
      <WsHead title="Live Charts" desc="Signals use confirmed 1-minute closes; the premium chart switches to the traded contract automatically" />
      <div className="na-grid na-kpis" style={{ marginBottom: 12 }}>
        <Kpi label="NIFTY" value={ix ? num(ix.price, 2) : "—"} sub={ix ? istTime(ix.ts) : ""} />
        <Kpi label="Contract" value={p || t ? `${p?.instrument.strike ?? t.strike} ${p?.right ?? t.right}` : "—"} sub={p || t ? `exp ${p?.instrument.expiry ?? t.expiry} · ${p ? "open" : "closed"}` : "no position"} />
        <Kpi label="Premium" value={prem != null ? `₹${num(prem, 2)}` : "—"} sub={q ? `bid ${num(q.bid, 2)} · ask ${num(q.ask, 2)}` : ""} />
        <Kpi label="Change vs entry" value={chg != null ? pct(chg, 2) : "—"} tone={chg > 0 ? "gain" : chg < 0 ? "loss" : undefined} />
        <Kpi label="Quote freshness" value={q?.ts ? secs(now - q.ts) : "—"} sub="limit 2.0 s for fills" tone={q?.ts && now - q.ts > 2000 ? "warn" : undefined} />
        <Kpi label="Index bars" value={`${bars.length}`} sub={`${missing} missing`} tone={missing ? "warn" : undefined} />
        <Kpi label="Premium bars" value={`${pb.length}`} sub={`${noPrint} NO_PRINT (no stop decision)`} />
        <Kpi label="Feed" value={<Badge tone="warn">SIMULATION</Badge>} sub="Kite stream not used in Phase 2" />
      </div>
      <Card title="NIFTY · 1-minute" tools={<OverlayToggles />} bodyClass="" style={{ marginBottom: 12 }}>
        <div style={{ padding: "6px 4px 2px" }}><AscentChart kind="index" height={360} /></div>
      </Card>
      <Card title={`Option premium · 1-minute LTP closes${p || t ? ` · ${(p?.instrument.tradingsymbol ?? t.tradingsymbol)}` : ""}`} sub="Entry, −30% fixed stop, 105% trail activation, highest close and live trail stop" bodyClass="">
        <div style={{ padding: "6px 4px 2px" }}><AscentChart kind="premium" height={300} /></div>
      </Card>
    </>
  );
}
