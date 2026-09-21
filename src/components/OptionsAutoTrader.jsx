import { useState, useEffect, useCallback, useRef } from "react";
import { ChartLineUp, Info, Wallet, Gear, CaretDown, CaretUp, HandPalm, Bell } from "@phosphor-icons/react";
import { inr, toneClass } from "./swingFormat.js";
import { ScoreBadge } from "./ScoreWidgets.jsx";

const POLL_MS = 60_000; // this dashboard only reads already-computed state (settings/positions/log) — the live chain fetch itself runs on its own 30-min cron, not on this poll

const STATUS_TONE = { ACTIVE: "muted", CLOSED: "muted", FAILED: "loss" };

const EDITABLE_GROUPS = [
  {
    title: "Capital & Trade Risk", fields: [
      { key: "reserved_fund", label: "Reserved fund (₹)", step: 1000, min: 0 },
      { key: "max_risk_per_trade_pct", label: "Max risk / trade %", step: 0.1, min: 0 },
      { key: "max_positions", label: "Max open positions", step: 1, min: 1 },
    ],
  },
  {
    title: "Loss Limits", fields: [
      { key: "max_daily_loss_pct", label: "Max daily loss %", step: 0.1, min: 0 },
      { key: "max_weekly_loss_pct", label: "Max weekly loss %", step: 0.1, min: 0 },
      { key: "max_portfolio_risk_pct", label: "Max portfolio risk %", step: 0.1, min: 0 },
      { key: "max_consecutive_losses", label: "Max consecutive losses", step: 1, min: 1 },
    ],
  },
  {
    title: "Margin & Greeks", fields: [
      { key: "max_margin_utilization_pct", label: "Max margin utilization %", step: 1, min: 0 },
      { key: "max_underlying_delta", label: "Max underlying delta", step: 10, min: 0 },
      { key: "max_gamma", label: "Max portfolio gamma", step: 1, min: 0 },
      { key: "max_vega", label: "Max portfolio vega", step: 100, min: 0 },
      { key: "max_correlated_group_risk_pct", label: "Max correlated-group risk %", step: 0.1, min: 0 },
    ],
  },
  {
    title: "Trade Quality Thresholds", fields: [
      { key: "no_trade_below", label: "NO TRADE below", step: 1, min: 0, max: 100 },
      { key: "watch_below", label: "WATCH below", step: 1, min: 0, max: 100 },
      { key: "high_conviction_at_or_above", label: "HIGH CONVICTION at/above", step: 1, min: 0, max: 100 },
    ],
  },
  {
    title: "Expiry Window", fields: [
      { key: "min_dte", label: "Min DTE", step: 1, min: 0 },
      { key: "max_dte", label: "Max DTE", step: 1, min: 1 },
    ],
  },
  {
    title: "Exit Engine", fields: [
      { key: "profit_target_pct", label: "Profit target %", step: 1, min: 0, max: 100 },
      { key: "stop_loss_credit_multiple", label: "Stop loss (× credit)", step: 0.1, min: 1 },
      { key: "time_exit_dte", label: "Forced time-exit DTE", step: 1, min: 0 },
      { key: "strike_breach_buffer_pct", label: "Strike breach buffer %", step: 0.1, min: 0 },
    ],
  },
];

const DEFAULT_DRAFT = {
  reserved_fund: 0, max_risk_per_trade_pct: 2, max_daily_loss_pct: 4, max_weekly_loss_pct: 8,
  max_portfolio_risk_pct: 10, max_margin_utilization_pct: 60, max_positions: 5,
  max_underlying_delta: 300, max_gamma: 50, max_vega: 5000, max_correlated_group_risk_pct: 6,
  no_trade_below: 70, watch_below: 80, high_conviction_at_or_above: 90, min_dte: 2, max_dte: 60,
  profit_target_pct: 50, stop_loss_credit_multiple: 2, time_exit_dte: 2, strike_breach_buffer_pct: 0,
  max_consecutive_losses: 3,
};

