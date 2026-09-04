import { useState, useEffect, useCallback } from "react";
import { Broadcast, ArrowClockwise, X, Info, SignOut, Minus, Plus, Check,
         CaretDown, CaretUp, Bell, ChartLine, ListBullets } from "@phosphor-icons/react";
import { fetchLiveQuotes, kiteLoginUrl } from "../lib/kiteClient";
import { kiteInstrument, INDEX_INSTRUMENT } from "../lib/kiteSymbol";
import { impliedVol, greeks } from "../lib/options";
import { cx, sgn, fm, inr } from "../lib/format";
import { readPnlHistory, recordPnl } from "../lib/pnlHistory";

const IST_DATE = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/**
 * Every position explicitly added via the "Add to Portfolio" picker in
 * Positions, across every expiry — not just the one tab happens to be on
 * screen — re-priced from a fresh batch of Kite quotes each time this
 * opens. This is the "come back tomorrow and see it" view: the simulator's
 * own Positions tab only ever looks at whichever single expiry/day is
 * currently selected, which is the wrong shape for "how did my real
 * position do overnight." Nothing lands here just for being opened while
 * live — that's a deliberate opt-in, not automatic, so a what-if leg built
 * during live testing doesn't get tracked alongside a real position.
 *
 * A day-old Kite session (the access-token cookie is good for ~20h) means
 * the fetch below can come back needing a reconnect — that's surfaced
 * plainly rather than pretending "automatic" means "never has to log in
 * again," which Kite's own session lifetime doesn't allow.
 *
 * Exiting here is booking, not trading — it marks the slice closed in this
 * app's own tracking at the live price already on screen, the same
 * non-executing pattern Positions' own Exit already uses. Nothing here
 * ever places a real order against Kite. SL/target alerts are the same
 * spirit: a notification, not an order — App.jsx's own polling effect (not
 * this component, so it keeps running while Portfolio is closed) is what
 * actually watches for a crossing.
 *
 * Legs added together through one trip through the picker can share a
 * basket name, and render as their own named group below — several
 * strategies tracked side by side, Sensibull-style, rather than one
 * undifferentiated list every leg from every trade gets dumped into.
 */
