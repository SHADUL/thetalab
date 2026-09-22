import { useState, useEffect, useCallback, useRef } from "react";
import { ChartLineUp, Info, Wallet, Gear, CaretDown, CaretUp, HandPalm, Bell } from "@phosphor-icons/react";
import { inr, toneClass } from "./swingFormat.js";
import VwapScalperChart from "./VwapScalperChart.jsx";

const POLL_MS = 60_000; // reads already-computed state — the live scan itself runs on its own 1-minute cron, not on this poll

const STATUS_TONE = { ACTIVE: "muted", CLOSED: "muted" };

const NUMERIC_GROUPS = [
  {
    title: "Capital & Risk", fields: [
      { key: "account_equity", label: "Account equity (₹)", step: 1000, min: 0 },
      { key: "max_risk_per_trade_pct", label: "Max risk / trade %", step: 0.1, min: 0 },
      { key: "max_open_positions", label: "Max open positions", step: 1, min: 1 },
      { key: "max_consecutive_losses", label: "Max consecutive losses", step: 1, min: 1 },
    ],
  },
  {
    title: "Loss Limits", fields: [
      { key: "max_daily_loss_pct", label: "Max daily loss %", step: 0.1, min: 0 },
    ],
  },
  {
    title: "VWAP Bands", fields: [
      { key: "stdev_multiplier", label: "Std. deviation multiplier", step: 0.1, min: 0.1 },
    ],
  },
];

const DEFAULT_DRAFT = {
  account_equity: 0, max_risk_per_trade_pct: 1, max_daily_loss_pct: 3, max_open_positions: 3,
  max_consecutive_losses: 3, stdev_multiplier: 1.0, entry_mode: "REJECTION",
  slope_filter_enabled: false, slope_filter_lookback_bars: 10, slope_filter_threshold_sigma: 1.0,
  trend_filter_enabled: false, trend_filter_ema_length: 200,
  stop_loss_enabled: false, stop_loss_mode: "BEYOND_3SIGMA", stop_loss_percent: 0.5, stop_loss_sigma_buffer: 0.5,
};