function PositionRow({ p }) {
  const [expanded, setExpanded] = useState(false);
  const legs = p.options_autotrade_legs ?? [];
  return (
    <>
      <tr style={{ borderTop: "1px solid var(--c-line)" }}>
        <td className="py-2 pl-3 pr-2">
          <button onClick={() => setExpanded((v) => !v)} className="font-semibold flex items-center gap-1">
            {p.symbol} {expanded ? <CaretUp size={11} /> : <CaretDown size={11} />}
          </button>
          <div className="text-[10.5px] text-faint">{p.strategy_label}</div>
        </td>
        <td className="py-2 pr-2 text-[11px]">{p.expiry}</td>
        <td className="py-2 pr-2 text-right n">{p.lots}</td>
        <td className="py-2 pr-2 text-right n">{inr(p.net_credit)}</td>
        <td className="py-2 pr-2 text-right n text-gain">{inr(p.max_profit)}</td>
        <td className="py-2 pr-2 text-right n text-loss">{inr(p.max_loss)}</td>
        <td className="py-2 pr-2 text-right n">{p.margin_required != null ? inr(p.margin_required) : "—"}</td>
        <td className="py-2 pr-2"><ScoreBadge score={Math.round(p.quality_score ?? 0)} /></td>
        <td className={`py-2 pr-2 text-[11px] ${toneClass(STATUS_TONE[p.status] ?? "muted")}`}>{p.status}{p.exit_reason ? ` · ${p.exit_reason}` : ""}</td>
        <td className={`py-2 pr-3 text-right n ${p.realized_pnl == null ? "" : p.realized_pnl >= 0 ? "text-gain" : "text-loss"}`}>
          {p.realized_pnl != null ? inr(p.realized_pnl) : "—"}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} className="px-3 pb-3" style={{ background: "var(--c-surface-2)" }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div>
                <div className="text-[10.5px] font-semibold text-muted mb-1">Legs</div>
                <table className="w-full text-[11px]">
                  <tbody>
                    {legs.map((l) => (
                      <tr key={l.id}>
                        <td className="py-0.5 pr-2 font-medium">{l.side}</td>
                        <td className="py-0.5 pr-2">{l.strike}{l.option_right}</td>
                        <td className="py-0.5 pr-2 text-faint n">{l.tradingsymbol}</td>
                        <td className="py-0.5 pr-2 text-right n">{l.quantity}</td>
                        <td className="py-0.5 pr-2 text-right n">{inr(l.fill_price)}</td>
                        <td className="py-0.5 text-[10px] text-faint">{l.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="text-[10.5px] font-semibold text-muted mb-1">Decision Explanation</div>
                <pre className="text-[10.5px] text-ink2 whitespace-pre-wrap font-sans">{p.decision_explanation ?? "—"}</pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Options Auto-Trader — dashboard for the paper-execution orchestrator
 * (api/options-autotrade.ts's paper-scan resource). This UI only reads
 * already-computed state (settings/positions/log) and controls settings —
 * it does NOT trigger a scan itself. Building a live multi-expiry option
 * chain from Kite makes real, possibly many, live API calls per run; that
 * resource is shared-secret protected and driven by its own 30-minute
 * cron (.github/workflows/options-paper-scan.yml), not by this page being
 * open, unlike Intraday Trader's cheap DB-only scan which polls freely.
 */
export default function OptionsAutoTrader() {
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
  const [dailyStats, setDailyStats] = useState(null);
  const [clearingLock, setClearingLock] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/options-autotrade?resource=settings").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=positions").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=log").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=daily-stats").then((r) => r.json()),
    ])
      .then(([s, posBody, logBody, dailyBody]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSettings(s);
        setDraft((d) => ({ ...d, ...s }));
        setPositions({ active: posBody.active ?? [], closed: posBody.closed ?? [] });
        setLogEntries(logBody.entries ?? []);
        setDailyStats(dailyBody);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const clearDailyLock = () => {
    setClearingLock(true);
    fetch("/api/options-autotrade?resource=clear-daily-lock", { method: "POST" })
      .then((r) => r.json())
      .then(() => load())
      .catch(() => {})
      .finally(() => setClearingLock(false));
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const saveSettings = () => {
    setSaving(true);
    const body = {};
    for (const group of EDITABLE_GROUPS) {
      for (const f of group.fields) {
        const n = Number(draft[f.key]);
        body[f.key] = Number.isFinite(n) ? n : DEFAULT_DRAFT[f.key];
      }
    }
    fetch("/api/options-autotrade?resource=settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((s) => { if (!s.error) { setSettings(s); setDraft((d) => ({ ...d, ...s })); } })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const toggleEnabled = (enabled) => {
    setSaving(true);
    fetch("/api/options-autotrade?resource=settings", {
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
      `This stops new paper entries (execution_mode -> OFF).${activeCount > 0 ? ` ${activeCount} open paper position(s) will remain open — there is no exit engine yet to square them off automatically.` : ""} Continue?`,
    );
    if (!confirmed) return;
    setKillSwitchBusy(true);
    setKillSwitchResult(null);
    fetch("/api/options-autotrade?resource=kill-switch", { method: "POST" })
      .then((r) => r.json())
      .then((result) => { setKillSwitchResult(result); return load(); })
      .catch((e) => setKillSwitchResult({ ok: false, message: e.message }))
      .finally(() => setKillSwitchBusy(false));
  };

  const timeline = [
    ...logEntries.map((e) => ({ time: e.created_at, level: e.level, message: e.message })),
  ].slice(0, 30);

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <ChartLineUp size={16} weight="bold" className="text-accent" />
          <h1 className="text-[16px] font-bold">Options Auto-Trader</h1>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px]"
            style={{ background: settings?.execution_mode === "PAPER" ? "var(--c-gain-soft, #16a34a22)" : "var(--c-surface-2)", color: settings?.execution_mode === "PAPER" ? "var(--c-gain)" : "var(--c-faint)" }}
          >
            {settings?.execution_mode ?? "…"}
          </span>
        </div>
        <button
          onClick={triggerKillSwitch} disabled={killSwitchBusy}
          className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-[8px]"
          style={{ background: "var(--c-loss-soft, #dc262622)", color: "var(--c-loss)", border: "1px solid var(--c-loss)" }}
          title="Stops new paper entries — cannot close positions, no exit engine exists yet"
        >
          <HandPalm size={13} weight="bold" />
          {killSwitchBusy ? "Stopping…" : "Kill Switch"}
        </button>
      </div>
      <p className="text-[11px] text-muted mb-3 max-w-[80ch]">
        Defined-risk options selling (Iron Condor / Bull Put Spread / Bear Call Spread), decided from a live chain: skew-based
        strategy selection, strike optimization ranked by expected value per unit of risk, expiry selection, and a 0-100 trade
        quality score gate. Runs on its own 30-minute cron against live Kite data — this page only displays the result, it
        doesn't trigger a scan. PAPER mode only: no real order is ever placed.
      </p>

      {killSwitchResult && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <HandPalm size={15} weight="bold" className="shrink-0 mt-px text-loss" />
          <div className="text-[12px] flex-1">{killSwitchResult.ok === false ? `Kill switch failed: ${killSwitchResult.message}` : killSwitchResult.message}</div>
          <button onClick={() => setKillSwitchResult(null)} className="text-[11px] text-muted shrink-0">Dismiss</button>
        </div>
      )}

      {dailyStats?.locked && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[12px] mb-4" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={15} weight="duotone" className="shrink-0 mt-px text-warn" />
          <div className="text-[12px] flex-1 text-ink2">
            <span className="font-semibold">Daily risk lock engaged</span> ({dailyStats.lock_reason}) — new entries are refused for the rest of today.
            Realized P&L today: {inr(dailyStats.realized_pnl ?? 0)}, consecutive losses: {dailyStats.consecutive_losses ?? 0}.
          </div>
          <button onClick={clearDailyLock} disabled={clearingLock} className="topstep text-[11px] shrink-0">
            {clearingLock ? "Clearing…" : "Clear Lock"}
          </button>
        </div>
      )}

      <div className="rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <button onClick={() => setSettingsOpen((v) => !v)} className="w-full flex items-center gap-3 flex-wrap p-3 text-left">
          <Wallet size={15} weight="bold" className="text-muted shrink-0" />
          <span className="text-[11.5px] font-semibold">Paper Execution</span>
          <span className="text-[10.5px] text-faint">Reserved fund {inr(settings?.reserved_fund ?? 0)}</span>
          <span className="text-[10.5px] text-faint flex-1">
            {settings?.execution_mode === "PAPER" ? "Passing candidates auto-open paper positions on the 30-min scan." : "Scans still run and log a decision, but no paper positions are opened."}
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
              {EDITABLE_GROUPS.map((group) => (
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
            </div>

            <div className="flex items-center gap-2.5 mt-3">
              <button onClick={saveSettings} disabled={saving} className="topstep text-[11.5px]">{saving ? "Saving…" : "Save Settings"}</button>
              <span className="text-[10.5px] text-faint">Last saved values are pre-filled above — unsaved edits are only local until you click Save.</span>
            </div>
          </div>
        )}
      </div>

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
              <div className="text-[14px] font-bold n">{positions.active.length} <span className="text-faint font-normal text-[11px]">/ {settings?.max_positions ?? "—"} max</span></div>
            </div>
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Margin Committed</div>
              <div className="text-[14px] font-bold n">{inr(positions.active.reduce((s, p) => s + (Number(p.margin_required) || 0), 0))}</div>
            </div>
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Max Loss at Risk</div>
              <div className={`text-[14px] font-bold n ${positions.active.length ? "text-loss" : ""}`}>{inr(positions.active.reduce((s, p) => s + (Number(p.max_loss) || 0), 0))}</div>
            </div>
          </div>

          <h2 className="text-[13px] font-bold mb-2">Paper Positions {positions.active.length > 0 ? <span className="font-normal text-muted">({positions.active.length} open)</span> : null}</h2>
          {positions.active.length === 0 && positions.closed.length === 0 ? (
            <p className="text-[12.5px] text-muted py-6 text-center">No paper positions yet — the 30-min scan opens one automatically once a candidate clears the quality threshold.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-3 pr-2">Symbol / Strategy</th>
                    <th className="font-medium py-2 pr-2">Expiry</th>
                    <th className="font-medium py-2 pr-2 text-right">Lots</th>
                    <th className="font-medium py-2 pr-2 text-right">Net Credit</th>
                    <th className="font-medium py-2 pr-2 text-right">Max Profit</th>
                    <th className="font-medium py-2 pr-2 text-right">Max Loss</th>
                    <th className="font-medium py-2 pr-2 text-right">Margin</th>
                    <th className="font-medium py-2 pr-2">Score</th>
                    <th className="font-medium py-2 pr-2">Status</th>
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
