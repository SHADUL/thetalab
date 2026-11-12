import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { Card, Badge, PnL, DirBadge, Check } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import { istTime, istDate, num, inr, dur, pct, KIND_LABEL, EXIT_LABEL } from "./format.js";

function Drawer({ t, onClose, now }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const decision = pulse.engine.decisions.find((d) => d.at === t.entryAt && d.approved);
  const fees = [["Entry (2 orders)", t.entryFeesDetailed], ["Exit (2 orders)", t.exitFeesDetailed]];
  const held = t.holdSec ?? Math.round((now - t.entryAt) / 1000);
  return (
    <>
      <div className="np-drawer-scrim" onClick={onClose} />
      <aside className="np-drawer" role="dialog" aria-modal="true" aria-label={`Paper trade ${t.id}`}>
        <div className="np-card-h" style={{ padding: "14px 18px" }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><b style={{ fontSize: 16 }}>{t.id}</b><DirBadge dir={t.direction} /><Badge tone="accent">Paper</Badge><Badge tone="warn">{t.dataMode === "SIMULATION" ? "Simulation" : "Live data"}</Badge></div>
            <div className="np-card-s" style={{ marginTop: 3 }}>{KIND_LABEL[t.kind]} {t.short.strike}/{t.long.strike} · {t.expiry} · {t.configKey}</div>
          </div>
          <button className="np-icon-btn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div style={{ overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="np-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            <div className="np-card" style={{ padding: 12 }}><div className="lbl">{t.status === "CLOSED" ? "Realized net" : "Marked net"}</div><div className="n" style={{ fontSize: 20, fontWeight: 650 }}><PnL value={t.realizedNet ?? t.mark?.markedNet ?? null} /></div></div>
            <div className="np-card" style={{ padding: 12 }}><div className="lbl">Held</div><div className="n" style={{ fontSize: 20, fontWeight: 650 }}>{dur(held)}</div></div>
            <div className="np-card" style={{ padding: 12 }}><div className="lbl">Exit</div><div style={{ fontSize: 15, fontWeight: 650, marginTop: 4 }}>{t.exitReason ? EXIT_LABEL[t.exitReason] : t.status}</div></div>
          </div>

          <section>
            <div className="lbl" style={{ marginBottom: 8 }}>1 · Signal at entry</div>
            <dl className="np-kv">
              <dt>Time</dt><dd>{istTime(t.entryAt)} IST</dd>
              <dt>NIFTY</dt><dd>{num(t.signal.price, 2)}</dd>
              <dt>R5 · R15</dt><dd>{pct(t.signal.r5, 4)} · {pct(t.signal.r15, 4)}</dd>
              <dt>MA60</dt><dd>{num(t.signal.ma60, 2)}</dd>
              <dt>Last 5 changes</dt><dd>{t.signal.ups}↑ {t.signal.downs}↓</dd>
              <dt>Reason</dt><dd style={{ whiteSpace: "normal", maxWidth: 300 }}>{t.entryReason}</dd>
            </dl>
          </section>

          <section>
            <div className="lbl" style={{ marginBottom: 8 }}>2 · Risk engine approval</div>
            {decision ? decision.checks.map((k) => (
              <div key={k.key} className="np-rule"><Check ok={k.pass} /><span>{k.label}</span><span className="np-card-s n" style={{ textAlign: "right", whiteSpace: "normal" }}>{k.detail}</span></div>
            )) : <div className="np-note">Decision record not in the current session buffer.</div>}
          </section>

          <section>
            <div className="lbl" style={{ marginBottom: 8 }}>3 · Simulated fills</div>
            <div className="np-tablewrap">
              <table className="np-table">
                <thead><tr><th>Time</th><th>Leg</th><th>Side</th><th>Contract</th><th className="r">Qty</th><th className="r">Price</th><th>Basis</th></tr></thead>
                <tbody>
                  {t.fills.map((f, i) => (
                    <tr key={i}><td className="n">{istTime(f.at)}</td><td>{f.leg}</td><td><Badge tone={f.side === "SELL" ? "loss" : "gain"}>{f.side}</Badge></td><td className="n">{f.tradingsymbol}</td><td className="r n">{f.qty}</td><td className="r n">{num(f.price, 2)}</td><td className="np-muted">{f.basis}{f.side === "SELL" ? " −" : " +"} {f.slippagePts} slip</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="np-note" style={{ marginTop: 6 }}>PAPER_FILL — simulated against quoted bid/ask. Not an exchange fill.</div>
          </section>

          <section>
            <div className="lbl" style={{ marginBottom: 8 }}>4 · P&L and costs</div>
            <dl className="np-kv">
              <dt>Entry credit</dt><dd>{num(t.creditPts, 2)} pts · {inr(t.grossCredit)}</dd>
              <dt>Closing debit</dt><dd>{t.closingDebitPts != null ? `${num(t.closingDebitPts, 2)} pts` : t.mark?.closingDebitPts != null ? `${num(t.mark.closingDebitPts, 2)} pts (mark)` : "—"}</dd>
              <dt>Gross P&L</dt><dd><PnL value={t.realizedGross ?? t.mark?.grossPnl ?? null} /></dd>
              <dt>Cost used by strategy ({t.costModel})</dt><dd>{inr(t.roundTripCost)}</dd>
              <dt>Net P&L</dt><dd><PnL value={t.realizedNet ?? t.mark?.markedNet ?? null} /></dd>
              <dt>Target · stop (net)</dt><dd>{inr(t.targetPnl, { sign: true })} · {inr(t.stopPnl)}</dd>
              <dt>Max loss at entry</dt><dd>{inr(t.maxLoss)}</dd>
            </dl>
            <div className="np-tablewrap" style={{ marginTop: 10 }}>
              <table className="np-table">
                <thead><tr><th>Detailed estimate</th><th className="r">Brokerage</th><th className="r">STT</th><th className="r">Txn</th><th className="r">Stamp</th><th className="r">GST</th><th className="r">Total</th></tr></thead>
                <tbody>{fees.map(([k, f]) => f && <tr key={k}><td>{k}</td><td className="r n">{num(f.brokerage, 2)}</td><td className="r n">{num(f.stt, 2)}</td><td className="r n">{num(f.txn, 2)}</td><td className="r n">{num(f.stamp, 2)}</td><td className="r n">{num(f.gst, 2)}</td><td className="r n">{num(f.total, 2)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>

          <section>
            <div className="lbl" style={{ marginBottom: 8 }}>5 · Lifecycle</div>
            {t.events.map((e, i) => (
              <div key={i} className="np-tl-row" style={{ gridTemplateColumns: "64px 14px minmax(0,1fr)" }}>
                <div className="np-tl-t">{istTime(e.at)}</div><div><div className="np-tl-dot" data-k={e.type === "PENDING_EXIT" ? "PENDING" : i === 0 ? "ENTRY" : "EXIT"} /></div>
                <div><div className="np-tl-title">{e.type.replace("_", " ")}</div><div className="np-tl-detail">{e.detail}</div></div>
              </div>
            ))}
          </section>
        </div>
      </aside>
    </>
  );
}

export default function PaperTrades() {
  const s = usePulse((x) => x);
  const [fStrat, setFStrat] = useState("ALL");
  const [fDir, setFDir] = useState("ALL");
  const [fOut, setFOut] = useState("ALL");
  const [open, setOpen] = useState(null);
  const all = [...(s.position ? [s.position] : []), ...[...s.trades].reverse()];
  const strategies = [...new Set(all.map((t) => t.configKey))];
  const rows = all.filter((t) =>
    (fStrat === "ALL" || t.configKey === fStrat) &&
    (fDir === "ALL" || t.direction === fDir) &&
    (fOut === "ALL" || (fOut === "OPEN" ? t.status !== "CLOSED" : fOut === "WIN" ? (t.realizedNet ?? 0) > 0 && t.status === "CLOSED" : (t.realizedNet ?? 0) <= 0 && t.status === "CLOSED")));
  const sel = open ? all.find((t) => t.id === open) : null;
  const net = s.trades.reduce((a, t) => a + (t.realizedNet ?? 0), 0);
  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Paper Trades</div>
          <div className="np-ws-desc">Blotter of simulated executions · every trade stores the exact configuration version it ran under</div>
        </div>
      </div>
      <Card title={`${rows.length} trade${rows.length === 1 ? "" : "s"}`} sub={`Session ${istDate(s.now)} (SIM) · closed net ${net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(net)).toLocaleString("en-IN")} · ${s.config.name}`}
        tools={<>
          <select className="np-chipbtn" value="SESSION" aria-label="Date" disabled><option value="SESSION">{istDate(s.now)}</option></select>
          <select className="np-chipbtn" value={fStrat} onChange={(e) => setFStrat(e.target.value)} aria-label="Strategy"><option value="ALL">All strategies</option>{strategies.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <select className="np-chipbtn" value={fDir} onChange={(e) => setFDir(e.target.value)} aria-label="Direction"><option value="ALL">Both directions</option><option value="BULLISH">Bullish · bull put</option><option value="BEARISH">Bearish · bear call</option></select>
          <select className="np-chipbtn" value={fOut} onChange={(e) => setFOut(e.target.value)} aria-label="Outcome"><option value="ALL">All outcomes</option><option value="WIN">Winners</option><option value="LOSS">Losers / flat</option><option value="OPEN">Open</option></select>
        </>} bodyClass="">
        {rows.length === 0 ? (
          <div className="np-card-b" style={{ padding: "48px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>No paper trades {all.length ? "match these filters" : "yet this session"}</div>
            <div className="np-note" style={{ maxWidth: 560, margin: "6px auto 0" }}>
              {all.length ? "Clear a filter to see more." : s.config.maxLossPerTrade <= 1000
                ? `${s.config.name} allows at most ${inr(s.config.maxLossPerTrade)} worst-case loss per trade. A near-the-money 50-point NIFTY spread usually risks more than that, so signals end in "NO ELIGIBLE SPREAD WITHIN RISK LIMIT" — see Strategy Engine. Switch to the Extended Risk preset in Settings to compare.`
                : "Waiting for a signal that passes every rule, a liquid spread and the risk engine."}
            </div>
          </div>
        ) : (
          <div className="np-tablewrap" style={{ maxHeight: "calc(100vh - 260px)" }}>
            <table className="np-table">
              <thead><tr>
                <th>Trade</th><th>Strategy version</th><th>Entry</th><th>Exit</th><th>Direction</th><th>Short leg</th><th>Long leg</th><th className="r">Qty</th>
                <th className="r">Entry credit</th><th className="r">Closing debit</th><th className="r">Est. fees</th><th className="r">Realized P&L</th><th className="r">Held</th><th>Entry reason</th><th>Exit reason</th><th>Mode</th>
              </tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} data-click="true" data-sel={open === t.id} onClick={() => setOpen(t.id)}>
                    <td className="n" style={{ fontWeight: 650 }}>{t.id}</td>
                    <td className="n np-muted">{t.configKey}</td>
                    <td className="n">{istTime(t.entryAt)}</td>
                    <td className="n">{t.exitAt ? istTime(t.exitAt) : <Badge tone="accent">{t.status === "PENDING_EXIT" ? "Pending" : "Open"}</Badge>}</td>
                    <td><DirBadge dir={t.direction} /></td>
                    <td className="n">SELL {t.short.strike} {t.short.right} @ {num(t.entryShort, 2)}</td>
                    <td className="n">BUY {t.long.strike} {t.long.right} @ {num(t.entryLong, 2)}</td>
                    <td className="r n">{t.qty}</td>
                    <td className="r n">{num(t.creditPts, 2)}</td>
                    <td className="r n">{t.closingDebitPts != null ? num(t.closingDebitPts, 2) : t.mark?.closingDebitPts != null ? <span className="np-muted">{num(t.mark.closingDebitPts, 2)}</span> : "—"}</td>
                    <td className="r n" title={`Detailed estimate ₹${((t.entryFeesDetailed?.total ?? 0) + (t.exitFeesDetailed?.total ?? 0)).toFixed(2)}`}>{inr(t.roundTripCost)}</td>
                    <td className="r n" style={{ fontWeight: 650 }}><PnL value={t.realizedNet ?? t.mark?.markedNet ?? null} />{t.status !== "CLOSED" && <div className="np-faint" style={{ fontSize: 10 }}>marked</div>}</td>
                    <td className="r n">{dur(t.holdSec ?? Math.round((s.now - t.entryAt) / 1000))}</td>
                    <td className="np-muted" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={t.entryReason}>{t.entryReason}</td>
                    <td>{t.exitReason ? <Badge tone={t.exitReason === "PROFIT_TARGET" ? "gain" : t.exitReason === "STOP_LOSS" ? "loss" : undefined}>{EXIT_LABEL[t.exitReason]}</Badge> : "—"}</td>
                    <td><Badge tone="warn">{t.dataMode === "SIMULATION" ? "SIM · paper" : "Live · paper"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {sel && <Drawer t={sel} now={s.now} onClose={() => setOpen(null)} />}
    </>
  );
}
