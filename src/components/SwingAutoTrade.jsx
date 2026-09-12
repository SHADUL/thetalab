import { useState, useEffect, useCallback } from "react";
import { Info } from "@phosphor-icons/react";
import { inr, pctSigned, toneClass, PRESETS } from "./swingFormat.js";
import { kiteLoginUrl, assumedKiteConnected, consumeKiteRedirectResult } from "../lib/kiteClient.js";

const PROTECTION_LABEL = { GTT: "Stop + Target", SL_ONLY: "Stop Only", NONE: "Unprotected" };
const PROTECTION_TONE = { GTT: "gain", SL_ONLY: "warn", NONE: "loss" };

const inputStyle = { border: "1px solid var(--c-line-2)", background: "var(--c-surface-2)" };

function SettingsPanel({ settings, onSaved }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [reservedFund, setReservedFund] = useState(String(settings.reservedFund));
  const [riskPct, setRiskPct] = useState(String(settings.riskPct));
  const [maxPositions, setMaxPositions] = useState(String(settings.maxPositions));
  const [preset, setPreset] = useState(settings.preset);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingEnable, setConfirmingEnable] = useState(false);

  const dirty = enabled !== settings.enabled || reservedFund !== String(settings.reservedFund)
    || riskPct !== String(settings.riskPct) || maxPositions !== String(settings.maxPositions) || preset !== settings.preset;

  const save = async (nextEnabled) => {
    const rf = Number(reservedFund);
    const rp = Number(riskPct);
    const mp = Number(maxPositions);
    if (!Number.isFinite(rf) || rf < 0) { setError("Enter a valid reserved fund amount."); return; }
    if (!Number.isFinite(rp) || rp <= 0 || rp > 100) { setError("Risk % must be between 0 and 100."); return; }
    if (!Number.isInteger(mp) || mp < 1 || mp > 20) { setError("Max positions must be a whole number between 1 and 20."); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/swing-autotrade-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, reservedFund: rf, riskPct: rp, maxPositions: mp, preset }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.message || body.error || "Failed to save.");
      setEnabled(nextEnabled);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = () => {
    if (enabled) { save(false); return; }
    setConfirmingEnable(true);
  };

  return (
    <div className="p-4 rounded-[14px] flex flex-col gap-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-bold">Auto-Trade Settings</h3>
        <button onClick={toggleEnabled} disabled={saving} className={`topstep font-semibold ${enabled ? "text-gain" : "text-loss"}`}>
          {enabled ? "● LIVE — placing real orders" : "○ OFF"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Reserved Fund (₹)</span>
          <input type="number" min="0" inputMode="decimal" value={reservedFund} onChange={(e) => setReservedFund(e.target.value)}
            className="n px-2.5 py-1.5 rounded-[8px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Risk per Trade (%)</span>
          <input type="number" min="0.1" max="100" step="0.1" inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)}
            className="n px-2.5 py-1.5 rounded-[8px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Max Positions</span>
          <input type="number" min="1" max="20" step="1" value={maxPositions} onChange={(e) => setMaxPositions(e.target.value)}
            className="n px-2.5 py-1.5 rounded-[8px]" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Ranking Preset</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}
            className="n px-2.5 py-1.5 rounded-[8px]" style={inputStyle}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="text-[11px] text-loss">{error}</p>}
      {dirty && !confirmingEnable && (
        <button onClick={() => save(enabled)} disabled={saving} className="topstep w-full justify-center">
          {saving ? "Saving…" : "Save Settings"}
        </button>
      )}

      {confirmingEnable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="rounded-[14px] p-4" style={{ width: 380, maxWidth: "100%", border: "1px solid var(--c-loss)", background: "var(--c-surface)" }}>
            <h4 className="text-[13px] font-bold text-loss mb-2">Turn on live auto-trading?</h4>
            <p className="text-[12px] text-ink2 mb-3 leading-relaxed">
              This places REAL orders on your Zerodha account — up to {maxPositions} positions, sized from{" "}
              <b>{inr(Number(reservedFund))}</b> at <b>{riskPct}%</b> risk per trade — the next time the bot ticks
              while the market is open and you're logged into Kite.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmingEnable(false)} className="topstep flex-1 justify-center">Cancel</button>
              <button onClick={() => { setConfirmingEnable(false); save(true); }} disabled={saving} className="topstep flex-1 justify-center text-loss">
                Yes, go live
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PositionsTable({ positions }) {
  const isOpen = positions[0]?.status === "OPEN";
  return (
    <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
            <th className="font-medium py-2 pl-3 pr-2">Stock</th>
            <th className="font-medium py-2 pr-2 text-right">Shares</th>
            <th className="font-medium py-2 pr-2 text-right">Entry</th>
            <th className="font-medium py-2 pr-2 text-right">{isOpen ? "Current" : "Exit"}</th>
            <th className="font-medium py-2 pr-2 text-right">P&amp;L</th>
            <th className="font-medium py-2 pr-2 text-right">P&amp;L%</th>
            <th className="font-medium py-2 pr-2 text-right">Stop</th>
            <th className="font-medium py-2 pr-2 text-right">Target</th>
            <th className="font-medium py-2 pr-2">Protection</th>
            <th className="font-medium py-2 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} style={{ borderTop: "1px solid var(--c-line)" }}>
              <td className="py-2 pl-3 pr-2">
                <div className="font-semibold">{p.symbol}</div>
                <div className="text-[10.5px] text-faint">{p.entryDate}</div>
              </td>
              <td className="py-2 pr-2 text-right n">{p.shares}</td>
              <td className="py-2 pr-2 text-right n">{inr(p.entryPrice)}</td>
              <td className="py-2 pr-2 text-right n">{inr(p.currentPrice)}</td>
              <td className={`py-2 pr-2 text-right n font-semibold ${p.pnlAmount == null ? "text-faint" : p.pnlAmount >= 0 ? "text-gain" : "text-loss"}`}>
                {p.pnlAmount == null ? "—" : inr(p.pnlAmount)}
              </td>
              <td className={`py-2 pr-2 text-right n font-semibold ${p.pnlPct == null ? "text-faint" : p.pnlPct >= 0 ? "text-gain" : "text-loss"}`}>
                {pctSigned(p.pnlPct)}
              </td>
              <td className="py-2 pr-2 text-right n text-loss">{inr(p.stop)}</td>
              <td className="py-2 pr-2 text-right n text-gain">{inr(p.target)}</td>
              <td className={`py-2 pr-2 text-[11px] font-medium ${toneClass(PROTECTION_TONE[p.protection])}`}>
                {PROTECTION_LABEL[p.protection] ?? p.protection}
              </td>
              <td className="py-2 pr-3 text-[11px] font-medium">{p.status === "OPEN" ? "Open" : (p.exitReason ?? "Closed")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SwingAutoTrade() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kiteConnected, setKiteConnected] = useState(() => assumedKiteConnected());

  useEffect(() => {
    const r = consumeKiteRedirectResult();
    if (r) setKiteConnected(r.connected);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/swing-autotrade-positions")
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.message || body.error);
        setData(body);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>;
  if (error) {
    return (
      <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
        <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
        <p className="text-[12.5px] text-ink2">{error}</p>
      </div>
    );
  }

  const positions = data?.positions ?? [];
  const openPositions = positions.filter((p) => p.status === "OPEN");
  const closedPositions = positions.filter((p) => p.status === "CLOSED");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 p-3 rounded-[12px]"
        style={{ border: "1px solid var(--c-line)", background: kiteConnected ? "var(--c-gain-soft)" : "var(--c-warn-soft)" }}>
        <span className="text-[12px] font-medium">
          {kiteConnected ? "Kite: connected" : "Kite: not connected — the bot can't act without today's login"}
        </span>
        <a href={kiteLoginUrl()} className="topstep">{kiteConnected ? "Reconnect" : "Connect Kite"}</a>
      </div>

      {data?.settings && <SettingsPanel settings={data.settings} onSaved={load} />}

      {data?.settings && (
        <div className="grid grid-cols-4 gap-2.5 p-3 rounded-[12px] text-[11px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface-2)" }}>
          <div><div className="text-muted">Reserved Fund</div><div className="n font-semibold">{inr(data.settings.reservedFund)}</div></div>
          <div><div className="text-muted">Allocated</div><div className="n font-semibold">{inr(data.settings.allocated)}</div></div>
          <div><div className="text-muted">Available</div><div className={`n font-semibold ${data.settings.available < 0 ? "text-loss" : ""}`}>{inr(data.settings.available)}</div></div>
          <div><div className="text-muted">Open Positions</div><div className="n font-semibold">{openPositions.length} / {data.settings.maxPositions}</div></div>
        </div>
      )}

      <div>
        <h3 className="text-[12.5px] font-bold mb-2">Open Positions</h3>
        {openPositions.length === 0 ? (
          <p className="text-[12px] text-muted py-4 text-center">No bot-held positions right now.</p>
        ) : (
          <PositionsTable positions={openPositions} />
        )}
      </div>

      {closedPositions.length > 0 && (
        <div>
          <h3 className="text-[12.5px] font-bold mb-2">Closed</h3>
          <PositionsTable positions={closedPositions} />
        </div>
      )}

      <div>
        <h3 className="text-[12.5px] font-bold mb-2">Activity Log</h3>
        <div className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto rounded-[12px] p-3" style={{ border: "1px solid var(--c-line)" }}>
          {(data?.log ?? []).length === 0 ? (
            <p className="text-[12px] text-muted text-center py-4">Nothing logged yet.</p>
          ) : data.log.map((entry) => (
            <div key={entry.id} className={`text-[11px] flex gap-2 ${entry.level === "error" ? "text-loss" : "text-ink2"}`}>
              <span className="text-faint shrink-0 n">
                {new Date(entry.at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}
              </span>
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
