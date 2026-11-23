/** Trade Journal — blotter of replay sessions with a full audit drawer. */
import { useEffect, useMemo, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useAscent, ascent } from "./store.js";
import { Card, Badge, WsHead, PnL, Timeline, KV, Reason } from "./ui.jsx";
import { num, pct, hm, istTime, BOT_LABEL, EXIT_LABEL, REASON_LABEL } from "./format.js";

const COLS = [
  ["date", "Date"], ["bot", "Bot"], ["gapPct", "Gap %"], ["gapDirection", "Gap"], ["signal", "Signal"], ["entry", "Entry"], ["exit", "Exit"],
  ["right", "CE/PE"], ["strike", "Strike"], ["expiry", "Expiry"], ["qty", "Qty"], ["entryPremium", "Entry ₹"], ["exitPremium", "Exit ₹"],
  ["gross", "Gross"], ["costs", "Costs"], ["net", "Net"], ["returnPct", "Return"], ["exitReason", "Exit reason"], ["strategyVersion", "Version"],
];

export default function TradeJournal() {
  useAscent();
  const runs = ascent.runs();
  const [source, setSource] = useState("REPLAY");
  const [showNoTrade, setShowNoTrade] = useState(true);
  const [bot, setBot] = useState("ALL");
  const [sort, setSort] = useState({ k: "date", dir: 1 });
  const [sel, setSel] = useState(null);
  const rows = useMemo(() => runs.map(({ fixture, engine: e }) => ({ fixture, e, t: e.trade })), [runs]);
  const shown = rows
    .filter((r) => (showNoTrade || r.t) && (bot === "ALL" || (r.t?.bot ?? r.e.signal?.bot) === bot))
    .sort((a, b) => {
      const va = sort.k === "date" ? a.fixture.date : a.t?.[sort.k] ?? -Infinity, vb = sort.k === "date" ? b.fixture.date : b.t?.[sort.k] ?? -Infinity;
      return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
    });
  const sr = sel ? rows.find((r) => r.fixture.id === sel) : null;
  return (
    <>
      <WsHead title="Trade Journal" desc="Every session with its outcome; trades carry a full audit trail">
        <div className="na-seg" role="group" aria-label="Source">
          {[["REPLAY", "Replay (simulation)"], ["LIVE", "Live paper"]].map(([k, l]) => <button key={k} data-on={source === k} onClick={() => setSource(k)}>{l}</button>)}
        </div>
      </WsHead>
      {source === "LIVE" ? <LiveJournal /> : (
        <Card title="Replay sessions · SIMULATION" sub={`${rows.filter((r) => r.t).length} trades in ${rows.length} synthetic fixture sessions — not market data, not evidence of performance`}
          tools={<>
            <div className="na-seg" role="group" aria-label="Bot filter">{["ALL", "GAP_AND_GO", "WILLIAMS"].map((b) => <button key={b} data-on={bot === b} onClick={() => setBot(b)}>{b === "ALL" ? "All" : BOT_LABEL[b]}</button>)}</div>
            <button className="na-chipbtn" data-on={showNoTrade} onClick={() => setShowNoTrade(!showNoTrade)}>No-trade days</button>
          </>} bodyClass="">
          <div className="na-tablewrap">
            <table className="na-table">
              <thead><tr>{COLS.map(([k, l]) => (
                <th key={k} className={["gapPct", "qty", "entryPremium", "exitPremium", "gross", "costs", "net", "returnPct", "strike"].includes(k) ? "r" : ""}>
                  <button style={{ all: "unset", cursor: "pointer" }} onClick={() => setSort({ k, dir: sort.k === k ? -sort.dir : 1 })} aria-label={`Sort by ${l}`}>{l}{sort.k === k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</button>
                </th>))}</tr></thead>
              <tbody>
                {shown.map(({ fixture: f, e, t }) => (
                  <tr key={f.id} data-click="true" data-sel={sel === f.id ? "true" : undefined} onClick={() => setSel(f.id)}>
                    <td>{f.date}</td>
                    <td>{t ? BOT_LABEL[t.bot] : e.signal ? BOT_LABEL[e.signal.bot] : "—"}</td>
                    <td className="r">{e.gap ? pct(e.gap.pct, 3, { sign: false }) : "—"}</td>
                    <td>{e.gap?.direction ?? "—"}</td>
                    {t ? <>
                      <td>{hm(t.signalBar)}</td><td>{istTime(t.entryAt).slice(0, 5)}</td><td>{istTime(t.exitAt).slice(0, 5)}</td>
                      <td><Badge tone={t.right === "CE" ? "gain" : "loss"}>{t.right}</Badge></td><td className="r">{t.strike}</td><td>{t.expiry.slice(5)}</td><td className="r">{t.qty}</td>
                      <td className="r">{num(t.entryPremium, 2)}</td><td className="r">{num(t.exitPremium, 2)}</td>
                      <td className="r"><PnL value={t.gross} /></td><td className="r">{num(t.costs, 2)}</td><td className="r"><PnL value={t.net} /></td>
                      <td className="r">{pct(t.returnPct, 1)}</td><td>{EXIT_LABEL[t.exitReason]}</td><td className="na-faint">{t.strategyVersion.split(":")[1]}</td>
                    </> : <td colSpan={15}><span className="na-muted">No trade — {REASON_LABEL[e.outcome?.reason] ?? e.outcome?.reason}</span></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {sr && (
        <>
          <div className="na-drawer-scrim" onClick={() => setSel(null)} />
          <aside className="na-drawer" role="dialog" aria-label={`Audit trail ${sr.fixture.date}`}>
            <div className="na-card-h"><div><div className="na-card-t">{sr.fixture.date} · {sr.fixture.title}</div><div className="na-card-s">SIMULATION · {sr.e.events.length} audit events</div></div>
              <button className="na-icon-btn" style={{ marginLeft: "auto" }} onClick={() => setSel(null)} aria-label="Close"><X size={15} /></button></div>
            <div style={{ padding: 14, overflowY: "auto", display: "grid", gap: 14 }}>
              <Reason tone={sr.t ? (sr.t.net >= 0 ? "gain" : "loss") : "warn"} tag={sr.e.outcome.kind.replace("_", " ")}>{sr.t ? `${BOT_LABEL[sr.t.bot]} ${sr.t.right} · ${EXIT_LABEL[sr.t.exitReason]} · net ₹${num(sr.t.net, 0)}` : `${REASON_LABEL[sr.e.outcome.reason]}${sr.e.outcome.detail ? ` — ${sr.e.outcome.detail}` : ""}`}</Reason>
              <KV rows={[
                ["Prev 15:15 close → today ref", `${num(sr.e.prevClose, 2)} → ${num(sr.e.reference?.price, 2)}`],
                ["Gap", sr.e.gap ? `${num(sr.e.gap.points, 2, { sign: true })} · ${pct(sr.e.gap.pct, 4, { sign: false })}` : "—"],
                ["OR / bands", sr.e.or ? `${num(sr.e.or.low, 2)}–${num(sr.e.or.high, 2)} · ${num(sr.e.or.downsideBand, 2)} / ${num(sr.e.or.upsideBand, 2)}` : "—"],
                ["Williams CE / PE", sr.e.williams ? `${num(sr.e.williams.ceLevel, 2)} / ${num(sr.e.williams.peLevel, 2)}` : "—"],
                ["Stand-down", sr.e.standDown ? `${sr.e.standDown.reason} · ${hm(sr.e.standDown.bar)}` : "—"],
                ["Entry order", sr.e.entryOrder ? `${sr.e.entryOrder.status}${sr.e.entryOrder.fill ? ` · ask ${sr.e.entryOrder.fill.quoteAsk} → ₹${sr.e.entryOrder.fill.price} · age ${sr.e.entryOrder.fill.quoteAgeMs} ms` : ""}` : "—"],
                ["Exit order", sr.e.exitOrder ? `${sr.e.exitOrder.status}${sr.e.exitOrder.fill ? ` · bid ${sr.e.exitOrder.fill.quoteBid} → ₹${sr.e.exitOrder.fill.price}` : ""}` : "—"],
                ["Config", sr.e.configVersion],
              ]} />
              <button className="na-chipbtn" onClick={() => { ascent.select(sr.fixture.id); ascent.toEnd(); }}>Open this session in the Command Center replay</button>
              <Timeline events={sr.e.events} limit={200} />
            </div>
          </aside>
        </>
      )}
    </>
  );
}

/** LIVE PAPER trades from the server database. Never mixed with replay sessions. */
function LiveJournal() {
  const S = useAscent();
  useEffect(() => { ascent.loadLiveHistory(); }, []);
  const H = S.liveHistory;
  const trades = H?.trades ?? [];
  return (
    <Card title="Live paper trades · real Kite data" sub={H?.reason ?? `${trades.length} filled paper trade(s) — paper fills only, never real orders`} bodyClass="">
      {!trades.length ? <div className="na-note" style={{ padding: 18 }}>{H ? "No live paper trades yet." : "Loading…"}</div> : (
        <div className="na-tablewrap"><table className="na-table">
          <thead><tr><th>Date</th><th>Bot</th><th className="r">Gap %</th><th>Signal</th><th>Entry</th><th>Exit</th><th>CE/PE</th><th>Contract</th><th className="r">Qty</th><th className="r">Entry ₹</th><th className="r">Exit ₹</th><th className="r">Gross</th><th className="r">Costs</th><th className="r">Net</th><th className="r">Return</th><th>Exit reason</th><th>Version</th></tr></thead>
          <tbody>{trades.map((t) => (
            <tr key={t.date}>
              <td>{t.date}</td><td>{BOT_LABEL[t.bot]}</td><td className="r">{pct(t.gapPct, 3, { sign: false })}</td><td>{hm(t.signalBar)}</td>
              <td>{istTime(t.entryAt).slice(0, 5)}</td><td>{istTime(t.exitAt).slice(0, 5)}</td><td><Badge tone={t.right === "CE" ? "gain" : "loss"}>{t.right}</Badge></td>
              <td>{t.tradingsymbol}</td><td className="r">{t.qty}</td><td className="r">{num(t.entryPremium, 2)}</td><td className="r">{num(t.exitPremium, 2)}</td>
              <td className="r"><PnL value={t.gross} /></td><td className="r">{num(t.costs, 2)}</td><td className="r"><PnL value={t.net} /></td><td className="r">{pct(t.returnPct, 1)}</td>
              <td>{EXIT_LABEL[t.exitReason]}</td><td className="na-faint">{String(t.strategyVersion).split(":")[1]}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Card>
  );
}
