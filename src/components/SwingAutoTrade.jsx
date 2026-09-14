import { useState, useEffect, useCallback, useMemo } from "react";
import {
  MagnifyingGlass, ShieldCheck, Power, WarningOctagon, DownloadSimple, Trash, CircleNotch, ChartLineUp,
} from "@phosphor-icons/react";
import { inr, pctSigned, tradingViewUrl, PRESETS } from "./swingFormat.js";
import { kiteLoginUrl, assumedKiteConnected, consumeKiteRedirectResult } from "../lib/kiteClient.js";

/**
 * Redesigned per a Stitch mockup the user supplied, then moved off that
 * mockup's bespoke dark-only palette onto the app's own shared `--c-*`
 * theme tokens (same ones Scanner/Portfolio already use) so this tab
 * respects the site's actual light/dark setting instead of carrying a
 * second, disconnected theming system.
 *
 * Several numbers/controls in the original mockup were placeholders that
 * don't correspond to anything this backend actually does — replaced
 * with the real equivalent rather than left as fiction:
 *  - "BRACKET (MIS/CNC)" -> "CNC + Two-Leg GTT" (what this system actually places)
 *  - "Daily Stop @ -₹2,500" (no such feature exists) -> the real entry drift guard
 *  - "Backtest: 68% WR" (no backtest engine exists yet) -> dropped
 *  - fake preset names (Alpha Trend, ...) -> the real 6 presets
 *  - "Trailing ATR" column (no trailing-stop logic exists) -> real Protection state
 *  - 3 fake guardrail checkboxes -> the real, non-editable safeguards this code has
 *  - Edit-position button (no GTT-edit flow exists yet) -> dropped
 * Panic Halt and per-position Exit ARE real — they call api/swing-autotrade.js.
 */

const ENTRY_DRIFT_GUARD_PCT = 3; // must match MAX_ENTRY_DRIFT_PCT in api/swing-autotrade-tick.js

const TONE_TEXT = { emerald: "text-gain", rose: "text-loss", amber: "text-warn", indigo: "text-accent", slate: "text-muted" };
const TONE_VAR = { emerald: "var(--c-gain)", rose: "var(--c-loss)", amber: "var(--c-warn)", indigo: "var(--c-accent)", slate: "var(--c-muted)" };
const TONE_SOFT = { emerald: "var(--c-gain-soft)", rose: "var(--c-loss-soft)", amber: "var(--c-warn-soft)", indigo: "var(--c-accent-soft)", slate: "var(--c-surface-3)" };

function Pill({ tone = "slate", children }) {
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1.5 whitespace-nowrap n ${TONE_TEXT[tone]}`}
      style={{ background: TONE_SOFT[tone], border: `1px solid ${TONE_VAR[tone]}` }}>
      {children}
    </span>
  );
}

function KpiCard({ label, tag, tagTone, value, valueTone, footer, progressPct }) {
  return (
    <div className="p-4 rounded-[14px]" style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
      <div className="flex items-center justify-between text-[11px] mb-1 text-muted">
        <span>{label}</span>
        {tag && <span className={`text-[10px] font-semibold n ${tagTone ? TONE_TEXT[tagTone] : "text-faint"}`}>{tag}</span>}
      </div>
      <div className={`text-2xl font-bold n tracking-tight ${valueTone ? TONE_TEXT[valueTone] : "text-ink"}`}>{value}</div>
      {progressPct != null && (
        <div className="mt-3 w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--c-surface-3)" }}>
          <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, Math.max(0, progressPct))}%`, background: "var(--c-accent)" }} />
        </div>
      )}
      {footer && <div className="mt-3 flex items-center justify-between text-xs text-muted">{footer}</div>}
    </div>
  );
}

