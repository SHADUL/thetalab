import { useState, useEffect, useCallback, useRef } from "react";
import { Lightning, Info, Wallet, Gear, CaretDown, CaretUp, HandPalm } from "@phosphor-icons/react";
import { inr, pctSigned, toneClass } from "./swingFormat.js";
import { ScoreBadge } from "./ScoreWidgets.jsx";
import { kiteLoginUrl, assumedKiteConnected, consumeKiteRedirectResult } from "../lib/kiteClient.js";

const POLL_MS = 20_000; // browser-driven "continuous" scan — see api/intraday.js's header comment on why

const REGIME_TONE = {
  STRONG_BULLISH: "gain", BULLISH: "gain", NEUTRAL: "muted", BEARISH: "loss", STRONG_BEARISH: "loss",
};
const REGIME_LABEL = {
  STRONG_BULLISH: "Strong Bullish", BULLISH: "Bullish", NEUTRAL: "Neutral", BEARISH: "Bearish", STRONG_BEARISH: "Strong Bearish",
};

const SIGNAL_TONE = { SIGNAL_CONFIRMED: "gain", FORMING: "muted", WATCH: "muted" };
const SIGNAL_LABEL = { SIGNAL_CONFIRMED: "Confirmed", FORMING: "Forming", WATCH: "Watch" };
const SETUP_LABEL = {
  ORB: "ORB", VWAP_PULLBACK: "VWAP Pullback", EMA_TREND_CONTINUATION: "Trend Continuation",
  BREAKOUT: "Breakout", BREAKOUT_RETEST: "Breakout Retest",
};

const POSITION_STATUS_TONE = { OPEN: "muted", CLOSED: "muted" };

const DEFAULT_DRAFT = {
  enabled: false, capital: 0, risk_pct_per_trade: 0.5, max_capital_pct_per_trade: 20,
  max_daily_loss_pct: 2, max_trades_per_day: 5, max_consecutive_losses: 3,
  max_open_positions: 3, max_positions_per_sector: 1, min_score: 70, min_risk_reward: 1.5,
  min_rvol: 1.0, max_extension_atr: 2.5, square_off_time: "15:15",
};

// Every field here is wired to real gating logic in api/intraday.js — no
// dead knobs. auto_execute_min_score exists in the schema for a future
// AUTO execution mode but isn't exposed here since nothing reads it yet.
const SETTINGS_GROUPS = [
  {
    title: "Position Sizing", fields: [
      { key: "capital", label: "Capital (₹)", step: 1000, min: 0 },
      { key: "risk_pct_per_trade", label: "Risk % per trade", step: 0.1, min: 0 },
      { key: "max_capital_pct_per_trade", label: "Max capital % per trade", step: 1, min: 0 },
    ],
  },
  {
    title: "Daily Risk Limits", fields: [
      { key: "max_daily_loss_pct", label: "Max daily loss %", step: 0.1, min: 0 },
      { key: "max_trades_per_day", label: "Max trades / day", step: 1, min: 1 },
      { key: "max_consecutive_losses", label: "Max consecutive losses", step: 1, min: 1 },
    ],
  },
  {
    title: "Position Limits", fields: [
      { key: "max_open_positions", label: "Max open positions", step: 1, min: 1 },
      { key: "max_positions_per_sector", label: "Max positions / sector", step: 1, min: 1 },
    ],
  },
  {
    title: "Signal Quality Gates", fields: [
      { key: "min_score", label: "Min score to confirm", step: 1, min: 0, max: 100 },
      { key: "min_risk_reward", label: "Min risk:reward", step: 0.1, min: 0 },
      { key: "min_rvol", label: "Min RVOL", step: 0.1, min: 0 },
      { key: "max_extension_atr", label: "Max extension (× ATR)", step: 0.1, min: 0 },
    ],
  },
];

/**
 * Intraday Trader — Market Regime + Stock Ranking + Setup/Signal Engine +
 * Execution Engine (paper mode). Ranking runs on the full liquid universe
 * from quote snapshots; the top ~12 ranked candidates then get today's
 * 5-min candle history fetched for real setup detection (all 5 ensemble
 * setups) and the 12-point entry checklist. When paper execution is
 * enabled below, a "Confirmed" signal is sized by the Risk Engine and
 * opened as a paper position automatically — no real orders are placed.
 * Every scan tick, open positions are also managed: exited on stop,
 * target2, EOD square-off, or a momentum-failure check, with the stop
 * trailed to breakeven once target1 is reached.
 */
