import { useState, useEffect, useCallback } from "react";
import { Broadcast, ArrowClockwise, X, Info } from "@phosphor-icons/react";
import { fetchLiveQuotes, kiteLoginUrl } from "../lib/kiteClient";
import { kiteInstrument } from "../lib/kiteSymbol";
import { cx, sgn, fm } from "../lib/format";

/**
 * Every position opened while "Today (Live)" was on, across every expiry —
 * not just the one tab happens to be on screen — re-priced from a fresh
 * batch of Kite quotes each time this opens. This is the "come back
 * tomorrow and see it" view: the simulator's own Positions tab only ever
 * looks at whichever single expiry/day is currently selected, which is the
 * wrong shape for "how did my real position do overnight."
 *
 * A day-old Kite session (the access-token cookie is good for ~20h) means
 * the fetch below can come back needing a reconnect — that's surfaced
 * plainly rather than pretending "automatic" means "never has to log in
 * again," which Kite's own session lifetime doesn't allow.
 */
export default function Portfolio({ legs, symbol, lotFor, kiteConnected, onClose }) {
  const exchange = symbol === "SENSEX" ? "BFO" : "NFO";
  const open = legs.filter((l) => l.source === "live" && !l.closedDate);
  const openIds = open.map((l) => l.id).join(",");

  const [quotes, setQuotes] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [asOf, setAsOf] = useState(null);

  const refresh = useCallback(() => {
    if (!kiteConnected || open.length === 0) return;
    setLoading(true);
    setError(null);
    const instruments = open.map((l) => kiteInstrument(symbol, l.expiry, l.strike, l.right, exchange));
    fetchLiveQuotes(instruments)
      .then((r) => { setQuotes(r.quotes); setAsOf(r.asOf); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiteConnected, openIds, symbol, exchange]);

  useEffect(() => { refresh(); }, [refresh]);

  const rows = open.map((l) => {
    const key = kiteInstrument(symbol, l.expiry, l.strike, l.right, exchange);
    const ltp = quotes[key]?.lastPrice ?? null;
    const qty = l.lots * lotFor(l.expiry, l.entryDate);
    const pnl = ltp == null ? null : (l.side === "SELL" ? l.entryPrice - ltp : ltp - l.entryPrice) * qty;
    return { ...l, ltp, pnl };
  });
  const totalPnl = rows.some((r) => r.pnl != null)
    ? rows.reduce((s, r) => s + (r.pnl ?? 0), 0) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: "rgba(0,0,0,0.45)" }} onClick={onClose}>
      <div className="n mt-12 w-full max-w-2xl rounded-2xl p-5"
        style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Broadcast size={15} weight="fill" className="text-accent" />
            <h2 className="text-[15px] font-bold">Portfolio</h2>
            <span className="text-[11px] text-muted">{symbol} · positions opened live</span>
          </div>
          <div className="flex items-center gap-1.5">
            {kiteConnected && open.length > 0 && (
              <button onClick={refresh} disabled={loading} className="topstep" title="Refresh live quotes">
                <ArrowClockwise size={12} weight="bold" />
              </button>
            )}
            <button onClick={onClose} className="topstep" aria-label="Close">
              <X size={12} weight="bold" />
            </button>
          </div>
        </div>

        {open.length === 0 ? (
          <p className="text-[12.5px] text-muted leading-relaxed px-1">
            No live positions yet. Open one while <b>Today (Live)</b> is on and it lands here
            automatically — tracked with a real Kite quote every time you come back, not the
            end-of-day price.
          </p>
        ) : !kiteConnected ? (
          <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-line)" }}>
            <Info size={16} weight="duotone" className="shrink-0 mt-px text-muted" />
            <p className="text-[12.5px] text-muted leading-relaxed">
              Your Kite session has expired — reconnect to see today's live P&L on these positions.{" "}
              <a href={kiteLoginUrl()} className="text-accent font-medium">Connect Kite</a>
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3 px-1">
              <span className="text-[11px] text-muted">
                {loading ? "Refreshing…" : error ? error
                  : asOf ? `As of ${new Date(asOf).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
                  : ""}
              </span>
              <span className={cx("text-[16px] font-bold",
                totalPnl > 0 ? "text-gain" : totalPnl < 0 ? "text-loss" : "")}>
                {sgn(totalPnl)}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-medium py-1 pr-2">Leg</th>
                    <th className="font-medium py-1 pr-2">Opened</th>
                    <th className="font-medium py-1 pr-2 text-right">Entry</th>
                    <th className="font-medium py-1 pr-2 text-right">LTP</th>
                    <th className="font-medium py-1 text-right">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                      <td className="py-1.5 pr-2">
                        <b className={r.side === "SELL" ? "text-loss" : "text-gain"}>
                          {r.side === "SELL" ? "S" : "B"}
                        </b>{" "}
                        {r.strike}{r.right} <span className="text-faint">{r.expiry} · {r.lots}L</span>
                      </td>
                      <td className="py-1.5 pr-2 text-muted">{r.entryDate}</td>
                      <td className="py-1.5 pr-2 text-right">{fm(r.entryPrice)}</td>
                      <td className="py-1.5 pr-2 text-right">{r.ltp != null ? fm(r.ltp) : "—"}</td>
                      <td className={cx("py-1.5 text-right font-medium",
                        r.pnl == null ? "text-faint" : r.pnl > 0 ? "text-gain" : r.pnl < 0 ? "text-loss" : "")}>
                        {r.pnl == null ? "—" : sgn(r.pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
