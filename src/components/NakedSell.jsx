import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lightning, TrendUp, TrendDown, Minus, Gear, X, Warning, Briefcase, ClockCounterClockwise, ListChecks, ShieldCheck, Target,
} from "@phosphor-icons/react";
import { OAT_VARS, EASE, signed } from "./alphaFormat.js";
import { Card, Pill, Stat, Toggle } from "./alphaUi.jsx";

// Intraday Naked Sell: reads the 5-min intraday trend per index and sells one
// ~0.30-delta option in that direction (bullish → PE, bearish → CE). PAPER +
// SHADOW only — no real orders. The server runs the engine every 20 s; this
// page only reads it and edits settings.

const API = "/api/naked-sell";
const POLL_MS = 10_000;
const POLL_OPEN_MS = 3_000; // faster refresh while positions are open (server checks SL/TP every second)
const REASON = { TP: "Target", SL: "Stop-loss", TREND_FLIP: "Trend flip", SQUARE_OFF: "3:15 square-off", MANUAL: "Manual" };
const REASON_TONE = { TP: "gain", SL: "loss", TREND_FLIP: "warn", SQUARE_OFF: "neutral", MANUAL: "neutral" };
const TREND_TONE = { BULLISH: "gain", BEARISH: "loss", NEUTRAL: "neutral" };
const TREND_ICON = { BULLISH: TrendUp, BEARISH: TrendDown, NEUTRAL: Minus };

const rs = (v, d = 2) => (v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const tone = (v) => (v == null ? undefined : v >= 0 ? "gain" : "loss");
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }) : "—");
const minToClock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

