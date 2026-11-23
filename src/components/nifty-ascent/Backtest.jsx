/**
 * Backtest — replay past trading days through the real engine.
 * NIFTY index prices are REAL (Kite 1-minute history); option premiums are
 * MODELLED (Black-76 with the previous day's India VIX). Paper only; results
 * are kept apart from SIMULATION fixtures and LIVE PAPER trades.
 */
import { useEffect } from "react";
import { Play, Stop, ArrowSquareOut } from "@phosphor-icons/react";
import { useAscent, ascent, lastMonths } from "./store.js";
import { Card, Badge, WsHead, PnL, Kpi, Spark, Empty } from "./ui.jsx";
import { num, pct, hm, istTime, BOT_LABEL, EXIT_LABEL, REASON_LABEL } from "./format.js";

export default function Backtest({ go }) {
  const S = useAscent();
  const B = S.bt;
  useEffect(() => { if (!B.month) ascent.btLoadMonth(lastMonths()[0]); }, [B.month]);
  const rows = B.days.map((d) => ({ ...d, r: B.results[d.date] }));
  const done = rows.filter((x) => x.r && !x.r.error);
  const trades = done.filter((x) => x.r.trade).map((x) => ({ date: x.date, ...x.r.trade }));
  const net = trades.reduce((a, t) => a + t.net, 0);
  const wins = trades.filter((t) => t.net > 0).length;
  const { curve, dd } = equity(trades);
  const gg = trades.filter((t) => t.bot === "GAP_AND_GO"), wl = trades.filter((t) => t.bot === "WILLIAMS");
  const sum = (a) => a.reduce((s, t) => s + t.net, 0);

  const open = (date) => { if (S.source !== "BACKTEST") ascent.setSource("BACKTEST"); ascent.btOpenDay(date); };
  const watch = (date) => { open(date); go("command-center"); };

  return (
    <>
      <WsHead title="Backtest" desc="Past trading days replayed second by second through the same engine and rules as live paper · NIFTY prices are real Kite 1-minute candles · option prices are MODELLED, so P&L is an estimate">
        <select className="na-chipbtn" aria-label="Month" value={B.month ?? ""} onChange={(ev) => ascent.btLoadMonth(ev.target.value)} disabled={B.running}>
          {lastMonths().map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {B.running
          ? <button className="na-chipbtn" onClick={() => ascent.btStop()}><Stop size={13} weight="fill" />Stop ({B.progress?.i}/{B.progress?.n})</button>
          : <button className="na-chipbtn" onClick={() => ascent.btRunAll()} disabled={!B.days.length}><Play size={13} weight="fill" />Run all days</button>}
      </WsHead>

      <div className="na-grid na-four" style={{ marginBottom: 12 }}>
        <Kpi label="Days run" value={`${done.length}/${B.days.length}`} sub={B.running ? `running ${B.progress?.date}` : `${rows.filter((x) => x.r?.error).length} errors`} />
        <Kpi label="Trades" value={trades.length} sub={trades.length ? `${wins} wins · ${pct((wins / trades.length) * 100, 0, { sign: false })}` : "—"} />
        <Kpi label="Net P&L (modelled)" value={<PnL value={trades.length ? net : null} />} sub={`GG ₹${num(sum(gg), 0)} · W ₹${num(sum(wl), 0)}`} />
        <Kpi label="Max drawdown" value={trades.length ? `₹${num(-dd, 0)}` : "—"} sub="on closed trades">
          <div className="na-kpi-spark"><Spark values={curve} height={22} baseline={0} color={net >= 0 ? "var(--c-gain)" : "var(--c-loss)"} /></div>
        </Kpi>
      </div>

      <Card title={`Trading days · ${B.month ?? ""}`} sub="Click a row to load the day and replay it in every workspace · data is fetched once from Kite and cached on the server" bodyClass="">
        {B.daysError ? <Empty>Could not list days: {B.daysError}</Empty>
          : B.loadingDays ? <Empty>Loading trading days…</Empty>
          : !rows.length ? <Empty>No completed trading days in this month yet.</Empty> : (
          <div className="na-tablewrap">
            <table className="na-table">
              <thead><tr><th>Date</th><th>Data</th><th className="r">Gap %</th><th>Outcome</th><th>Bot</th><th>Signal</th><th>Contract</th><th>Entry</th><th>Exit</th><th className="r">Entry ₹</th><th className="r">Exit ₹</th><th>Exit reason</th><th className="r">Net</th><th /></tr></thead>
              <tbody>
                {rows.map(({ date, cached, r }) => {
                  const t = r?.trade;
                  return (
                    <tr key={date} data-click="true" data-sel={B.date === date ? "true" : undefined} onClick={() => open(date)}>
                      <td>{date}</td>
                      <td>{cached ? <Badge tone="gain">cached</Badge> : <span className="na-faint">not fetched</span>}</td>
                      {!r ? <td colSpan={11} className="na-faint">not run — click to replay, or Run all days</td>
                        : r.error ? <td colSpan={11}><span className="na-loss">{r.error}</span></td>
                        : <>
                          <td className="r">{r.gap ? `${r.gap.dir === "UP" ? "▲" : r.gap.dir === "DOWN" ? "▼" : "◆"} ${pct(r.gap.pct, 2, { sign: false })}` : "—"}</td>
                          <td>{t ? <Badge tone={t.net >= 0 ? "gain" : "loss"}>TRADE</Badge> : r.rejected ? <Badge tone="warn" title={r.rejected}>REJECTED</Badge> : <span className="na-muted">{REASON_LABEL[r.outcome?.reason] ?? r.outcome?.reason ?? r.outcome?.kind ?? "—"}</span>}</td>
                          <td>{t ? BOT_LABEL[t.bot] : r.signal ? BOT_LABEL[r.signal.bot] : "—"}</td>
                          <td>{r.signal ? `${r.signal.right} ${hm(r.signal.bar)}` : "—"}</td>
                          <td>{t ? `${t.strike} ${t.right} · ${t.expiry.slice(5)}` : "—"}</td>
                          <td>{t ? istTime(t.entryAt).slice(0, 5) : "—"}</td>
                          <td>{t ? istTime(t.exitAt).slice(0, 5) : "—"}</td>
                          <td className="r">{t ? num(t.entryPremium, 2) : "—"}</td>
                          <td className="r">{t ? num(t.exitPremium, 2) : "—"}</td>
                          <td>{t ? EXIT_LABEL[t.exitReason] : r.rejected ?? "—"}</td>
                          <td className="r">{t ? <PnL value={t.net} /> : "—"}</td>
                        </>}
                      <td><button className="na-icon-btn" onClick={(ev) => { ev.stopPropagation(); watch(date); }} aria-label={`Watch ${date} in the Command Center`} title="Watch this day live in the Command Center"><ArrowSquareOut size={14} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="na-note" style={{ marginTop: 10 }}>
        How it works: each past day&apos;s real NIFTY 1-minute candles are expanded into a second-by-second path (open → low → high → close for up candles, open → high → low → close for down candles) and fed to the unchanged engine. Option bid/ask come from a Black-76 model using the previous day&apos;s India VIX close as volatility, so premiums, fills and P&amp;L are estimates, not real option prices. The current Risk &amp; Settings limits apply (₹{num(S.exec.maxPremiumOutlay, 0)} outlay incl. fees, {S.exec.lots} lot, one position a day). Changing Execution settings in Risk &amp; Settings clears these results.
      </div>
    </>
  );
}

function equity(trades) {
  let eq = 0, peak = 0, dd = 0;
  const curve = [0];
  for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); curve.push(eq); }
  return { curve, dd };
}
