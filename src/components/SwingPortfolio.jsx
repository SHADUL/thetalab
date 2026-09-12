import { useState, useEffect, useCallback } from "react";
import { Info, X } from "@phosphor-icons/react";

const STATUS_LABEL = {
  TARGET_HIT: "Target Hit", NEAR_TARGET: "Near Target", HOLD: "Hold",
  WEAKENING: "Weakening", STOP_RISK: "Stop Risk",
};
const STATUS_TONE = {
  TARGET_HIT: "gain", NEAR_TARGET: "gain", HOLD: "muted", WEAKENING: "warn", STOP_RISK: "loss",
};
function toneClass(tone) {
  return { gain: "text-gain", loss: "text-loss", warn: "text-warn", accent: "text-accent", muted: "text-muted" }[tone] ?? "text-muted";
}
function inr(v) {
  if (v == null) return "—";
  return `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function pctSigned(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * "My Portfolio" — spec §46's ACTIVE SWINGS view. Deliberately its own
 * component/table (Stock, Entry, Current, P&L%, Days Held, Target,
 * Distance to Target, Stop, Swing Score, Score Change, Status), not a
 * re-skin of the scanner's results table: the scanner ranks candidates
 * against each other today, this tracks specific positions against their
 * own entry point over time — different question, different columns.
 */
export default function SwingPortfolio({ refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/swing-watchlist")
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.message || body.error);
        setData(body);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const remove = async (symbol) => {
    setRemoving(symbol);
    try {
      await fetch(`/api/swing-watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
      load();
    } finally {
      setRemoving(null);
    }
  };

  const positions = data?.positions ?? [];

  if (loading) return <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>;
  if (error) {
    return (
      <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
        <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
        <p className="text-[12.5px] text-ink2">{error}</p>
      </div>
    );
  }
  if (positions.length === 0) {
    return (
      <p className="text-[12.5px] text-muted leading-relaxed py-10 text-center max-w-[50ch] mx-auto">
        Nothing tracked yet. Open a stock from the Scanner and use <b>Add to Portfolio</b> to start
        watching its performance day over day, from whatever price and score it had when you added it.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
            <th className="font-medium py-2 pl-3 pr-2">Stock</th>
            <th className="font-medium py-2 pr-2 text-right">Entry</th>
            <th className="font-medium py-2 pr-2 text-right">Current</th>
            <th className="font-medium py-2 pr-2 text-right">P&amp;L%</th>
            <th className="font-medium py-2 pr-2 text-right">Days Held</th>
            <th className="font-medium py-2 pr-2 text-right">Target</th>
            <th className="font-medium py-2 pr-2 text-right">Dist. to Target</th>
            <th className="font-medium py-2 pr-2 text-right">Stop</th>
            <th className="font-medium py-2 pr-2 text-right">Score</th>
            <th className="font-medium py-2 pr-2 text-right">Score Δ</th>
            <th className="font-medium py-2 pr-2">Status</th>
            <th className="font-medium py-2 pr-3" />
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.symbol} style={{ borderTop: "1px solid var(--c-line)" }}>
              <td className="py-2 pl-3 pr-2">
                <div className="font-semibold">{p.symbol}</div>
                <div className="text-[10.5px] text-faint">{p.entryDate}</div>
              </td>
              <td className="py-2 pr-2 text-right n">{inr(p.entryPrice)}</td>
              <td className="py-2 pr-2 text-right n">{inr(p.currentPrice)}</td>
              <td className={`py-2 pr-2 text-right n font-semibold ${p.pnlPct == null ? "text-faint" : p.pnlPct >= 0 ? "text-gain" : "text-loss"}`}>
                {pctSigned(p.pnlPct)}
              </td>
              <td className="py-2 pr-2 text-right n text-muted">{p.daysHeld ?? "—"}</td>
              <td className="py-2 pr-2 text-right n text-gain">{inr(p.target)}</td>
              <td className="py-2 pr-2 text-right n">{pctSigned(p.distanceToTargetPct)}</td>
              <td className="py-2 pr-2 text-right n text-loss">{inr(p.stop)}</td>
              <td className="py-2 pr-2 text-right n">{p.currentSwingScore ?? "—"}</td>
              <td className={`py-2 pr-2 text-right n font-semibold ${p.scoreChange == null ? "text-faint" : p.scoreChange >= 0 ? "text-gain" : "text-loss"}`}>
                {p.scoreChange == null ? "—" : `${p.scoreChange >= 0 ? "+" : ""}${p.scoreChange}`}
              </td>
              <td className={`py-2 pr-2 text-[11px] font-medium ${toneClass(STATUS_TONE[p.status])}`}>
                {STATUS_LABEL[p.status] ?? p.status}
              </td>
              <td className="py-2 pr-3 text-right">
                <button onClick={() => remove(p.symbol)} disabled={removing === p.symbol}
                  className="mini-btn is-danger" title="Remove from Portfolio">
                  <X size={11} weight="bold" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