function HealthCard({ label, children }) {
  return (
    <div className="p-3 rounded-[12px] flex items-center justify-between" style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
      <span className="text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

function Field({ label, hint, hintTone, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-ink2">{label}</label>
        {hint && <span className={`text-[11px] n ${hintTone ? TONE_TEXT[hintTone] : "text-faint"}`}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const inputStyle = { border: "1px solid var(--c-line-2)", background: "var(--c-surface-2)" };
const inputCls = "n w-full rounded-[8px] text-[13px] px-2.5 py-2";

function safeguards() {
  return [
    "Two-leg GTT stop + target placed on every entry",
    "Falls back to a stop-only order if GTT placement fails",
    `Entry skipped if live price drifted >${ENTRY_DRIFT_GUARD_PCT}% from the scan-time reference`,
    "Master switch is OFF by default on every deploy",
  ];
}

function classifyLog(entry) {
  const m = entry.message ?? "";
  if (entry.level === "error") {
    if (/CRITICAL/i.test(m)) return { tag: "CRITICAL", tone: "rose", status: "CRITICAL" };
    if (/panic halt/i.test(m)) return { tag: "PANIC_HALT", tone: "rose", status: "HALTED" };
    return { tag: "ERROR", tone: "amber", status: "WARN" };
  }
  if (/^Entered /.test(m)) return { tag: "ORDER_PLACED", tone: "indigo", status: "FILLED" };
  if (/closed:|^Manually exited/i.test(m)) return { tag: "POSITION_CLOSED", tone: "emerald", status: "OK" };
  if (/^Skipped/.test(m)) return { tag: "SKIPPED", tone: "slate", status: "SKIP" };
  return { tag: "INFO", tone: "slate", status: "OK" };
}

function sessionValidityLabel(obtainedAt, now) {
  if (!obtainedAt) return { label: "No session", tone: null };
  const expiresAt = new Date(obtainedAt).getTime() + 20 * 60 * 60 * 1000;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return { label: "Expired — reconnect", tone: "rose" };
  const h = Math.floor(remainingMs / 3_600_000);
  const m = Math.floor((remainingMs % 3_600_000) / 60_000);
  return { label: `Expires in ${h}h ${m}m`, tone: null };
}

function SettingsPanel({ settings, totalFund, onSaved, pushToast }) {
  const [reservedFund, setReservedFund] = useState(String(settings.reservedFund));
  const [riskPct, setRiskPct] = useState(String(settings.riskPct));
  const [maxPositions, setMaxPositions] = useState(String(settings.maxPositions));
  const [preset, setPreset] = useState(settings.preset);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const dirty = reservedFund !== String(settings.reservedFund) || riskPct !== String(settings.riskPct)
    || maxPositions !== String(settings.maxPositions) || preset !== settings.preset;

  const maxPositionOptions = useMemo(() => {
    const base = [3, 5, 8, 10];
    const current = Number(settings.maxPositions);
    return base.includes(current) ? base : [current, ...base].sort((a, b) => a - b);
  }, [settings.maxPositions]);

  const reset = () => { setReservedFund("0"); setRiskPct("5"); setMaxPositions("5"); setPreset("balanced"); };

  const save = async () => {
    const rf = Number(reservedFund), rp = Number(riskPct), mp = Number(maxPositions);
    if (!Number.isFinite(rf) || rf < 0) { setError("Enter a valid reserved fund amount."); return; }
    if (!Number.isFinite(rp) || rp <= 0 || rp > 100) { setError("Risk % must be between 0 and 100."); return; }
    if (!Number.isInteger(mp) || mp < 1 || mp > 20) { setError("Max positions must be a whole number."); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/swing-autotrade", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: settings.enabled, reservedFund: rf, riskPct: rp, maxPositions: mp, preset }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.message || body.error || "Failed to save.");
      pushToast?.("Parameters saved.");
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const riskAmount = Number(reservedFund) > 0 && Number(riskPct) > 0 ? (Number(reservedFund) * Number(riskPct)) / 100 : null;
  const perSlotAlloc = Number(reservedFund) > 0 && Number(maxPositions) > 0 ? Number(reservedFund) / Number(maxPositions) : null;

  return (
    <section className="rounded-[16px] p-4 sm:p-6" style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
      <div className="flex flex-col md:flex-row md:items-center justify-between pb-5 gap-3" style={{ borderBottom: "1px solid var(--c-line)" }}>
        <div>
          <h2 className="text-[14px] font-bold text-ink">Execution Engine Parameters</h2>
          <p className="text-xs mt-0.5 text-muted">Define sizing logic, stock ranking preset, and how many positions the bot can hold at once.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reset} className="topstep">Reset Defaults</button>
          <button onClick={save} disabled={saving || !dirty} className="topstep disabled:opacity-50" style={dirty ? { background: "var(--c-accent)", color: "var(--c-accent-ink)", borderColor: "var(--c-accent)" } : undefined}>
            {saving ? "Saving…" : "Save Parameters"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 pt-5">
        <Field label="Reserved Fund (₹)" hint={totalFund ? `Total: ${inr(totalFund)}` : undefined}>
          <input type="number" min="0" value={reservedFund} onChange={(e) => setReservedFund(e.target.value)} className={inputCls} style={inputStyle} />
          <div className="flex gap-1.5 pt-1">
            {[25000, 50000, 75000].map((v) => (
              <button key={v} onClick={() => setReservedFund(String(v))}
                className={`px-2 py-0.5 text-[10px] n rounded ${Number(reservedFund) === v ? "font-semibold" : ""}`}
                style={Number(reservedFund) === v
                  ? { background: "var(--c-accent-soft)", color: "var(--c-accent)", border: "1px solid var(--c-accent)" }
                  : { background: "var(--c-surface-3)", color: "var(--c-text-2)", border: "1px solid var(--c-line-2)" }}>
                ₹{v / 1000}K
              </button>
            ))}
            {totalFund != null && (
              <button onClick={() => setReservedFund(String(totalFund))} className="px-2 py-0.5 text-[10px] n rounded"
                style={{ background: "var(--c-surface-3)", color: "var(--c-text-2)", border: "1px solid var(--c-line-2)" }}>
                MAX
              </button>
            )}
          </div>
        </Field>

        <Field label="Risk per Trade (%)" hint={riskAmount != null ? `${inr(riskAmount)} / trade` : undefined} hintTone="amber">
          <input type="number" min="0.1" max="100" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} className={inputCls} style={inputStyle} />
          <div className="flex items-center justify-between text-[11px] pt-1 text-muted">
            <span>Aggressive: &gt;3%</span>
            <span className="text-accent font-medium">Optimal: 1–2%</span>
          </div>
        </Field>

        <Field label="Max Positions (Slots)" hint={perSlotAlloc != null ? `~${inr(perSlotAlloc)} / slot` : undefined}>
          <select value={maxPositions} onChange={(e) => setMaxPositions(e.target.value)} className={`${inputCls} cursor-pointer`} style={inputStyle}>
            {maxPositionOptions.map((n) => <option key={n} value={n}>{n} Concurrent Position{n === 1 ? "" : "s"}</option>)}
          </select>
          <p className="text-[11px] pt-1 text-faint">Diversifies capital across top non-correlated symbols.</p>
        </Field>

        <Field label="Ranking Preset Strategy">
          <select value={preset} onChange={(e) => setPreset(e.target.value)} className={`${inputCls} cursor-pointer`} style={inputStyle}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <p className="text-[11px] pt-1 text-faint">Same weighting presets as the Scanner tab.</p>
        </Field>
      </div>

      {error && <p className="text-[11px] mt-4 text-loss">{error}</p>}

      <div className="mt-6 pt-5 flex flex-wrap items-center justify-between gap-4 text-xs" style={{ borderTop: "1px solid var(--c-line)" }}>
        <div className="flex items-center gap-5 flex-wrap">
          {safeguards().map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-ink2">
              <ShieldCheck size={13} weight="fill" className="text-gain" />
              {s}
            </span>
          ))}
        </div>
        {settings.updatedAt && (
          <div className="text-[11px] n text-faint">
            Last saved: {new Date(settings.updatedAt).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}
          </div>
        )}
      </div>
    </section>
  );
}

function PositionsTable({ positions, maxPositions, reservedFund, onExit, exitingId }) {
  const openPositions = positions.filter((p) => p.status === "OPEN");
  const idleSlots = Math.max(0, maxPositions - openPositions.length);
  const perSlot = maxPositions > 0 ? reservedFund / maxPositions : 0;

  return (
    <div className="rounded-[16px] overflow-hidden" style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted" style={{ background: "var(--c-surface-2)", borderBottom: "1px solid var(--c-line)" }}>
            <tr>
              <th className="py-3 px-4 font-medium">Instrument</th>
              <th className="py-3 px-4 font-medium">Type &amp; Qty</th>
              <th className="py-3 px-4 font-medium">Avg. Entry</th>
              <th className="py-3 px-4 font-medium">LTP</th>
              <th className="py-3 px-4 font-medium">Target / Stop</th>
              <th className="py-3 px-4 font-medium">Protection</th>
              <th className="py-3 px-4 font-medium text-right">Unrealized P&amp;L</th>
              <th className="py-3 px-4 font-medium text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {openPositions.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-[8px] flex items-center justify-center font-bold text-[11px] text-ink"
                      style={{ background: "var(--c-surface-3)", border: "1px solid var(--c-line-2)" }}>
                      {p.symbol.slice(0, 2)}
                    </div>
                    <div>
                      <div className="font-semibold flex items-center gap-1.5 text-ink">
                        {p.symbol}
                        <span className="text-[10px] px-1 rounded text-faint" style={{ background: "var(--c-surface-3)" }}>NSE</span>
                      </div>
                      <div className="text-[11px] text-faint">{p.name}</div>
                    </div>
                  </div>
                </td>
                <td className="py-3 px-4">
                  <Pill tone="emerald">BUY</Pill>
                  <span className="n ml-1.5 text-ink2">{p.shares} Qty</span>
                </td>
                <td className="py-3 px-4 n text-ink2">{inr(p.entryPrice)}</td>
                <td className="py-3 px-4 n font-semibold text-ink">{inr(p.currentPrice)}</td>
                <td className="py-3 px-4 n">
                  <div className="text-[11px] text-gain">Tgt: {inr(p.target)}</div>
                  <div className="text-[11px] text-loss">Sl: {inr(p.stop)}</div>
                </td>
                <td className="py-3 px-4">
                  <Pill tone={p.protection === "GTT" ? "indigo" : p.protection === "SL_ONLY" ? "amber" : "rose"}>
                    {p.protection === "GTT" ? "GTT ARMED" : p.protection === "SL_ONLY" ? "STOP ONLY" : "UNPROTECTED"}
                  </Pill>
                </td>
                <td className="py-3 px-4 text-right n">
                  <div className={`text-sm font-bold ${(p.pnlAmount ?? 0) >= 0 ? "text-gain" : "text-loss"}`}>
                    {p.pnlAmount == null ? "—" : `${p.pnlAmount >= 0 ? "+" : ""}${inr(p.pnlAmount)}`}
                  </div>
                  <div className={`text-[11px] ${(p.pnlAmount ?? 0) >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(p.pnlPct)} Return</div>
                </td>
                <td className="py-3 px-4 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <a href={tradingViewUrl(p.symbol)} target="_blank" rel="noopener noreferrer" className="mini-btn" title="Open in TradingView">
                      <ChartLineUp size={11} weight="bold" />
                    </a>
                    <button onClick={() => onExit(p)} disabled={exitingId === p.id} className="mini-btn is-danger disabled:opacity-50" title="Cancel protection and market-sell this position now">
                      {exitingId === p.id ? "Exiting…" : "Exit"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {Array.from({ length: idleSlots }).map((_, i) => (
              <tr key={`idle-${i}`} style={{ borderTop: "1px solid var(--c-line)", background: "var(--c-surface-2)" }}>
                <td className="py-2.5 px-4" colSpan={8}>
                  <div className="flex items-center justify-between py-1 px-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ border: "1px solid var(--c-faint)" }} />
                      <span className="text-faint">Position Slot #{openPositions.length + i + 1}: Idle</span>
                      <span className="text-faint">— filled from the next best-ranked candidate not already held</span>
                    </div>
                    <span className="text-[11px] n text-faint">~{inr(perSlot)} reserved</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function SwingAutoTrade() {
  const [data, setData] = useState(null);
  const [totalFund, setTotalFund] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kiteConnected, setKiteConnected] = useState(() => assumedKiteConnected());
  const [now, setNow] = useState(() => Date.now());
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  const [confirmingPanic, setConfirmingPanic] = useState(false);
  const [exitingId, setExitingId] = useState(null);
  const [closingAll, setClosingAll] = useState(false);
  const [toast, setToast] = useState(null);
  const [logClearedAt, setLogClearedAt] = useState(null);

  useEffect(() => {
    const r = consumeKiteRedirectResult();
    if (r) setKiteConnected(r.connected);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    fetch("/api/swing-autotrade").then((r) => r.json()).then((body) => {
      if (body.error) throw new Error(body.message || body.error);
      setData(body);
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch("/api/swing-settings").then((r) => r.json()).then((body) => { if (!body.error) setTotalFund(body.totalFund); }).catch(() => {});
  }, []);

  const toggleEnabled = async (nextEnabled) => {
    if (!data?.settings) return;
    const s = data.settings;
    try {
      const res = await fetch("/api/swing-autotrade", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, reservedFund: s.reservedFund, riskPct: s.riskPct, maxPositions: s.maxPositions, preset: s.preset }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.message || body.error || "Failed to save.");
      setToast(nextEnabled ? "Auto-trade is now LIVE." : "Auto-trade turned off.");
      load();
    } catch (e) {
      setToast(e.message);
    }
  };

  const panicHalt = async () => {
    setConfirmingPanic(false);
    try {
      const res = await fetch("/api/swing-autotrade", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "panic_halt" }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.message || body.error || "Panic halt failed.");
      setToast(`Panic halt: disabled, ${body.cancelled} position(s) unprotected.`);
      load();
    } catch (e) {
      setToast(e.message);
    }
  };

  const exitPosition = async (pos) => {
    setExitingId(pos.id);
    try {
      const res = await fetch("/api/swing-autotrade", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "exit_position", id: pos.id }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.message || body.error || "Exit failed.");
      setToast(`Exited ${pos.symbol}.`);
      load();
    } catch (e) {
      setToast(e.message);
    } finally {
      setExitingId(null);
    }
  };

  const closeAll = async () => {
    const open = (data?.positions ?? []).filter((p) => p.status === "OPEN");
    if (open.length === 0) return;
    setClosingAll(true);
    for (const p of open) {
      try {
        await fetch("/api/swing-autotrade", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "exit_position", id: p.id }),
        });
      } catch { /* keep going, surfaced in the log */ }
    }
    setClosingAll(false);
    setToast("Close-all finished — check the log for any that failed.");
    load();
  };

  const exportLog = () => {
    const blob = new Blob([JSON.stringify(data?.log ?? [], null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `autotrade-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) return <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>;
  if (error) {
    return (
      <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
        <WarningOctagon size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
        <p className="text-[12.5px] text-ink2">{error}</p>
      </div>
    );
  }

  const settings = data.settings ?? { enabled: false, reservedFund: 0, riskPct: 5, maxPositions: 5, preset: "balanced", allocated: 0, available: 0 };
  const positions = data.positions ?? [];
  const openPositions = positions.filter((p) => p.status === "OPEN");
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = positions.filter((p) => p.status === "CLOSED" && p.exitDate === today);
  const unrealized = openPositions.reduce((s, p) => s + (p.pnlAmount ?? 0), 0);
  const realizedToday = closedToday.reduce((s, p) => s + (p.pnlAmount ?? 0), 0);
  const dayPnl = unrealized + realizedToday;
  const dayPnlPct = settings.reservedFund > 0 ? (dayPnl / settings.reservedFund) * 100 : null;
  const session = sessionValidityLabel(data.kiteSessionObtainedAt, now);
  const visibleLog = (data.log ?? []).filter((e) => !logClearedAt || new Date(e.at).getTime() > logClearedAt);

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-[10px] text-xs font-medium shadow-lg text-ink"
          style={{ background: "var(--c-surface)", border: "1px solid var(--c-line-2)" }}>
          {toast}
        </div>
      )}

      {/* Hero + master killswitch */}
      <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        <div className="space-y-1.5 max-w-3xl">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[10px] text-accent" style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
              <MagnifyingGlass size={16} weight="bold" />
            </div>
            <h1 className="text-[18px] font-bold flex items-center gap-2.5 text-ink">
              Auto Trade
              <Pill tone={settings.enabled ? "emerald" : "rose"}>
                <span className={`w-1.5 h-1.5 rounded-full ${settings.enabled ? "bg-gain" : "bg-loss"}`} />
                {settings.enabled ? "ENGINE ARMED" : "ENGINE PAUSED"}
              </Pill>
            </h1>
          </div>
          <p className="text-[12.5px] leading-relaxed pl-[42px] text-muted max-w-[65ch]">
            Places real orders on your connected Zerodha account against a reserved fund separate from the manual
            Scanner fund — enters the top-ranked, not-yet-held stocks up to your max positions, protects each with a
            two-leg GTT stop/target, and rolls freed capital into the next best candidate on exit.
          </p>
        </div>

        <div className="flex items-center gap-3.5 p-3 rounded-[14px] self-start lg:self-auto" style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink">Algorithmic Execution</div>
            <div className={`text-[10.5px] n ${settings.enabled ? "text-gain" : "text-faint"}`}>
              {settings.enabled ? `ACTIVE · ${openPositions.length} SLOT${openPositions.length === 1 ? "" : "S"} RUNNING` : "PAUSED"}
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer" title="Toggle auto-execution">
            <input type="checkbox" className="sr-only peer" checked={settings.enabled}
              onChange={(e) => { if (e.target.checked) setConfirmingEnable(true); else toggleEnabled(false); }} />
            <div className="w-12 h-[26px] rounded-full transition-colors" style={{ background: settings.enabled ? "var(--c-gain)" : "var(--c-surface-3)", border: "1px solid var(--c-line-2)" }}>
              <div className="rounded-full h-5 w-5 mt-[1px] transition-transform" style={{ background: "#fff", transform: `translateX(${settings.enabled ? 26 : 3}px)` }} />
            </div>
          </label>
          <button onClick={() => setConfirmingPanic(true)} className="mini-btn is-danger flex items-center gap-1.5" title="Cancel all protective orders and disable auto-trade">
            <Power size={12} weight="bold" /> Panic Halt
          </button>
        </div>
      </section>

      {/* System health strip */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
        <HealthCard label="Broker Gateway">
          <span className="font-medium flex items-center gap-1.5 text-ink2">
            <span className={`w-2 h-2 rounded-full ${kiteConnected ? "bg-gain" : "bg-loss"}`} />
            Zerodha Kite Connect v3
          </span>
        </HealthCard>
        <HealthCard label="Session Validity">
          <span className={`n ${session.tone ? TONE_TEXT[session.tone] : "text-ink2"}`}>{session.label}</span>
        </HealthCard>
        <HealthCard label="Execution Mode">
          <span className="font-semibold px-2 py-0.5 rounded text-accent" style={{ background: "var(--c-accent-soft)", border: "1px solid var(--c-accent)" }}>
            CNC + Two-Leg GTT
          </span>
        </HealthCard>
        <HealthCard label="Entry Drift Guard">
          <span className="font-medium text-gain">Skip if &gt;{ENTRY_DRIFT_GUARD_PCT}% off reference</span>
        </HealthCard>
      </section>

      {/* KPI grid */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        <KpiCard label="Reserved Fund" tag="ISOLATED" value={inr(settings.reservedFund)}
          footer={<><span>Max Limit</span><span className="n text-ink2">{totalFund ? `${((settings.reservedFund / totalFund) * 100).toFixed(1)}% of Capital` : "—"}</span></>} />
        <KpiCard label="Allocated Margin" tag={settings.reservedFund > 0 ? `${((settings.allocated / settings.reservedFund) * 100).toFixed(1)}% USED` : undefined}
          tagTone="indigo" value={inr(settings.allocated)} valueTone="indigo"
          progressPct={settings.reservedFund > 0 ? (settings.allocated / settings.reservedFund) * 100 : 0} />
        <KpiCard label="Available to Deploy" tag="READY" tagTone="emerald" value={inr(settings.available)}
          footer={<><span>Capacity</span><span className="n text-ink2">{Math.max(0, settings.maxPositions - openPositions.length)} free slots</span></>} />
        <KpiCard label="Open Positions" tag={`${openPositions.length} ACTIVE`} tagTone="amber"
          value={<>{openPositions.length}<span className="text-sm font-normal text-faint"> / {settings.maxPositions} slots</span></>}
          footer={
            <div className="flex items-center gap-1.5 w-full">
              {Array.from({ length: settings.maxPositions }).map((_, i) => (
                <span key={i} className="flex-1 h-1.5 rounded-full" style={i < openPositions.length ? { background: "var(--c-gain)" } : { background: "var(--c-surface-3)", border: "1px dashed var(--c-line-2)" }} />
              ))}
            </div>
          } />
        <KpiCard label="Live Day P&L" tag={dayPnlPct != null ? `${dayPnlPct >= 0 ? "+" : ""}${dayPnlPct.toFixed(2)}%` : undefined}
          tagTone={dayPnl >= 0 ? "emerald" : "rose"} value={`${dayPnl >= 0 ? "+" : ""}${inr(dayPnl)}`} valueTone={dayPnl >= 0 ? "emerald" : "rose"}
          footer={<><span>Unrealized: <span className={unrealized >= 0 ? "text-gain" : "text-loss"}>{unrealized >= 0 ? "+" : ""}{inr(unrealized)}</span></span>
            <span>Realized: <span className="text-ink2">{realizedToday >= 0 ? "+" : ""}{inr(realizedToday)}</span></span></>} />
      </section>

      <SettingsPanel settings={settings} totalFund={totalFund} onSaved={load} pushToast={setToast} />

      {/* Positions */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-bold flex items-center gap-2 text-ink">
              Active Positions
              <span className="text-[11px] font-normal px-2 py-0.5 rounded text-ink2" style={{ background: "var(--c-surface-3)" }}>{openPositions.length} Running</span>
            </h2>
            <p className="text-xs text-muted">Live positions managed by the auto-trade tick job.</p>
          </div>
          {openPositions.length > 0 && (
            <button onClick={closeAll} disabled={closingAll} className="mini-btn is-danger flex items-center gap-1.5 disabled:opacity-50">
              {closingAll && <CircleNotch size={12} className="animate-spin" />}
              Close All Positions
            </button>
          )}
        </div>
        <PositionsTable positions={positions} maxPositions={settings.maxPositions} reservedFund={settings.reservedFund} onExit={exitPosition} exitingId={exitingId} />
      </section>

      {/* Audit log */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-bold flex items-center gap-2 text-ink">
              Audit &amp; Event Log
              <Pill tone="emerald"><span className="w-1.5 h-1.5 rounded-full bg-gain" /> LIVE</Pill>
            </h2>
            <p className="text-xs text-muted">Every order the bot placed, skipped, or failed — straight from the database, nothing summarized away.</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button onClick={exportLog} className="topstep flex items-center gap-1.5"><DownloadSimple size={12} /> Export JSON</button>
            <button onClick={() => setLogClearedAt(Date.now())} className="topstep flex items-center gap-1.5" title="Hides older entries from this view only — nothing is deleted">
              <Trash size={12} /> Clear View
            </button>
          </div>
        </div>

        <div className="rounded-[14px] p-4 text-xs overflow-hidden" style={{ background: "var(--c-surface-2)", border: "1px solid var(--c-line)" }}>
          <div className="flex items-center justify-between pb-3 mb-3 text-[11px] text-faint" style={{ borderBottom: "1px solid var(--c-line)" }}>
            <span>AUTO_TRADE_LOG</span>
            <span>{visibleLog.length} event{visibleLog.length === 1 ? "" : "s"}</span>
          </div>
          <div className="space-y-2 max-h-72 overflow-y-auto pr-2">
            {visibleLog.length === 0 ? (
              <p className="text-center py-6 text-faint">Nothing logged yet.</p>
            ) : visibleLog.map((entry) => {
              const c = classifyLog(entry);
              return (
                <div key={entry.id} className="flex items-start gap-3 py-1 rounded px-1.5">
                  <span className="n select-none shrink-0 text-faint">
                    {new Date(entry.at).toLocaleTimeString("en-IN", { hour12: false })}
                  </span>
                  <Pill tone={c.tone}>{c.tag}</Pill>
                  <span className="flex-1 text-ink2">{entry.message}</span>
                  <span className={`ml-auto shrink-0 font-medium n ${TONE_TEXT[c.tone]}`}>{c.status}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Confirm: go live */}
      {confirmingEnable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="rounded-[14px] p-5" style={{ width: 400, maxWidth: "100%", background: "var(--c-surface)", border: "1px solid var(--c-loss)" }}>
            <h4 className="text-[14px] font-bold mb-2 text-loss">Turn on live auto-trading?</h4>
            <p className="text-[12.5px] leading-relaxed mb-4 text-ink2">
              This places REAL orders on your Zerodha account — up to {settings.maxPositions} positions, sized from{" "}
              <b>{inr(settings.reservedFund)}</b> at <b>{settings.riskPct}%</b> risk per trade — the next time the bot
              ticks while the market is open and you're logged into Kite.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmingEnable(false)} className="topstep flex-1 justify-center">Cancel</button>
              <button onClick={() => { setConfirmingEnable(false); toggleEnabled(true); }} className="flex-1 py-1.5 text-[12px] font-medium rounded-[8px]" style={{ background: "var(--c-loss)", color: "#fff" }}>
                Yes, go live
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm: panic halt */}
      {confirmingPanic && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="rounded-[14px] p-5" style={{ width: 400, maxWidth: "100%", background: "var(--c-surface)", border: "1px solid var(--c-loss)" }}>
            <h4 className="text-[14px] font-bold mb-2 text-loss">Panic Halt?</h4>
            <p className="text-[12.5px] leading-relaxed mb-4 text-ink2">
              Disables auto-trade immediately and cancels every open position's protective GTT/stop order. It does{" "}
              <b>not</b> sell your shares — open positions stay open but become unprotected until you manage them
              manually or re-enable the bot.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmingPanic(false)} className="topstep flex-1 justify-center">Cancel</button>
              <button onClick={panicHalt} className="flex-1 py-1.5 text-[12px] font-medium rounded-[8px]" style={{ background: "var(--c-loss)", color: "#fff" }}>
                Panic Halt
              </button>
            </div>
          </div>
        </div>
      )}

      {!kiteConnected && (
        <div className="fixed bottom-6 left-6 z-40 flex items-center gap-3 px-4 py-2.5 rounded-[10px] text-xs text-ink2"
          style={{ background: "var(--c-surface)", border: "1px solid var(--c-warn)" }}>
          Kite not connected — the bot can't act without today's login.
          <a href={kiteLoginUrl()} className="font-semibold text-warn">Connect Kite</a>
        </div>
      )}
    </div>
  );
}