function agoLabel(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function PositionRow({ p }) {
  const directionTone = p.direction === "LONG" ? "text-gain" : "text-loss";
  return (
    <tr style={{ borderTop: "1px solid var(--c-line)" }}>
      <td className="py-2 pl-3 pr-2 font-semibold">{p.symbol}</td>
      <td className={`py-2 pr-2 text-[11px] font-semibold ${directionTone}`}>{p.direction}</td>
      <td className="py-2 pr-2 text-right n">{p.quantity}</td>
      <td className="py-2 pr-2 text-right n">{inr(p.entry_price)}</td>
      <td className="py-2 pr-2 text-right n text-faint">{inr(p.vwap_at_entry)}</td>
      <td className="py-2 pr-2 text-right n">{p.stop_price != null ? inr(p.stop_price) : "—"}</td>
      <td className={`py-2 pr-2 text-[11px] ${toneClass(STATUS_TONE[p.status] ?? "muted")}`}>{p.status}{p.exit_reason ? ` · ${p.exit_reason}` : ""}</td>
      <td className={`py-2 pr-2 text-right n ${p.status !== "ACTIVE" || p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "text-gain" : "text-loss"}`}>
        {p.status === "ACTIVE" && p.unrealized_pnl != null ? (
          <>
            {inr(p.unrealized_pnl)}
            <div className="text-[10px] text-faint font-normal">{agoLabel(p.unrealized_pnl_updated_at)}</div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className={`py-2 pr-3 text-right n ${p.realized_pnl == null ? "" : p.realized_pnl >= 0 ? "text-gain" : "text-loss"}`}>
        {p.realized_pnl != null ? inr(p.realized_pnl) : "—"}
      </td>
    </tr>
  );
}

/**
 * VWAP 3σ Mean Reversion Scalper — dashboard for the NSE-side standalone
 * strategy (api/options-autotrade.ts's vwap-scalper-* resources — folded
 * into that file purely for the Vercel .ts-import technical reason
 * documented there, not a product relationship to options). This UI only
 * reads already-computed state; the live scan runs on its own 1-minute
 * cron against the NIFTY 50 universe, not on this page being open.
 * PAPER mode only: no real order is ever placed. Nasdaq is a separate,
 * not-yet-built integration (needs Alpaca) — this page is NSE only.
 */
export default function VwapScalper() {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(DEFAULT_DRAFT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [positions, setPositions] = useState({ active: [], closed: [] });
  const [logEntries, setLogEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
  const [killSwitchResult, setKillSwitchResult] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/options-autotrade?resource=vwap-scalper-settings").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=vwap-scalper-positions").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=vwap-scalper-log").then((r) => r.json()),
    ])
      .then(([s, posBody, logBody]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSettings(s);
        setDraft((d) => ({ ...d, ...s }));
        setPositions({ active: posBody.active ?? [], closed: posBody.closed ?? [] });
        setLogEntries(logBody.entries ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const saveSettings = () => {
    setSaving(true);
    const body = { entry_mode: draft.entry_mode, stop_loss_mode: draft.stop_loss_mode };
    for (const group of NUMERIC_GROUPS) {
      for (const f of group.fields) {
        const n = Number(draft[f.key]);
        body[f.key] = Number.isFinite(n) ? n : DEFAULT_DRAFT[f.key];
      }
    }
    for (const key of ["slope_filter_lookback_bars", "slope_filter_threshold_sigma", "trend_filter_ema_length", "stop_loss_percent", "stop_loss_sigma_buffer"]) {
      const n = Number(draft[key]);
      body[key] = Number.isFinite(n) ? n : DEFAULT_DRAFT[key];
    }
    for (const key of ["slope_filter_enabled", "trend_filter_enabled", "stop_loss_enabled"]) {
      body[key] = Boolean(draft[key]);
    }
    fetch("/api/options-autotrade?resource=vwap-scalper-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((s) => { if (!s.error) { setSettings(s); setDraft((d) => ({ ...d, ...s })); } })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const toggleEnabled = (enabled) => {
    setSaving(true);
    fetch("/api/options-autotrade?resource=vwap-scalper-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_mode: enabled ? "PAPER" : "OFF" }),
    })
      .then((r) => r.json())
      .then((s) => { if (!s.error) setSettings(s); })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const triggerKillSwitch = () => {
    const activeCount = positions.active.length;
    const confirmed = window.confirm(
      `This stops new paper entries (execution_mode -> OFF).${activeCount > 0 ? ` ${activeCount} open paper position(s) remain open — vwap-scalper-monitor keeps evaluating target/stop independently on its own cron.` : ""} Continue?`,
    );
    if (!confirmed) return;
    setKillSwitchBusy(true);
    setKillSwitchResult(null);
    fetch("/api/options-autotrade?resource=vwap-scalper-kill-switch", { method: "POST" })
      .then((r) => r.json())
      .then((result) => { setKillSwitchResult(result); return load(); })
      .catch((e) => setKillSwitchResult({ ok: false, message: e.message }))
      .finally(() => setKillSwitchBusy(false));
  };

  const timeline = logEntries.map((e) => ({ time: e.created_at, level: e.level, message: e.message })).slice(0, 30);

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <ChartLineUp size={16} weight="bold" className="text-accent" />
          <h1 className="text-[16px] font-bold">VWAP 3σ Scalper</h1>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px]"
            style={{ background: settings?.execution_mode === "PAPER" ? "var(--c-gain-soft, #16a34a22)" : "var(--c-surface-2)", color: settings?.execution_mode === "PAPER" ? "var(--c-gain)" : "var(--c-faint)" }}
          >
            {settings?.execution_mode ?? "…"}
          </span>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px]" style={{ background: "var(--c-surface-2)", color: "var(--c-faint)" }}>NSE</span>
        </div>
        <button
          onClick={triggerKillSwitch} disabled={killSwitchBusy}
          className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-[8px]"
          style={{ background: "var(--c-loss-soft, #dc262622)", color: "var(--c-loss)", border: "1px solid var(--c-loss)" }}
          title="Stops new paper entries — does not close open positions"
        >
          <HandPalm size={13} weight="bold" />
          {killSwitchBusy ? "Stopping…" : "Kill Switch"}
        </button>
      </div>
      <p className="text-[11px] text-muted mb-3 max-w-[80ch]">
        Session-VWAP mean reversion scalp across the NIFTY 50: touch/rejection entries at the 3σ band, targeting a return to
        VWAP, with an optional stop-loss. Runs on its own 1-minute cron against live Kite 1-min bars — this page only displays
        the result, it doesn't trigger a scan. PAPER mode only: no real order is ever placed. Nasdaq is a separate, not-yet-built
        strategy (needs an Alpaca integration).
      </p>

      {killSwitchResult && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <HandPalm size={15} weight="bold" className="shrink-0 mt-px text-loss" />
          <div className="text-[12px] flex-1">{killSwitchResult.ok === false ? `Kill switch failed: ${killSwitchResult.message}` : killSwitchResult.message}</div>
          <button onClick={() => setKillSwitchResult(null)} className="text-[11px] text-muted shrink-0">Dismiss</button>
        </div>
      )}

      <div className="rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <button onClick={() => setSettingsOpen((v) => !v)} className="w-full flex items-center gap-3 flex-wrap p-3 text-left">
          <Wallet size={15} weight="bold" className="text-muted shrink-0" />
          <span className="text-[11.5px] font-semibold">Paper Execution</span>
          <span className="text-[10.5px] text-faint">Account equity {inr(settings?.account_equity ?? 0)}</span>
          <span className="text-[10.5px] text-faint flex-1">
            {settings?.execution_mode === "PAPER" ? "Fresh touch/rejection signals auto-open sized paper positions." : "Scans still run and log a decision, but no paper positions are opened."}
          </span>
          {settingsOpen ? <CaretUp size={14} className="text-muted shrink-0" /> : <CaretDown size={14} className="text-muted shrink-0" />}
          <Gear size={14} weight="bold" className="text-muted shrink-0" />
        </button>

        {settingsOpen && (
          <div className="px-3 pb-3 pt-1" style={{ borderTop: "1px solid var(--c-line)" }}>
            <div className="flex items-center gap-4 flex-wrap py-2.5">
              <label className="flex items-center gap-1.5 text-[11.5px]">
                <input type="checkbox" checked={settings?.execution_mode === "PAPER"} onChange={(e) => toggleEnabled(e.target.checked)} disabled={saving} />
                Enabled (PAPER)
              </label>
              <span className="text-[10.5px] text-faint px-2 py-1 rounded-[6px]" style={{ background: "var(--c-surface-2)" }}>
                Mode: PAPER only — ALERT_ONLY/SEMI_AUTO/AUTO aren't built yet
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {NUMERIC_GROUPS.map((group) => (
                <div key={group.title} className="p-2.5 rounded-[10px]" style={{ background: "var(--c-surface-2)" }}>
                  <div className="text-[10.5px] font-semibold text-muted mb-1.5">{group.title}</div>
                  <div className="flex flex-col gap-1.5">
                    {group.fields.map((f) => (
                      <label key={f.key} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-ink2">{f.label}</span>
                        <input
                          type="number" step={f.step} min={f.min} max={f.max}
                          value={draft[f.key] ?? ""}
                          onChange={(e) => setField(f.key, e.target.value)}
                          className="w-[76px] px-1.5 py-0.5 rounded-[6px] n text-[11px] text-right"
                          style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              <div className="p-2.5 rounded-[10px]" style={{ background: "var(--c-surface-2)" }}>
                <div className="text-[10.5px] font-semibold text-muted mb-1.5">Entry Mode</div>
                <select
                  value={draft.entry_mode} onChange={(e) => setField("entry_mode", e.target.value)}
                  className="w-full px-1.5 py-1 rounded-[6px] text-[11px]"
                  style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
                >
                  <option value="REJECTION">Rejection (conservative, confirmed candle)</option>
                  <option value="TOUCH">Touch (fires on intrabar touch)</option>
                </select>
              </div>

              <div className="p-2.5 rounded-[10px]" style={{ background: "var(--c-surface-2)" }}>
                <div className="text-[10.5px] font-semibold text-muted mb-1.5">Filters (off by default)</div>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink2">VWAP slope filter</span>
                    <input type="checkbox" checked={!!draft.slope_filter_enabled} onChange={(e) => setField("slope_filter_enabled", e.target.checked)} />
                  </label>
                  <label className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink2">EMA trend filter</span>
                    <input type="checkbox" checked={!!draft.trend_filter_enabled} onChange={(e) => setField("trend_filter_enabled", e.target.checked)} />
                  </label>
                </div>
              </div>

              <div className="p-2.5 rounded-[10px]" style={{ background: "var(--c-surface-2)" }}>
                <div className="text-[10.5px] font-semibold text-muted mb-1.5">Stop Loss (off by default)</div>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink2">Enabled</span>
                    <input type="checkbox" checked={!!draft.stop_loss_enabled} onChange={(e) => setField("stop_loss_enabled", e.target.checked)} />
                  </label>
                  <label className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink2">Mode</span>
                    <select
                      value={draft.stop_loss_mode} onChange={(e) => setField("stop_loss_mode", e.target.value)}
                      className="px-1 py-0.5 rounded-[6px] text-[11px]"
                      style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
                    >
                      <option value="BEYOND_3SIGMA">Beyond 3σ</option>
                      <option value="PERCENTAGE">Percentage</option>
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink2">Stop %</span>
                    <input type="number" step={0.05} min={0.01} value={draft.stop_loss_percent ?? ""} onChange={(e) => setField("stop_loss_percent", e.target.value)}
                      className="w-[70px] px-1.5 py-0.5 rounded-[6px] n text-[11px] text-right" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }} />
                  </label>
                  <label className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink2">σ buffer</span>
                    <input type="number" step={0.1} min={0} value={draft.stop_loss_sigma_buffer ?? ""} onChange={(e) => setField("stop_loss_sigma_buffer", e.target.value)}
                      className="w-[70px] px-1.5 py-0.5 rounded-[6px] n text-[11px] text-right" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }} />
                  </label>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 mt-3">
              <button onClick={saveSettings} disabled={saving} className="topstep text-[11.5px]">{saving ? "Saving…" : "Save Settings"}</button>
              <span className="text-[10.5px] text-faint">Last saved values are pre-filled above — unsaved edits are only local until you click Save. Sizing needs Stop Loss enabled (a signal can't be sized without a real stop).</span>
            </div>
          </div>
        )}
      </div>

      <VwapScalperChart activeSymbols={positions.active.map((p) => p.symbol)} />

      {loading ? (
        <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12.5px] text-ink2">{error}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-4">
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Open Positions</div>
              <div className="text-[14px] font-bold n">{positions.active.length} <span className="text-faint font-normal text-[11px]">/ {settings?.max_open_positions ?? "—"} max</span></div>
            </div>
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Unrealized P&L</div>
              <div className="text-[14px] font-bold n">{inr(positions.active.reduce((s, p) => s + (Number(p.unrealized_pnl) || 0), 0))}</div>
            </div>
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Universe</div>
              <div className="text-[14px] font-bold n">NIFTY 50</div>
            </div>
          </div>

          <h2 className="text-[13px] font-bold mb-2">Paper Positions {positions.active.length > 0 ? <span className="font-normal text-muted">({positions.active.length} open)</span> : null}</h2>
          {positions.active.length === 0 && positions.closed.length === 0 ? (
            <p className="text-[12.5px] text-muted py-6 text-center">No paper positions yet — the 1-minute scan opens one automatically once a fresh touch/rejection signal clears sizing.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-3 pr-2">Symbol</th>
                    <th className="font-medium py-2 pr-2">Direction</th>
                    <th className="font-medium py-2 pr-2 text-right">Qty</th>
                    <th className="font-medium py-2 pr-2 text-right">Entry</th>
                    <th className="font-medium py-2 pr-2 text-right">VWAP @ Entry</th>
                    <th className="font-medium py-2 pr-2 text-right">Stop</th>
                    <th className="font-medium py-2 pr-2">Status</th>
                    <th className="font-medium py-2 pr-2 text-right">Unrealized P&L</th>
                    <th className="font-medium py-2 pr-3 text-right">Realized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...positions.active, ...positions.closed].map((p) => <PositionRow key={p.id} p={p} />)}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="text-[13px] font-bold mt-5 mb-2">Activity Log</h2>
          {timeline.length === 0 ? (
            <p className="text-[12.5px] text-muted py-6 text-center">No activity yet.</p>
          ) : (
            <div className="rounded-[14px] overflow-hidden" style={{ border: "1px solid var(--c-line)" }}>
              {timeline.map((e, i) => {
                const isError = e.level === "error";
                return (
                  <div
                    key={i}
                    className="flex items-start gap-2.5 px-3 py-2"
                    style={{ borderTop: i > 0 ? "1px solid var(--c-line)" : "none", background: "var(--c-surface)" }}
                  >
                    {isError ? <Info size={13} weight="bold" className="shrink-0 mt-px text-loss" /> : <Bell size={13} weight="bold" className="shrink-0 mt-px text-muted" />}
                    <span className="text-[11px] text-faint n shrink-0 w-[62px]">{new Date(e.time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className={`text-[11.5px] ${isError ? "text-loss" : "text-ink2"}`}>{e.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