export default function IntradayTrader() {
  const [data, setData] = useState(null);
  const [positions, setPositions] = useState({ open: [], closed: [] });
  const [settings, setSettings] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(DEFAULT_DRAFT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kiteConnected, setKiteConnected] = useState(() => assumedKiteConnected());
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
  const [killSwitchResult, setKillSwitchResult] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    const r = consumeKiteRedirectResult();
    if (r) setKiteConnected(r.connected);
  }, []);

  useEffect(() => {
    fetch("/api/intraday?resource=settings")
      .then((r) => r.json())
      .then((s) => {
        if (!s || s.error) return;
        setSettings(s);
        setSettingsDraft((d) => ({ ...d, ...s, enabled: !!s.enabled }));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/intraday?resource=scan").then((r) => r.json()),
      fetch("/api/intraday?resource=positions").then((r) => r.json()),
    ])
      .then(([scanBody, posBody]) => {
        if (scanBody.error) { setError(scanBody.message || scanBody.error); setData(null); return; }
        setError(null);
        setData(scanBody);
        setPositions({ open: posBody.open ?? [], closed: posBody.closed ?? [] });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const setField = (key, value) => setSettingsDraft((d) => ({ ...d, [key]: value }));

  const saveSettings = () => {
    setSavingSettings(true);
    const numericKeys = SETTINGS_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
    const body = { enabled: !!settingsDraft.enabled, execution_mode: "PAPER", square_off_time: settingsDraft.square_off_time || "15:15" };
    for (const key of numericKeys) {
      const n = Number(settingsDraft[key]);
      body[key] = Number.isFinite(n) ? n : DEFAULT_DRAFT[key];
    }
    fetch("/api/intraday?resource=settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then(() => fetch("/api/intraday?resource=settings").then((r) => r.json()))
      .then((s) => { setSettings(s); setSettingsDraft((d) => ({ ...d, ...s, enabled: !!s.enabled })); })
      .catch(() => {})
      .finally(() => setSavingSettings(false));
  };

  const triggerKillSwitch = () => {
    const openCount = positions.open.length;
    const confirmed = window.confirm(
      openCount > 0
        ? `This disables Paper Execution and immediately closes all ${openCount} open position(s) at the current market price, regardless of stop/target. Continue?`
        : "This disables Paper Execution. There are no open positions to close right now. Continue?",
    );
    if (!confirmed) return;
    setKillSwitchBusy(true);
    setKillSwitchResult(null);
    fetch("/api/intraday?resource=kill-switch", { method: "POST" })
      .then((r) => r.json())
      .then((result) => {
        setKillSwitchResult(result);
        setSettingsDraft((d) => ({ ...d, enabled: false }));
        return Promise.all([
          fetch("/api/intraday?resource=settings").then((r) => r.json()),
          fetch("/api/intraday?resource=positions").then((r) => r.json()),
        ]);
      })
      .then(([s, posBody]) => {
        if (s && !s.error) setSettings(s);
        setPositions({ open: posBody.open ?? [], closed: posBody.closed ?? [] });
      })
      .catch((e) => setKillSwitchResult({ ok: false, message: e.message }))
      .finally(() => setKillSwitchBusy(false));
  };

  const regime = data?.regime;
  const candidates = data?.candidates ?? [];
  const priceBySymbol = new Map(candidates.map((c) => [c.symbol, c.price]));

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Lightning size={16} weight="bold" className="text-accent" />
          <h1 className="text-[16px] font-bold">Intraday Trader</h1>
          {data?.asOf && <span className="text-[11px] text-muted">as of {new Date(data.asOf).toLocaleTimeString("en-IN")}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerKillSwitch} disabled={killSwitchBusy}
            className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-[8px]"
            style={{ background: "var(--c-loss-soft, #dc262622)", color: "var(--c-loss)", border: "1px solid var(--c-loss)" }}
            title="Disable Paper Execution and immediately close every open position at market price"
          >
            <HandPalm size={13} weight="bold" />
            {killSwitchBusy ? "Squaring off…" : "Kill Switch"}
          </button>
          {!kiteConnected && (
            <a href={kiteLoginUrl()} className="topstep">Connect Kite</a>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted mb-3 max-w-[75ch]">
        Live market regime + a liquid-universe ranking, refreshed every 20s while this tab is open. The top-ranked candidates
        also get real setup detection (ORB / VWAP Pullback / Trend Continuation / Breakout / Breakout Retest) against today's
        5-min candles — a "Confirmed" signal has passed the full 12-point entry checklist.
      </p>

      {killSwitchResult && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <HandPalm size={15} weight="bold" className="shrink-0 mt-px text-loss" />
          <div className="text-[12px] flex-1">
            {killSwitchResult.ok === false ? (
              <span>Kill switch failed: {killSwitchResult.message}</span>
            ) : (
              <span>
                Paper Execution disabled.{" "}
                {killSwitchResult.closed?.length > 0 && `Closed ${killSwitchResult.closed.length} position(s) at market: ${killSwitchResult.closed.map((c) => `${c.symbol} (${c.pnl >= 0 ? "+" : ""}${inr(c.pnl)})`).join(", ")}. `}
                {killSwitchResult.stillOpen?.length > 0 && `Could not close: ${killSwitchResult.stillOpen.join(", ")} — check Kite connection and retry.`}
                {(!killSwitchResult.closed || killSwitchResult.closed.length === 0) && (!killSwitchResult.stillOpen || killSwitchResult.stillOpen.length === 0) && "No open positions."}
                {killSwitchResult.message && ` ${killSwitchResult.message}`}
              </span>
            )}
          </div>
          <button onClick={() => setKillSwitchResult(null)} className="text-[11px] text-muted shrink-0">Dismiss</button>
        </div>
      )}

      <div className="rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="w-full flex items-center gap-3 flex-wrap p-3 text-left"
        >
          <Wallet size={15} weight="bold" className="text-muted shrink-0" />
          <span className="text-[11.5px] font-semibold">Paper Execution</span>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px]"
            style={{ background: settings?.enabled ? "var(--c-gain-soft, #16a34a22)" : "var(--c-surface-2)", color: settings?.enabled ? "var(--c-gain)" : "var(--c-faint)" }}
          >
            {settings?.enabled ? "ON" : "OFF"}
          </span>
          <span className="text-[10.5px] text-faint">Capital {inr(settings?.capital ?? 0)}</span>
          <span className="text-[10.5px] text-faint flex-1">
            {settings?.enabled ? "Confirmed signals auto-open paper positions." : "Signals are shown but no paper positions are opened."}
          </span>
          {settingsOpen ? <CaretUp size={14} className="text-muted shrink-0" /> : <CaretDown size={14} className="text-muted shrink-0" />}
          <Gear size={14} weight="bold" className="text-muted shrink-0" />
        </button>

        {settingsOpen && (
          <div className="px-3 pb-3 pt-1" style={{ borderTop: "1px solid var(--c-line)" }}>
            <div className="flex items-center gap-4 flex-wrap py-2.5">
              <label className="flex items-center gap-1.5 text-[11.5px]">
                <input type="checkbox" checked={!!settingsDraft.enabled} onChange={(e) => setField("enabled", e.target.checked)} />
                Enabled
              </label>
              <label className="flex items-center gap-1.5 text-[11.5px]">
                Square-off (IST)
                <input
                  type="time" value={settingsDraft.square_off_time ?? "15:15"}
                  onChange={(e) => setField("square_off_time", e.target.value)}
                  className="px-2 py-1 rounded-[8px] n text-[11.5px]"
                  style={{ border: "1px solid var(--c-line)", background: "var(--c-surface-2)" }}
                />
              </label>
              <span className="text-[10.5px] text-faint px-2 py-1 rounded-[6px]" style={{ background: "var(--c-surface-2)" }}>
                Mode: PAPER only — ALERT/SEMI_AUTO/AUTO aren't built yet
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {SETTINGS_GROUPS.map((group) => (
                <div key={group.title} className="p-2.5 rounded-[10px]" style={{ background: "var(--c-surface-2)" }}>
                  <div className="text-[10.5px] font-semibold text-muted mb-1.5">{group.title}</div>
                  <div className="flex flex-col gap-1.5">
                    {group.fields.map((f) => (
                      <label key={f.key} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-ink2">{f.label}</span>
                        <input
                          type="number" step={f.step} min={f.min} max={f.max}
                          value={settingsDraft[f.key] ?? ""}
                          onChange={(e) => setField(f.key, e.target.value)}
                          className="w-[72px] px-1.5 py-0.5 rounded-[6px] n text-[11px] text-right"
                          style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2.5 mt-3">
              <button onClick={saveSettings} disabled={savingSettings} className="topstep text-[11.5px]">{savingSettings ? "Saving…" : "Save Settings"}</button>
              {settings && (
                <span className="text-[10.5px] text-faint">Last saved values are pre-filled above — unsaved edits are only local until you click Save.</span>
              )}
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
          {regime && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-4">
              <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
                <div className="text-[11px] text-muted mb-0.5">Market Regime</div>
                <div className={`text-[14px] font-bold ${toneClass(REGIME_TONE[regime.regime])}`}>{REGIME_LABEL[regime.regime]}</div>
              </div>
              <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
                <div className="text-[11px] text-muted mb-0.5">NIFTY 50</div>
                <div className={`text-[14px] font-bold n ${regime.niftyReturnPct >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(regime.niftyReturnPct)}</div>
                <div className="text-[10.5px] text-faint">{regime.niftyAboveVwap ? "Above VWAP" : "Below VWAP"}</div>
              </div>
              <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
                <div className="text-[11px] text-muted mb-0.5">BANK NIFTY</div>
                <div className={`text-[14px] font-bold n ${regime.bankNiftyReturnPct >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(regime.bankNiftyReturnPct)}</div>
                <div className="text-[10.5px] text-faint">{regime.bankNiftyAboveVwap ? "Above VWAP" : "Below VWAP"}</div>
              </div>
            </div>
          )}

          <h2 className="text-[13px] font-bold mb-2">Top Intraday Candidates {data?.universeSize ? <span className="font-normal text-muted">({data.universeSize} liquid stocks scanned)</span> : null}</h2>
          {candidates.length === 0 ? (
            <p className="text-[12.5px] text-muted py-10 text-center">No candidates yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-3 pr-2">#</th>
                    <th className="font-medium py-2 pr-2">Stock</th>
                    <th className="font-medium py-2 pr-2">Score</th>
                    <th className="font-medium py-2 pr-2">Direction</th>
                    <th className="font-medium py-2 pr-2 text-right">Price</th>
                    <th className="font-medium py-2 pr-2 text-right">Change</th>
                    <th className="font-medium py-2 pr-2">VWAP</th>
                    <th className="font-medium py-2 pr-2 text-right">RVOL</th>
                    <th className="font-medium py-2 pr-2">Setup</th>
                    <th className="font-medium py-2 pr-3">Signal / Plan</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c, i) => {
                    const s = c.signal;
                    return (
                    <tr key={c.symbol} style={{ borderTop: "1px solid var(--c-line)", background: s?.status === "SIGNAL_CONFIRMED" ? "var(--c-gain-soft, transparent)" : undefined }}>
                      <td className="py-2 pl-3 pr-2 text-muted n">{i + 1}</td>
                      <td className="py-2 pr-2">
                        <div className="font-semibold">{c.symbol}</div>
                        <div className="text-[10.5px] text-faint">{c.sector ?? "—"}</div>
                      </td>
                      <td className="py-2 pr-2"><ScoreBadge score={s?.score ?? c.rankScore} /></td>
                      <td className={`py-2 pr-2 text-[11px] font-medium ${c.direction === "LONG" ? "text-gain" : "text-loss"}`}>{c.direction}</td>
                      <td className="py-2 pr-2 text-right n">{inr(c.price)}</td>
                      <td className={`py-2 pr-2 text-right n ${c.returnPct >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(c.returnPct)}</td>
                      <td className={`py-2 pr-2 text-[11px] ${c.aboveVwap ? "text-gain" : "text-loss"}`}>{c.aboveVwap ? "Above" : "Below"}</td>
                      <td className="py-2 pr-2 text-right n">{c.rvol != null ? `${c.rvol.toFixed(1)}×` : "—"}</td>
                      <td className="py-2 pr-2 text-[11px]">{s?.setupType ? SETUP_LABEL[s.setupType] ?? s.setupType : "—"}</td>
                      <td className="py-2 pr-3 text-[11px]">
                        {s ? (
                          <div>
                            <span className={`font-semibold ${toneClass(SIGNAL_TONE[s.status])}`}>{SIGNAL_LABEL[s.status] ?? s.status}</span>
                            {s.confidence && <span className="text-faint"> · {s.confidence.replace("_", "+")}</span>}
                            {s.entry != null && s.stop != null && (
                              <div className="text-[10.5px] text-faint n">
                                E {inr(s.entry)} · SL {inr(s.stop)}{s.target1 != null ? ` · T1 ${inr(s.target1)}` : ""}
                                {s.riskReward != null ? ` · R:R ${s.riskReward.toFixed(1)}` : ""}
                              </div>
                            )}
                            {s.status !== "SIGNAL_CONFIRMED" && s.failures?.length > 0 && (
                              <div className="text-[10px] text-faint" title={s.failures.join(", ")}>
                                Needs: {s.failures.slice(0, 2).join(", ")}{s.failures.length > 2 ? "…" : ""}
                              </div>
                            )}
                          </div>
                        ) : "—"}
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="text-[13px] font-bold mt-5 mb-2">Paper Positions {positions.open.length > 0 ? <span className="font-normal text-muted">({positions.open.length} open)</span> : null}</h2>
          {positions.open.length === 0 && positions.closed.length === 0 ? (
            <p className="text-[12.5px] text-muted py-6 text-center">No paper positions yet — enable Paper Execution above to auto-open one when a signal confirms.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-3 pr-2">Stock</th>
                    <th className="font-medium py-2 pr-2">Setup</th>
                    <th className="font-medium py-2 pr-2">Direction</th>
                    <th className="font-medium py-2 pr-2 text-right">Entry</th>
                    <th className="font-medium py-2 pr-2 text-right">Stop</th>
                    <th className="font-medium py-2 pr-2 text-right">Target 1</th>
                    <th className="font-medium py-2 pr-2 text-right">Shares</th>
                    <th className="font-medium py-2 pr-2">Status</th>
                    <th className="font-medium py-2 pr-3 text-right">Unrealized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...positions.open, ...positions.closed].map((p) => {
                    const livePrice = p.status === "OPEN" ? priceBySymbol.get(p.symbol) : null;
                    const unrealized = livePrice != null
                      ? (p.direction === "LONG" ? livePrice - p.entry_price : p.entry_price - livePrice) * p.shares
                      : p.pnl;
                    return (
                      <tr key={p.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                        <td className="py-2 pl-3 pr-2">
                          <div className="font-semibold">{p.symbol}</div>
                          <div className="text-[10.5px] text-faint">{p.sector ?? "—"}</div>
                        </td>
                        <td className="py-2 pr-2 text-[11px]">{SETUP_LABEL[p.setup_type] ?? p.setup_type ?? "—"}</td>
                        <td className={`py-2 pr-2 text-[11px] font-medium ${p.direction === "LONG" ? "text-gain" : "text-loss"}`}>{p.direction}</td>
                        <td className="py-2 pr-2 text-right n">{inr(p.entry_price)}</td>
                        <td className="py-2 pr-2 text-right n">{p.stop != null ? inr(p.stop) : "—"}</td>
                        <td className="py-2 pr-2 text-right n">{p.target1 != null ? inr(p.target1) : "—"}</td>
                        <td className="py-2 pr-2 text-right n">{p.shares}</td>
                        <td className={`py-2 pr-2 text-[11px] ${toneClass(POSITION_STATUS_TONE[p.status])}`}>{p.status}{p.exit_reason ? ` · ${p.exit_reason}` : ""}</td>
                        <td className={`py-2 pr-3 text-right n ${unrealized == null ? "" : unrealized >= 0 ? "text-gain" : "text-loss"}`}>
                          {unrealized != null ? inr(unrealized) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