async function post(resource, body) {
  const r = await fetch(`${API}?resource=${resource}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({ error: "bad_response", message: `HTTP ${r.status}` }));
  if (b.error) throw new Error(b.message || b.error);
  return b;
}

function KV({ k, v, t }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] font-semibold text-faint tracking-wide">{k}</span>
      <span className="n text-[12.5px] font-semibold truncate" style={{ color: t === "gain" ? "var(--c-gain)" : t === "loss" ? "var(--c-loss)" : undefined }}>{v}</span>
    </div>
  );
}

function TrendCard({ trends, symbols, nowMs }) {
  const by = Object.fromEntries(trends.map((t) => [t.symbol, t]));
  return (
    <Card title="Intraday trend (5-min)" icon={TrendUp} delay={0.05}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {symbols.map((sym) => {
          const t = by[sym];
          const d = t?.detail ?? {};
          const Icon = TREND_ICON[t?.state] ?? Minus;
          const stale = !t || nowMs - Date.parse(t.updated_at) > 3 * 60_000;
          return (
            <div key={sym} className="rounded-[12px] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-display text-[15px] font-bold">{sym}</span>
                <div className="flex items-center gap-1.5">
                  {stale && <Pill tone="warn">STALE</Pill>}
                  <Pill tone={TREND_TONE[t?.state] ?? "neutral"} icon={Icon}>{t?.state ?? "NO DATA"}</Pill>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 mb-2">
                <KV k="SPOT" v={t?.spot ? Number(t.spot).toLocaleString("en-IN") : "—"} />
                <KV k="SESSION AVG" v={d.sessionAvg?.toLocaleString("en-IN") ?? "—"} />
                <KV k="EMA 9" v={d.ema9?.toLocaleString("en-IN") ?? "—"} />
                <KV k="EMA 21" v={d.ema21?.toLocaleString("en-IN") ?? "—"} />
              </div>
              <div className="text-[11px] text-ink2 leading-snug">
                {t?.state === "BULLISH" ? "→ sells a PE" : t?.state === "BEARISH" ? "→ sells a CE" : "→ no trade"} · {d.reason ?? "waiting for the first scan"}
              </div>
              <div className="text-[10.5px] text-faint mt-1">updated {hhmm(t?.updated_at)} · {d.bars ?? 0} completed bars</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function LevelBar({ p }) {
  // Short premium: lower is better. Bar runs from TP (left, green) to SL (right, red).
  const tp = Number(p.tp_price), sl = Number(p.sl_price), now = Number(p.last_price ?? p.entry_price), entry = Number(p.entry_price);
  const pos = (v) => `${Math.min(100, Math.max(0, ((v - tp) / (sl - tp)) * 100))}%`;
  return (
    <div className="mt-2">
      <div className="relative h-[6px] rounded-full" style={{ background: "linear-gradient(90deg, var(--c-gain-soft), var(--c-surface-3), var(--c-loss-soft))" }}>
        <span className="absolute top-[-3px] w-[2px] h-[12px] rounded" style={{ left: pos(entry), background: "var(--c-muted)" }} title="entry" />
        <motion.span layout className="absolute top-[-4px] w-[14px] h-[14px] rounded-full -ml-[7px]" style={{ left: pos(now), background: now <= entry ? "var(--c-gain)" : "var(--c-loss)", boxShadow: "0 0 0 3px var(--c-surface)" }} />
      </div>
      <div className="flex justify-between text-[10px] text-faint mt-1.5 n">
        <span>TP {rs(tp)}</span><span>entry {rs(entry)}</span><span>SL {rs(sl)}</span>
      </div>
    </div>
  );
}

function OpenCard({ positions, onClose, busyId }) {
  return (
    <Card title={`Open positions (${positions.length})`} icon={Briefcase} delay={0.1}>
      {!positions.length ? (
        <div className="text-[12px] text-ink2">No open positions. The engine sells when an index shows a clear intraday trend between 11:00 and 14:30.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {positions.map((p) => (
            <div key={p.id} className="rounded-[12px] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Pill tone={p.mode === "SHADOW" ? "accent" : "neutral"}>{p.mode}</Pill>
                  {p.live ? <Pill tone="gain">LIVE</Pill> : <Pill tone="warn">DELAYED</Pill>}
                  <span className="font-semibold text-[13px] truncate">SELL {p.lots} × {p.tradingsymbol}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="n font-bold text-[14px]" style={{ color: Number(p.unrealized_pnl) >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{signed(Math.round(Number(p.unrealized_pnl ?? 0)))}</span>
                  <button onClick={() => onClose(p)} disabled={busyId === p.id}
                    className="inline-flex items-center gap-1 rounded-[9px] px-2.5 text-[11.5px] font-semibold"
                    style={{ height: 28, background: "var(--c-loss-soft)", color: "var(--c-loss)", opacity: busyId === p.id ? 0.5 : 1 }}>
                    <X size={12} weight="bold" />Close
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-2.5">
                <KV k="ENTRY" v={rs(p.entry_price)} />
                <KV k="NOW" v={rs(p.last_price)} t={Number(p.last_price) <= Number(p.entry_price) ? "gain" : "loss"} />
                <KV k="QTY" v={p.qty} />
                <KV k="DELTA" v={p.entry_delta ?? "—"} />
                <KV k="PRICED" v={p.last_quoted_at ? new Date(p.last_quoted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" }) : "—"} />
                <KV k="MARGIN" v={p.margin_required ? rs(p.margin_required, 0) : "—"} />
              </div>
              <LevelBar p={p} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HistoryCard({ recent }) {
  return (
    <Card title="Recent trades" icon={ClockCounterClockwise} delay={0.15}>
      {!recent.length ? <div className="text-[12px] text-ink2">No closed trades yet.</div> : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11.5px] n" style={{ minWidth: 560 }}>
            <thead><tr className="text-faint text-[10px] tracking-wide text-left">
              {["DATE", "MODE", "CONTRACT", "ENTRY", "EXIT", "EXIT REASON", "NET P&L"].map((h) => <th key={h} className="px-1 py-1.5 font-semibold">{h}</th>)}
            </tr></thead>
            <tbody>
              {recent.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--oat-hairline)" }}>
                  <td className="px-1 py-1.5 whitespace-nowrap">{day(p.opened_at)} {hhmm(p.opened_at)}</td>
                  <td className="px-1 py-1.5">{p.mode}</td>
                  <td className="px-1 py-1.5 whitespace-nowrap">{p.tradingsymbol}</td>
                  <td className="px-1 py-1.5">{rs(p.entry_price)}</td>
                  <td className="px-1 py-1.5">{rs(p.exit_price)}</td>
                  <td className="px-1 py-1.5"><Pill tone={REASON_TONE[p.exit_reason]}>{REASON[p.exit_reason] ?? p.exit_reason}</Pill></td>
                  <td className="px-1 py-1.5 font-semibold" style={{ color: Number(p.net_pnl) >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{signed(Math.round(Number(p.net_pnl)))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RulesCard({ s }) {
  const rows = [
    ["Trend", "5-min candles: close vs session average + EMA9/EMA21 (at least 0.06% apart) + close vs EMA9. All three must agree. Needs 21 completed bars, so no signal before 11:00."],
    ["Entry", `Bullish → sell PE, bearish → sell CE · ~${s.target_delta} delta · nearest weekly (rolls to next on expiry day) · ${minToClock(Math.max(s.entry_start_min, 660))}–${minToClock(s.entry_end_min)}`],
    ["Take profit", `premium falls ${s.tp_pct}% from entry — same 1-second live check`],
    ["Stop-loss", `premium rises ${s.sl_pct}% from entry — checked every second on live Kite prices (must hold for 2 consecutive seconds)`],
    ["Trend flip", "exit immediately if the trend turns against the position"],
    ["Square-off", `${minToClock(s.square_off_min)} — never held overnight`],
    ["Limits", `${s.max_entries_per_day} entries/day per index · ${s.cooldown_min} min cooldown · stop for the day at −₹${Number(s.max_daily_loss).toLocaleString("en-IN")}`],
    ["SHADOW realism", `fills at bid/ask, skips if spread > ${s.max_spread_pct}% or volume < ${s.min_volume}, needs Kite margin ≤ ₹5L`],
  ];
  return (
    <Card title="Rules" icon={ListChecks} delay={0.2}>
      <div className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[96px_1fr] gap-2 text-[11.5px]"><span className="font-semibold text-ink2">{k}</span><span className="text-ink2">{v}</span></div>
        ))}
      </div>
    </Card>
  );
}

function SettingsCard({ s, onSave, saving }) {
  // Remounted via `key` when saved settings change, so polling never wipes in-progress edits.
  const [form, setForm] = useState(s);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleSym = (sym) => set("symbols", form.symbols.includes(sym) ? form.symbols.filter((x) => x !== sym) : [...form.symbols, sym]);
  const num = (k, label, hint, step = 1) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-ink2">{label}</span>
      <input type="number" step={step} value={form[k]} onChange={(e) => set(k, e.target.value)} className="px-3 py-2 rounded-[10px] n text-[13px] w-full"
        style={{ background: "var(--c-surface)", border: "1px solid var(--c-line)", color: "var(--c-text)" }} />
      {hint && <span className="text-[10.5px] text-faint">{hint}</span>}
    </label>
  );
  const row = (label, on, onClick) => (
    <div className="flex items-center justify-between gap-2 py-1"><span className="text-[12px] font-semibold">{label}</span><Toggle on={on} onClick={onClick} label={label} /></div>
  );
  return (
    <Card title="Settings" icon={Gear} delay={0.25}>
      <div className="flex flex-col gap-1 mb-3">
        {row("Engine on", form.enabled, () => set("enabled", !form.enabled))}
        {row("PAPER", form.paper_enabled, () => set("paper_enabled", !form.paper_enabled))}
        {row("SHADOW", form.shadow_enabled, () => set("shadow_enabled", !form.shadow_enabled))}
        {row("NIFTY", form.symbols.includes("NIFTY"), () => toggleSym("NIFTY"))}
        {row("SENSEX", form.symbols.includes("SENSEX"), () => toggleSym("SENSEX"))}
        {row("Trade on expiry day", form.allow_expiry_day, () => set("allow_expiry_day", !form.allow_expiry_day))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {num("lots", "Lots", "per trade, 1–10")}
        {num("max_entries_per_day", "Entries / day", "per index")}
        {num("tp_pct", "Take profit %", "premium decay")}
        {num("sl_pct", "Stop-loss %", "premium rise")}
        {num("max_daily_loss", "Daily loss limit ₹", "per mode", 500)}
      </div>
      <div className="flex justify-end mt-3">
        <button onClick={() => onSave(form)} disabled={saving} className="inline-flex items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold text-white"
          style={{ height: 32, background: "var(--oat-accent)", opacity: saving ? 0.5 : 1 }}>Save settings</button>
      </div>
    </Card>
  );
}

function LogCard({ entries }) {
  return (
    <Card title="Activity" icon={ShieldCheck} delay={0.3}>
      {!entries.length ? <div className="text-[12px] text-ink2">No activity yet.</div> : (
        <div className="flex flex-col gap-1.5 max-h-[380px] overflow-y-auto pr-1">
          {entries.map((e) => (
            <div key={e.id} className="grid grid-cols-[46px_1fr] gap-2 text-[11.5px]">
              <span className="n text-faint">{hhmm(e.created_at)}</span>
              <span style={{ color: e.level === "error" ? "var(--c-loss)" : e.level === "warn" ? "var(--c-warn)" : "var(--c-text-2)" }}>{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function NakedSell() {
  const [data, setData] = useState(null);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`${API}?resource=dashboard`).then((r) => r.json())
      .then((b) => { if (b.error) setError(b.message || b.error); else { setError(null); setData(b); } })
      .catch((e) => setError(e.message));
    fetch(`${API}?resource=log`).then((r) => r.json()).then((b) => { if (b.entries) setEntries(b.entries); }).catch(() => {});
  }, []);
  const hasOpen = (data?.active?.length ?? 0) > 0;
  useEffect(() => { load(); const t = setInterval(load, hasOpen ? POLL_OPEN_MS : POLL_MS); return () => clearInterval(t); }, [load, hasOpen]);

  const close = (p) => {
    if (!window.confirm(`Close ${p.mode} ${p.tradingsymbol} at the current price?`)) return;
    setBusyId(p.id);
    post("close", { id: p.id }).then(() => { setNotice(`${p.tradingsymbol} closed.`); load(); }).catch((e) => setNotice(e.message)).finally(() => setBusyId(null));
  };
  const save = (form) => {
    setSaving(true);
    const body = {
      enabled: form.enabled, paper_enabled: form.paper_enabled, shadow_enabled: form.shadow_enabled, symbols: form.symbols,
      allow_expiry_day: form.allow_expiry_day, lots: Number(form.lots), max_entries_per_day: Number(form.max_entries_per_day),
      tp_pct: Number(form.tp_pct), sl_pct: Number(form.sl_pct), max_daily_loss: Number(form.max_daily_loss),
    };
    post("settings", body).then(() => { setNotice("Settings saved."); load(); }).catch((e) => setNotice(e.message)).finally(() => setSaving(false));
  };

  if (data?.needsMigration) {
    return (
      <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-8" style={OAT_VARS}>
        <Card title="Setup required" icon={Warning}>
          <div className="text-[12.5px] text-ink2">Run <code className="n">src/naked-sell/migrations/001_naked_sell.sql</code> in the Supabase SQL editor, then reload.</div>
        </Card>
      </div>
    );
  }

  const st = Object.fromEntries((data?.stats ?? []).map((x) => [x.mode, x]));
  const s = data?.settings;
  return (
    <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-5 sm:py-7" style={OAT_VARS}>
      <motion.header initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}
        className="oat-hero rounded-[var(--radius-lg)] px-4 py-4 sm:px-6 sm:py-5 mb-4" style={{ border: "1px solid var(--c-line)", boxShadow: "var(--e-2)" }}>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center rounded-[12px] text-white shrink-0" style={{ width: 42, height: 42, background: "linear-gradient(135deg, var(--oat-accent), var(--c-loss))", boxShadow: "0 8px 20px rgba(90,85,247,.25)" }}>
              <Lightning size={22} weight="bold" />
            </span>
            <div>
              <h1 className="font-display text-[20px] sm:text-[22px] font-bold tracking-[-0.02em] leading-tight">Naked Sell</h1>
              <div className="text-[11.5px] text-muted">Intraday trend-following option selling · NIFTY &amp; SENSEX · PAPER + SHADOW</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s && <Pill tone={s.enabled ? "gain" : "neutral"}>{s.enabled ? "ENGINE ON" : "ENGINE OFF"}</Pill>}
            {data?.stream && (data.stream.connected
              ? <Pill tone="gain">LIVE PRICES · {data.stream.subscribed} subscribed</Pill>
              : <Pill tone="neutral">{data.stream.wanted ? "LIVE PRICES CONNECTING" : "LIVE PRICES IDLE"}</Pill>)}
            {s && <Pill tone="accent" icon={Target}>TP −{s.tp_pct}% · SL +{s.sl_pct}%</Pill>}
            <Pill tone="neutral">NO REAL ORDERS</Pill>
          </div>
        </div>
        <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mt-5 pt-4" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
          {["PAPER", "SHADOW"].map((m) => (
            <Stat key={m} label={`${m} TODAY`} value={st[m] ? signed(st[m].todayPnl + st[m].openPnl) : "—"} tone={st[m] ? tone(st[m].todayPnl + st[m].openPnl) : undefined}
              sub={st[m] ? `${st[m].todayTrades} closed · ${signed(st[m].openPnl)} open` : ""} />
          ))}
          {["PAPER", "SHADOW"].map((m) => (
            <Stat key={`${m}-all`} label={`${m} ALL-TIME`} value={st[m]?.trades ? signed(st[m].netPnl) : "—"} tone={st[m]?.trades ? tone(st[m].netPnl) : undefined}
              sub={st[m]?.trades ? `${st[m].trades} trades · ${st[m].winRate}% win · ${st[m].byReason.SL} SL` : "no closed trades"} />
          ))}
        </div>
      </motion.header>

      {error && <div className="mb-4 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
      <AnimatePresence>{notice && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 flex items-center justify-between gap-2 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-accent-soft)" }}>
          <span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={13} /></button>
        </motion.div>
      )}</AnimatePresence>

      {!data ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {[0, 1].map((i) => <div key={i} className={`oat-glass rounded-[var(--radius-lg)] h-[240px] animate-pulse ${i === 0 ? "lg:col-span-7" : "lg:col-span-5"}`} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 flex flex-col gap-4 min-w-0">
            <TrendCard trends={data.trends} symbols={s.symbols} nowMs={Date.parse(data.serverTime)} />
            <OpenCard positions={data.active} onClose={close} busyId={busyId} />
            <HistoryCard recent={data.recent} />
          </div>
          <div className="lg:col-span-5 flex flex-col gap-4 min-w-0">
            <RulesCard s={s} />
            <SettingsCard key={JSON.stringify(s)} s={s} onSave={save} saving={saving} />
            <LogCard entries={entries} />
          </div>
        </div>
      )}
    </div>
  );
}