export default function Portfolio({
  legs, symbol, lotFor, kiteConnected, onPartialExit, onSetAlert, onClose,
}) {
  const exchange = symbol === "SENSEX" ? "BFO" : "NFO";
  const indexInstrument = INDEX_INSTRUMENT[symbol];
  const open = legs.filter((l) => l.source === "live" && !l.closedDate);
  const closed = legs.filter((l) => l.source === "live" && l.closedDate);
  const openIds = open.map((l) => l.id).join(",");

  const [view, setView] = useState("positions");
  const [quotes, setQuotes] = useState({});
  const [spot, setSpot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [asOf, setAsOf] = useState(null);
  const [exitingId, setExitingId] = useState(null);
  const [exitQty, setExitQty] = useState(1);
  const [closedShown, setClosedShown] = useState(false);
  const [alertingId, setAlertingId] = useState(null);
  const [alertSl, setAlertSl] = useState("");
  const [alertTarget, setAlertTarget] = useState("");
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported");

  const refresh = useCallback(() => {
    if (!kiteConnected || open.length === 0) return;
    setLoading(true);
    setError(null);
    const instruments = open.map((l) => kiteInstrument(symbol, l.expiry, l.strike, l.right, exchange));
    if (indexInstrument) instruments.push(indexInstrument);
    fetchLiveQuotes(instruments)
      .then((r) => {
        setQuotes(r.quotes);
        setAsOf(r.asOf);
        if (indexInstrument) setSpot(r.quotes[indexInstrument]?.lastPrice ?? null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiteConnected, openIds, symbol, exchange, indexInstrument]);

  useEffect(() => { refresh(); }, [refresh]);

  const todayIST = asOf ? IST_DATE(asOf) : null;

  const rows = open.map((l) => {
    const key = kiteInstrument(symbol, l.expiry, l.strike, l.right, exchange);
    const ltp = quotes[key]?.lastPrice ?? null;
    const qty = l.lots * lotFor(l.expiry, l.entryDate);
    const dir = l.side === "SELL" ? -1 : 1;
    const pnl = ltp == null ? null : (l.side === "SELL" ? l.entryPrice - ltp : ltp - l.entryPrice) * qty;

    /* Spot stands in for the forward here — Portfolio only ever fetches the
       one leg's own quote plus the index, not a whole chain, so there's no
       put-call parity available to solve a proper forward from. Close
       enough for a Greeks readout; the Quant Engine elsewhere in the app
       still does this properly off a full chain. */
    const isCall = l.right === "CE";
    const T = todayIST ? Math.max((new Date(l.expiry) - new Date(todayIST)) / 86400000, 0) / 365 : 0;
    const iv = ltp != null && spot != null && T > 0 ? impliedVol(ltp, spot, l.strike, T, isCall) : null;
    const g = iv ? greeks(spot, l.strike, T, iv, isCall) : null;

    return { ...l, ltp, pnl, dir, qty, g };
  });
  const unrealized = rows.some((r) => r.pnl != null)
    ? rows.reduce((s, r) => s + (r.pnl ?? 0), 0) : null;
  const totalGreeks = rows.reduce((t, r) => {
    if (!r.g) return t;
    t.delta += r.dir * r.g.delta * r.qty; t.theta += r.dir * r.g.theta * r.qty;
    t.vega += r.dir * r.g.vega * r.qty;
    return t;
  }, { delta: 0, theta: 0, vega: 0 });

  const closedRows = closed.map((l) => {
    const qty = l.lots * lotFor(l.expiry, l.entryDate);
    const pnl = (l.side === "SELL" ? l.entryPrice - l.closePrice : l.closePrice - l.entryPrice) * qty;
    return { ...l, pnl };
  });
  const realized = closedRows.reduce((s, r) => s + r.pnl, 0);
  const combined = (unrealized ?? 0) + realized;

  /* Every leg added to Portfolio together (one trip through the "Add to
     Portfolio" picker) can carry a shared basket name — grouped here so a
     second, unrelated structure added later shows up as its own card
     instead of merging into one flat list of legs from different trades.
     Groups only get their own header once there's more than one; a single
     basket (named or not) still renders as a plain list, unchanged from
     before this existed. */
  const groupByBasket = (list) => {
    const map = new Map();
    list.forEach((r) => {
      const key = r.basket || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    return [...map.entries()].map(([name, items]) => ({
      name, items, subtotal: items.reduce((s, r) => s + (r.pnl ?? 0), 0),
    }));
  };
  const openGroups = groupByBasket(rows);
  const closedGroups = groupByBasket(closedRows);

  /* One point a day, keyed off whatever's actually been seen — a passive
     record of "how am I doing," not a fetch of its own. */
  useEffect(() => {
    if (!todayIST || unrealized == null) return;
    recordPnl(symbol, todayIST, combined);
  }, [todayIST, combined, symbol, unrealized]);
  /* Not memoized — a cheap localStorage read, and it needs to be fresh
     the moment the effect above just wrote a new point for today. */
  const history = readPnlHistory(symbol);

  const startExit = (l) => { setExitingId(l.id); setExitQty(l.lots); };
  const confirmExit = (l, ltp) => {
    onPartialExit(l.id, exitQty, ltp, todayIST ?? new Date().toISOString().slice(0, 10));
    setExitingId(null);
  };

  const startAlert = (l) => {
    setAlertingId(l.id); setAlertSl(l.sl ?? ""); setAlertTarget(l.target ?? "");
    if (notifPerm === "default") Notification.requestPermission().then(setNotifPerm);
  };
  const saveAlert = (l) => {
    onSetAlert(l.id, {
      sl: alertSl === "" ? null : Number(alertSl),
      target: alertTarget === "" ? null : Number(alertTarget),
    });
    setAlertingId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: "rgba(0,0,0,0.45)" }} onClick={onClose}>
      <div className="n mt-12 w-full max-w-3xl rounded-2xl p-5"
        style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Broadcast size={15} weight="fill" className="text-accent" />
            <h2 className="text-[15px] font-bold">Portfolio</h2>
            <span className="text-[11px] text-muted">{symbol} · positions opened live</span>
          </div>
          <div className="flex items-center gap-1.5">
            {history.length > 1 && (
              <button onClick={() => setView((v) => (v === "positions" ? "history" : "positions"))}
                className={cx("topstep", view === "history" && "is-on")} title="P&L history">
                {view === "history" ? <ListBullets size={12} weight="bold" /> : <ChartLine size={12} weight="bold" />}
              </button>
            )}
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

        {open.length === 0 && closed.length === 0 ? (
          <p className="text-[12.5px] text-muted leading-relaxed px-1">
            Nothing tracked yet. While <b>Today (Live)</b> is on, use <b>Add to Portfolio</b> in
            Positions to pick which ones belong here — tracked with a real Kite quote every time
            you come back, not the end-of-day price.
          </p>
        ) : view === "history" ? (
          <PnlHistoryChart history={history} />
        ) : (
          <>
            {open.length > 0 && !kiteConnected && (
              <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px] mb-3" style={{ border: "1px solid var(--c-line)" }}>
                <Info size={16} weight="duotone" className="shrink-0 mt-px text-muted" />
                <p className="text-[12.5px] text-muted leading-relaxed">
                  Your Kite session has expired — reconnect to see today's live P&L on these positions.{" "}
                  <a href={kiteLoginUrl()} className="text-accent font-medium">Connect Kite</a>
                </p>
              </div>
            )}

            {(open.length > 0 || closed.length > 0) && (
              <div className="flex items-center justify-between mb-1.5 px-1">
                <span className="text-[11px] text-muted">
                  {loading ? "Refreshing…" : error ? error
                    : asOf ? `As of ${new Date(asOf).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </span>
                <span className="flex items-baseline gap-1.5">
                  {closed.length > 0 && (
                    <span className="text-[10.5px] text-muted">
                      {sgn(unrealized)} open + {sgn(realized)} booked =
                    </span>
                  )}
                  <span className={cx("text-[16px] font-bold",
                    combined > 0 ? "text-gain" : combined < 0 ? "text-loss" : "")}>
                    {sgn(combined)}
                  </span>
                </span>
              </div>
            )}
            {open.length > 0 && (
              <div className="flex items-center gap-3 mb-3 px-1 text-[10.5px] text-muted">
                <span>Δ <b className="n text-ink2">{fm(totalGreeks.delta, 1)}</b></span>
                <span>Θ <b className={cx("n", totalGreeks.theta >= 0 ? "text-gain" : "text-loss")}>
                  {inr(totalGreeks.theta)}</b></span>
                <span>Vega <b className="n text-ink2">{inr(totalGreeks.vega)}</b></span>
              </div>
            )}

            {open.length > 0 && openGroups.map((group) => (
              <div key={group.name} className="mb-3 last:mb-0">
                {openGroups.length > 1 && (
                  <div className="flex items-center justify-between px-1 mb-1">
                    <span className="text-[11.5px] font-semibold">{group.name || "Other positions"}</span>
                    <span className={cx("text-[11.5px] font-medium",
                      group.subtotal > 0 ? "text-gain" : group.subtotal < 0 ? "text-loss" : "text-muted")}>
                      {sgn(group.subtotal)}
                    </span>
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-muted text-left">
                        <th className="font-medium py-1 pr-2">Leg</th>
                        <th className="font-medium py-1 pr-2">Opened</th>
                        <th className="font-medium py-1 pr-2 text-right">Entry</th>
                        <th className="font-medium py-1 pr-2 text-right">LTP</th>
                        <th className="font-medium py-1 pr-2 text-right">Delta</th>
                        <th className="font-medium py-1 pr-2 text-right">P&L</th>
                        <th className="font-medium py-1 pr-2 text-right">Alert</th>
                        <th className="font-medium py-1 text-right">Exit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((r) => (
                        <tr key={r.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                          <td className="py-1.5 pr-2">
                            <b className={r.side === "SELL" ? "text-loss" : "text-gain"}>
                              {r.side === "SELL" ? "S" : "B"}
                            </b>{" "}
                            {r.strike}{r.right} <span className="text-faint">{r.expiry} · {r.lots}L</span>
                            {(r.sl != null || r.target != null) && (
                              <span className="text-faint">
                                {" "}· {r.sl != null && `≤${fm(r.sl, 0)}`}{r.sl != null && r.target != null && " "}
                                {r.target != null && `≥${fm(r.target, 0)}`}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 text-muted">{r.entryDate}</td>
                          <td className="py-1.5 pr-2 text-right">{fm(r.entryPrice)}</td>
                          <td className="py-1.5 pr-2 text-right">{r.ltp != null ? fm(r.ltp) : "—"}</td>
                          <td className="py-1.5 pr-2 text-right text-muted">
                            {r.g ? fm(r.dir * r.g.delta * r.qty, 1) : "—"}
                          </td>
                          <td className={cx("py-1.5 pr-2 text-right font-medium",
                            r.pnl == null ? "text-faint" : r.pnl > 0 ? "text-gain" : r.pnl < 0 ? "text-loss" : "")}>
                            {r.pnl == null ? "—" : sgn(r.pnl)}
                          </td>
                          <td className="py-1.5 pr-2 text-right">
                            {alertingId === r.id ? (
                              <span className="inline-flex items-center gap-1">
                                <input value={alertSl} onChange={(e) => setAlertSl(e.target.value.replace(/[^0-9.]/g, ""))}
                                  placeholder="≤" className="n" style={{ width: 44, textAlign: "right" }} />
                                <input value={alertTarget} onChange={(e) => setAlertTarget(e.target.value.replace(/[^0-9.]/g, ""))}
                                  placeholder="≥" className="n" style={{ width: 44, textAlign: "right" }} />
                                <button className="mini-btn" title="Save alert" onClick={() => saveAlert(r)}>
                                  <Check size={11} weight="bold" />
                                </button>
                                <button className="mini-btn is-danger" title="Cancel" onClick={() => setAlertingId(null)}>
                                  <X size={11} weight="bold" />
                                </button>
                              </span>
                            ) : (
                              <button className={cx("mini-btn", (r.sl != null || r.target != null) && "text-accent")}
                                title="Set a price alert" onClick={() => startAlert(r)}>
                                <Bell size={11} weight={r.sl != null || r.target != null ? "fill" : "bold"} />
                              </button>
                            )}
                          </td>
                          <td className="py-1.5 text-right whitespace-nowrap">
                            {exitingId === r.id ? (
                              <span className="inline-flex items-center gap-1">
                                <button className="mini-btn" disabled={exitQty <= 1}
                                  onClick={() => setExitQty((q) => Math.max(1, q - 1))}>
                                  <Minus size={10} weight="bold" />
                                </button>
                                <span className="n" style={{ minWidth: 18, display: "inline-block", textAlign: "center" }}>
                                  {exitQty}
                                </span>
                                <button className="mini-btn" disabled={exitQty >= r.lots}
                                  onClick={() => setExitQty((q) => Math.min(r.lots, q + 1))}>
                                  <Plus size={10} weight="bold" />
                                </button>
                                <button className="mini-btn" title="Confirm exit" disabled={r.ltp == null}
                                  onClick={() => confirmExit(r, r.ltp)}>
                                  <Check size={11} weight="bold" />
                                </button>
                                <button className="mini-btn is-danger" title="Cancel" onClick={() => setExitingId(null)}>
                                  <X size={11} weight="bold" />
                                </button>
                              </span>
                            ) : (
                              <button className="mini-btn" title={r.ltp == null ? "No live price yet" : "Book profit / exit"}
                                disabled={r.ltp == null} onClick={() => startExit(r)}>
                                <SignOut size={11} weight="bold" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {open.length > 0 && notifPerm === "denied" && (
              <p className="text-[10.5px] text-muted mt-2 px-1">
                Browser notifications are blocked — alerts will still show inside the app the next
                time you open it, just not as a system notification.
              </p>
            )}

            {closed.length > 0 && (
              <div className={open.length > 0 ? "mt-4" : ""}>
                <button className="flex items-center gap-1 text-[11.5px] text-muted font-medium mb-1.5"
                  onClick={() => setClosedShown((v) => !v)}>
                  {closedShown ? <CaretUp size={10} weight="bold" /> : <CaretDown size={10} weight="bold" />}
                  Booked ({closed.length}) · {sgn(realized)}
                </button>
                {closedShown && closedGroups.map((group) => (
                  <div key={group.name} className="mb-3 last:mb-0">
                    {closedGroups.length > 1 && (
                      <div className="flex items-center justify-between px-1 mb-1">
                        <span className="text-[11px] font-semibold text-muted">{group.name || "Other positions"}</span>
                        <span className={cx("text-[11px] font-medium",
                          group.subtotal > 0 ? "text-gain" : group.subtotal < 0 ? "text-loss" : "text-muted")}>
                          {sgn(group.subtotal)}
                        </span>
                      </div>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="text-muted text-left">
                            <th className="font-medium py-1 pr-2">Leg</th>
                            <th className="font-medium py-1 pr-2">Closed</th>
                            <th className="font-medium py-1 pr-2 text-right">Entry</th>
                            <th className="font-medium py-1 pr-2 text-right">Exit</th>
                            <th className="font-medium py-1 text-right">P&L</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map((r) => (
                            <tr key={r.id} style={{ borderTop: "1px solid var(--c-line)" }} className="opacity-80">
                              <td className="py-1.5 pr-2">
                                <b className={r.side === "SELL" ? "text-loss" : "text-gain"}>
                                  {r.side === "SELL" ? "S" : "B"}
                                </b>{" "}
                                {r.strike}{r.right} <span className="text-faint">{r.expiry} · {r.lots}L</span>
                              </td>
                              <td className="py-1.5 pr-2 text-muted">{r.closedDate}</td>
                              <td className="py-1.5 pr-2 text-right">{fm(r.entryPrice)}</td>
                              <td className="py-1.5 pr-2 text-right">{fm(r.closePrice)}</td>
                              <td className={cx("py-1.5 text-right font-medium",
                                r.pnl > 0 ? "text-gain" : r.pnl < 0 ? "text-loss" : "")}>
                                {sgn(r.pnl)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* A hand-rolled SVG line, matching CandleChart's own reasoning: no charting
   library has a lighter way to draw one line through a handful of points. */
function PnlHistoryChart({ history }) {
  const W = 640, H = 220, PAD = { top: 12, right: 12, bottom: 24, left: 56 };
  const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
  const vals = history.map((h) => h.pnl);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.1 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const x = (i) => PAD.left + (history.length <= 1 ? plotW / 2 : (i / (history.length - 1)) * plotW);
  const y = (v) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const path = history.map((h, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(h.pnl)}`).join(" ");
  const zero = y(0);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        <line x1={PAD.left} x2={W - PAD.right} y1={zero} y2={zero} stroke="var(--c-line)" />
        <path d={path} fill="none" stroke="var(--c-accent)" strokeWidth={1.75} />
        {history.map((h, i) => (
          <circle key={h.date} cx={x(i)} cy={y(h.pnl)} r={2.5}
            fill={h.pnl >= 0 ? "var(--c-gain)" : "var(--c-loss)"} />
        ))}
        {history.map((h, i) => (
          (i === 0 || i === history.length - 1 || i % Math.ceil(history.length / 6) === 0) && (
            <text key={h.date} x={x(i)} y={H - 6} textAnchor="middle" fontSize={9.5} fill="var(--c-muted)">
              {new Date(h.date + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
            </text>
          )
        ))}
        <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" fontSize={9.5} fill="var(--c-muted)">{fm(yMax, 0)}</text>
        <text x={PAD.left - 6} y={H - PAD.bottom} textAnchor="end" fontSize={9.5} fill="var(--c-muted)">{fm(yMin, 0)}</text>
      </svg>
      <p className="text-[10.5px] text-muted mt-1 px-1">
        Combined P&L (open + booked) as of each day this Portfolio was last opened — not a
        continuous feed, so a day you never checked in on won't have a point.
      </p>
    </div>
  );
}
