import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChartLineUp, Info, Wallet, Gear, CaretDown, CaretUp, CaretLeft, CaretRight, Shield, Bell, Eye, EyeSlash, SortAscending, CalendarBlank } from "@phosphor-icons/react";
import { inr, toneClass, scoreTone, scoreLabel } from "./swingFormat.js";

const POLL_MS = 60_000; // this dashboard only reads already-computed state (settings/positions/log) — the live chain fetch itself runs on its own 30-min cron, not on this poll

const STATUS_TONE = { ACTIVE: "muted", CLOSED: "muted", FAILED: "loss", CLOSE_FAILED: "loss" };

const INDEX_LABEL = { NIFTY: "NIFTY 50", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX" };

const MODE_COLOR = {
  OFF: { fg: "var(--c-faint)", bg: "var(--c-surface-3)" },
  PAPER: { fg: "var(--c-gain)", bg: "var(--c-gain-soft)" },
  SHADOW: { fg: "var(--c-accent)", bg: "var(--c-accent-soft)" },
  AUTO: { fg: "var(--c-loss)", bg: "var(--c-loss-soft)" },
};

/**
 * Compact live-market strip — a real ticker, not inline text: a small live
 * dot, tabular-aligned last price, and a signed change/%% with a caret.
 * Same `indices` data shape as before, purely a presentation change.
 */
function MarketStrip({ indices }) {
  if (!indices?.length) return null;
  const rows = indices.filter((idx) => idx.lastPrice != null);
  if (!rows.length) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap px-3 py-2 mb-3 rounded-[var(--radius-md)]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <span className="live-dot shrink-0" aria-hidden="true" />
      {rows.map((idx, i) => {
        const positive = (idx.change ?? 0) >= 0;
        return (
          <div key={idx.symbol} className="flex items-baseline gap-1.5 px-2.5 py-0.5" style={{ borderLeft: i > 0 ? "1px solid var(--c-line)" : "none" }}>
            <span className="text-[11px] font-semibold text-muted tracking-wide">{INDEX_LABEL[idx.symbol] ?? idx.symbol}</span>
            <span className="text-[13.5px] font-bold n">{idx.lastPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
            <span className={`text-[10.5px] font-semibold n flex items-center gap-0.5 ${positive ? "text-gain" : "text-loss"}`}>
              {positive ? "▲" : "▼"} {Math.abs(idx.change ?? 0).toFixed(2)} ({Math.abs(idx.changePct ?? 0).toFixed(2)}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

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

/** How stale a mark-to-market figure is — position-monitor only refreshes it every 5 minutes, so this is never presented as live-live. */
function agoLabel(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// entry_date/exit_date on the row are DATE-only (no time-of-day); created_at
// is stamped once, at insert, and updated_at on options_autotrade_positions
// is ONLY ever touched at close (the mark-to-market write in position-monitor
// updates unrealized_pnl_updated_at, not updated_at) — so these two
// timestamptz columns double as genuine entry/exit moments without needing
// new columns.
function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function ActivityLog({ timeline }) {
  return (
    <>
      <h2 className="text-[13px] font-bold mt-5 mb-2">Activity Log</h2>
      {timeline.length === 0 ? (
        <p className="text-[12.5px] text-muted py-6 text-center">No activity yet.</p>
      ) : (
        <div className="rounded-[var(--radius-lg)] overflow-hidden" style={{ border: "1px solid var(--c-line)" }}>
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
  );
}

/** Compact quality indicator — local to this page only (does NOT touch the
 * shared ScoreBadge in ScoreWidgets.jsx, which Swing Scanner also renders).
 * Reuses the exact same scoreTone/scoreLabel classification everything else
 * in the app already uses — no new thresholds invented, just a denser
 * "69 · FAIR" chip instead of a circular gauge. */
function ScoreChip({ score }) {
  const s = Math.round(score ?? 0);
  const tone = scoreTone(s);
  const color = tone === "muted" ? "var(--c-text-2)" : `var(--c-${tone})`;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold n" style={{ color }}>
      {s}
      <span className="text-[9.5px] font-bold tracking-wide opacity-80">{scoreLabel(s)}</span>
    </span>
  );
}

/** ACTIVE gets a small live dot; anything closed gets a muted status word — color is never the only signal (text is always present too). */
function StatusMark({ status, exitReason }) {
  if (status === "ACTIVE") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--c-gain)" }}>
        <span className="live-dot" style={{ background: "var(--c-gain)" }} aria-hidden="true" />
        Active
      </span>
    );
  }
  return (
    <span className={`text-[11px] ${toneClass(STATUS_TONE[status] ?? "muted")}`}>
      {status}{exitReason ? ` · ${exitReason}` : ""}
    </span>
  );
}

// Decorative only — a deterministic (position-id-seeded) wiggle that drifts
// toward the P&L's sign, NOT a real intraday price series (this app doesn't
// log a per-position P&L history to draw a genuine one from). Mirrors the
// reference portfolio screen's per-row trend line visually without
// pretending to be tick data.
function seededTrendPoints(seed, positive) {
  let s = (seed || 1) * 7919;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const pts = [50];
  for (let i = 1; i < 6; i++) {
    const drift = positive ? 5 : -5;
    const next = pts[i - 1] + drift + (rand() - 0.5) * 20;
    pts.push(Math.max(10, Math.min(90, next)));
  }
  return pts;
}

function Sparkline({ seed, positive }) {
  const pts = seededTrendPoints(seed, positive);
  const w = 56, h = 24;
  const path = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${h - (v / 100) * h}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <polyline points={path} fill="none" strokeWidth="1.5" stroke={positive ? "var(--c-gain)" : "var(--c-loss)"} strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}

/**
 * Dense capital/risk command bar — the SAME computed figures the old
 * DesktopHoldingsCard + MobilePortfolio summary card each recomputed
 * separately (today's P&L, margin committed, unrealized/realized P&L, max
 * loss at risk), now derived once and rendered as one responsive strip
 * instead of two differently-shaped oversized cards. Risk-utilization %% is
 * derived client-side from figures already loaded (max loss at risk vs.
 * reserved_fund, or the real account balance under AUTO) — no new backend
 * metric.
 */
function RiskCommandBar({ positions, settings, hideAmounts, setHideAmounts, realFunds }) {
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const totalMargin = positions.active.reduce((s, p) => s + (Number(p.margin_required) || 0), 0);
  const totalUnrealized = positions.active.reduce((s, p) => s + (Number(p.unrealized_pnl) || 0), 0);
  const totalRealizedToday = positions.closed.filter((p) => p.exit_date === todayIST).reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0);
  const maxLossAtRisk = positions.active.reduce((s, p) => s + (Number(p.max_loss) || 0), 0);
  const todaysPnl = totalUnrealized + totalRealizedToday;
  const fmt = (n) => (hideAmounts ? "••••••" : inr(n));
  const isLive = settings?.execution_mode === "AUTO";
  const isShadow = settings?.execution_mode === "SHADOW";

  const capitalBase = isLive ? realFunds?.availableFunds ?? null : Number(settings?.reserved_fund) || null;
  const riskPct = capitalBase && capitalBase > 0 ? (maxLossAtRisk / capitalBase) * 100 : null;

  return (
    <div className="rounded-[var(--radius-lg)] mb-4 px-4 py-3.5 sm:px-5" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="flex items-start sm:items-center gap-4 sm:gap-8 flex-wrap">
        <div className="min-w-[140px]">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10.5px] font-semibold text-muted tracking-wide">TODAY'S P&amp;L</span>
            <motion.button whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.9 }} onClick={() => setHideAmounts((v) => !v)} className="text-muted" aria-label="Toggle amount visibility">
              {hideAmounts ? <EyeSlash size={13} weight="regular" /> : <Eye size={13} weight="regular" />}
            </motion.button>
          </div>
          <div className={`font-display text-[30px] sm:text-[34px] font-bold n leading-none ${todaysPnl >= 0 ? "text-gain" : "text-loss"}`}>
            {todaysPnl >= 0 ? "+" : ""}{fmt(todaysPnl)}
          </div>
        </div>

        <div className="hidden sm:block w-px self-stretch" style={{ background: "var(--c-line)" }} />

        <div className="grid grid-cols-2 sm:flex sm:items-center gap-x-6 gap-y-2.5 sm:gap-8 flex-1">
          <RiskMetric label="Realized" value={fmt(totalRealizedToday)} tone={totalRealizedToday >= 0 ? "gain" : "loss"} signed />
          <RiskMetric label="Unrealized" value={fmt(totalUnrealized)} tone={totalUnrealized >= 0 ? "gain" : "loss"} signed />
          <RiskMetric label="Margin Used" value={fmt(totalMargin)} />
          <RiskMetric label="Max Risk" value={fmt(maxLossAtRisk)} tone={positions.active.length ? "loss" : undefined} />
        </div>

        {riskPct !== null && (
          <div className="w-full sm:w-auto sm:ml-auto sm:text-right">
            <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-0.5">RISK UTILIZATION</div>
            <div className="text-[13px] font-semibold n">
              {fmt(maxLossAtRisk)} <span className="text-faint font-normal">/ {fmt(capitalBase)}</span>
            </div>
            <div className="h-[3px] rounded-full mt-1 overflow-hidden w-full sm:w-[120px]" style={{ background: "var(--c-surface-3)" }}>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, riskPct)}%`, background: riskPct > 80 ? "var(--c-loss)" : riskPct > 50 ? "var(--c-warn)" : "var(--c-gain)" }} />
            </div>
          </div>
        )}
      </div>

      <div className="text-[10px] text-faint mt-2.5 pt-2.5" style={{ borderTop: "1px solid var(--c-line)" }}>
        {isLive ? "LIVE" : isShadow ? "SHADOW" : "PAPER"} positions ({positions.active.length}{settings?.max_positions ? ` / ${settings.max_positions} max` : ""})
      </div>
    </div>
  );
}

function RiskMetric({ label, value, tone, signed }) {
  const color = tone === "gain" ? "var(--c-gain)" : tone === "loss" ? "var(--c-loss)" : "var(--c-text)";
  return (
    <div>
      <div className="text-[10.5px] text-muted mb-0.5 whitespace-nowrap">{label}</div>
      <div className="text-[14px] sm:text-[15px] font-semibold n whitespace-nowrap" style={{ color }}>
        {signed && !String(value).startsWith("-") && !String(value).startsWith("•") ? "+" : ""}{value}
      </div>
    </div>
  );
}

function PositionCardMobile({ p, hideAmounts, isFirst }) {
  const [expanded, setExpanded] = useState(false);
  const isActive = p.status === "ACTIVE";
  const pnl = isActive ? p.unrealized_pnl : p.realized_pnl;
  const positive = (Number(pnl) || 0) >= 0;
  const fmt = (n) => (hideAmounts ? "••••••" : inr(n));
  const legs = p.options_autotrade_legs ?? [];
  const modeColor = MODE_COLOR[p.execution_mode] ?? MODE_COLOR.PAPER;

  return (
    <div className={`rounded-[var(--radius-md)] overflow-hidden ${isFirst ? "" : "mt-2.5"}`} style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <button onClick={() => setExpanded((v) => !v)} className="w-full text-left p-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[14px] font-semibold truncate">{p.symbol}</span>
          <span className={`text-[14px] font-semibold n shrink-0 ${pnl == null ? "text-faint" : positive ? "text-gain" : "text-loss"}`}>
            {pnl != null ? `${positive ? "+" : ""}${fmt(pnl)}` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11.5px] text-muted truncate">{p.strategy_label}</span>
            <span className="text-[9px] font-bold px-1 py-px rounded-[3px] shrink-0" style={{ background: modeColor.bg, color: modeColor.fg }}>
              {p.execution_mode === "AUTO" ? "LIVE" : p.execution_mode ?? "PAPER"}
            </span>
          </div>
          <StatusMark status={p.status} exitReason={p.exit_reason} />
        </div>
        <div className="flex items-center justify-between gap-3 mt-2 pt-2" style={{ borderTop: "1px solid var(--c-line)" }}>
          <div className="flex items-baseline gap-3 text-[11px]">
            <span className="text-faint">{p.expiry ?? "—"}</span>
            <span className="text-faint">Credit <b className="text-ink2 font-semibold n">{fmt(p.net_credit)}</b></span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Sparkline seed={p.id} positive={positive} />
            {expanded ? <CaretUp size={12} className="text-faint" /> : <CaretDown size={12} className="text-faint" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3" style={{ background: "var(--c-surface-2)", borderTop: "1px solid var(--c-line)" }}>
          <div className="grid grid-cols-3 gap-2.5 pt-3 pb-3 text-[11px]">
            <div><span className="text-faint">Max Profit</span><div className="n font-semibold text-gain mt-0.5">{fmt(p.max_profit)}</div></div>
            <div><span className="text-faint">Max Loss</span><div className="n font-semibold text-loss mt-0.5">{fmt(p.max_loss)}</div></div>
            <div><span className="text-faint">Margin</span><div className="n font-semibold mt-0.5">{p.margin_required != null ? fmt(p.margin_required) : "—"}</div></div>
            <div><span className="text-faint">Score</span><div className="mt-0.5"><ScoreChip score={p.quality_score} /></div></div>
            <div><span className="text-faint">Entry</span><div className="n font-medium mt-0.5">{formatDateTime(p.created_at) ?? "—"}</div></div>
            <div><span className="text-faint">Exit</span><div className="n font-medium mt-0.5">{!isActive ? (formatDateTime(p.updated_at) ?? "—") : "—"}</div></div>
          </div>

          {legs.length > 0 && (
            <div className="mb-3">
              <div className="text-[10.5px] font-semibold text-muted mb-1">Legs</div>
              <table className="w-full text-[11px]">
                <tbody>
                  {legs.map((l) => (
                    <tr key={l.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                      <td className="py-1 pr-2 font-medium">{l.side}</td>
                      <td className="py-1 pr-2">{l.strike}{l.option_right}</td>
                      <td className="py-1 pr-2 text-right n">{l.quantity}</td>
                      <td className="py-1 text-right n">{fmt(l.fill_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {p.decision_explanation && (
            <div>
              <div className="text-[10.5px] font-semibold text-muted mb-1">Decision Explanation</div>
              <pre className="text-[10.5px] text-ink2 whitespace-pre-wrap font-sans">{p.decision_explanation}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MobilePortfolio({ positions, hideAmounts }) {
  const [filter, setFilter] = useState("active"); // active | closed
  const [sortByPnl, setSortByPnl] = useState(false);

  const list = filter === "active" ? positions.active : positions.closed;
  const sorted = sortByPnl
    ? [...list].sort((a, b) => Math.abs(Number(b.status === "ACTIVE" ? b.unrealized_pnl : b.realized_pnl) || 0) - Math.abs(Number(a.status === "ACTIVE" ? a.unrealized_pnl : a.realized_pnl) || 0))
    : list;

  return (
    <div className="sm:hidden">
      <div className="flex items-center gap-2 mb-2">
        <div className="seg-track flex-1" role="tablist" aria-label="Filter">
          <button role="tab" aria-selected={filter === "active"} data-on={filter === "active"} onClick={() => setFilter("active")} className="seg">
            ACTIVE ({positions.active.length})
          </button>
          <button role="tab" aria-selected={filter === "closed"} data-on={filter === "closed"} onClick={() => setFilter("closed")} className="seg">
            CLOSED ({positions.closed.length})
          </button>
        </div>
        <button onClick={() => setSortByPnl((v) => !v)} className="topstep" title="Sort by |P&L|">
          <SortAscending size={12} weight="bold" />
          {sortByPnl ? "By P&L" : "Newest"}
        </button>
      </div>

      {sorted.length === 0 ? (
        <EmptyState label={`No ${filter} positions.`} />
      ) : (
        sorted.map((p, i) => (
          <PositionCardMobile key={p.id} p={p} hideAmounts={hideAmounts} isFirst={i === 0} />
        ))
      )}
    </div>
  );
}

function EmptyState({ label, sub }) {
  return (
    <div className="rounded-[var(--radius-md)] py-8 px-4 text-center" style={{ border: "1px dashed var(--c-line-2)", background: "var(--c-surface-2)" }}>
      <p className="text-[12.5px] font-semibold text-ink2">{label}</p>
      {sub && <p className="text-[11.5px] text-muted mt-1 max-w-[42ch] mx-auto">{sub}</p>}
    </div>
  );
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthKeyOf = (s) => s.slice(0, 7);

/**
 * P&L calendar — a Kite-style month grid, each day tinted green/red by that
 * day's net realized P&L, tap any day to see its total and the trades that
 * closed on it. Built from positions.closed alone, which is the ONLY
 * history this component has: /api/options-autotrade?resource=positions
 * caps at the 200 most recent closed rows overall, so a month far enough
 * back to fall outside that window will read empty here even if trades
 * happened — a real limitation, not a rendering bug, worth revisiting with
 * a dedicated date-ranged endpoint if history grows past that cap.
 */
function PnLCalendar({ positions, hideAmounts }) {
  const todayIso = isoDate(new Date());
  const [month, setMonth] = useState(() => monthKeyOf(todayIso));
  const [selected, setSelected] = useState(todayIso);
  const fmt = (n) => (hideAmounts ? "••••••" : inr(n));

  const byDay = {};
  for (const p of positions.closed) {
    if (!p.exit_date) continue;
    (byDay[p.exit_date] ??= []).push(p);
  }

  const grid = (() => {
    const [y, m] = month.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = isoDate(d);
      const trades = byDay[key] ?? [];
      const pnl = trades.reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0);
      return { key, day: d.getDate(), inMonth: d.getMonth() === m - 1, trades, pnl };
    });
  })();

  const shiftMonth = (n) => {
    const [y, m] = month.split("-").map(Number);
    setMonth(monthKeyOf(isoDate(new Date(y, m - 1 + n, 1))));
  };
  const monthTitle = new Date(month + "-01T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const selectedCell = grid.find((c) => c.key === selected) ?? { key: selected, trades: byDay[selected] ?? [], pnl: (byDay[selected] ?? []).reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0) };
  const selectedLabel = new Date(selected + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="sm:flex sm:gap-4 sm:items-start">
      <div className="sm:w-[360px] sm:shrink-0 rounded-[var(--radius-lg)] p-4 mb-3 sm:mb-0" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <div className="flex items-center gap-1 mb-3">
          <button onClick={() => shiftMonth(-1)} className="topstep !px-2" aria-label="Previous month"><CaretLeft size={12} weight="bold" /></button>
          <span className="text-[13px] font-semibold flex-1 text-center n">{monthTitle}</span>
          <button onClick={() => shiftMonth(1)} className="topstep !px-2" aria-label="Next month"><CaretRight size={12} weight="bold" /></button>
        </div>

        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((w, i) => (
            <div key={i} className="text-[10px] font-semibold text-faint text-center py-1">{w}</div>
          ))}
          {grid.map((c) => {
            const hasTrades = c.trades.length > 0;
            const positive = c.pnl >= 0;
            const isSelected = c.key === selected;
            const isToday = c.key === todayIso;
            return (
              <button
                key={c.key}
                onClick={() => setSelected(c.key)}
                className="rounded-[var(--radius-sm)] py-1 flex flex-col items-center justify-center gap-0.5"
                style={{
                  minHeight: 42,
                  opacity: c.inMonth ? 1 : 0.35,
                  background: isSelected ? "var(--c-accent-soft)" : hasTrades ? (positive ? "var(--c-gain-soft)" : "var(--c-loss-soft)") : "transparent",
                  border: isSelected ? "1px solid var(--c-accent)" : isToday ? "1px solid var(--c-line-2)" : "1px solid transparent",
                }}
              >
                <span className="text-[11px] n font-medium">{c.day}</span>
                {hasTrades && (
                  <span className={`text-[8.5px] n font-semibold ${positive ? "text-gain" : "text-loss"}`}>
                    {hideAmounts ? "••" : Math.abs(c.pnl) >= 1000 ? `${positive ? "+" : "-"}${(Math.abs(c.pnl) / 1000).toFixed(1)}k` : `${positive ? "+" : "-"}${Math.round(Math.abs(c.pnl))}`}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 rounded-[var(--radius-lg)] p-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12.5px] font-semibold">{selectedLabel}</span>
          <span className={`text-[13px] font-bold n ${selectedCell.pnl >= 0 ? "text-gain" : "text-loss"}`}>
            {selectedCell.trades.length > 0 ? `${selectedCell.pnl >= 0 ? "+" : ""}${fmt(selectedCell.pnl)}` : "—"}
          </span>
        </div>
        {selectedCell.trades.length === 0 ? (
          <p className="text-[11.5px] text-muted py-3 text-center">No trades closed this day.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {selectedCell.trades.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-[12px]" style={{ borderTop: "1px solid var(--c-line)", paddingTop: 6 }}>
                <div className="min-w-0">
                  <div className="font-medium">{p.symbol} <span className="text-faint font-normal">· {p.strategy_label}</span></div>
                  <div className="text-[10px] text-faint">{p.exit_reason ?? "—"}</div>
                </div>
                <span className={`n font-semibold shrink-0 ${(Number(p.realized_pnl) || 0) >= 0 ? "text-gain" : "text-loss"}`}>
                  {fmt(p.realized_pnl)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Desktop blotter row — grouped columns (instrument+strategy together,
 * credit/max-profit/max-loss as one visual triplet, a single P&L column
 * that shows whichever of unrealized/realized applies) rather than 14
 * equally-weighted columns. Same data/fields as before, no column removed. */
function PositionRow({ p }) {
  const [expanded, setExpanded] = useState(false);
  const legs = p.options_autotrade_legs ?? [];
  const modeColor = MODE_COLOR[p.execution_mode] ?? MODE_COLOR.PAPER;
  const pnl = p.status === "ACTIVE" ? p.unrealized_pnl : p.realized_pnl;
  const rr = p.max_loss > 0 && p.max_profit != null ? p.max_profit / p.max_loss : null;

  return (
    <>
      <tr style={{ borderTop: "1px solid var(--c-line)" }} className="row-hover">
        <td className="py-2.5 pl-4 pr-2">
          <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1.5 text-left">
            <div>
              <div className="font-semibold text-[12.5px] flex items-center gap-1.5">
                {p.symbol}
                <span className="text-[9px] font-bold px-1 py-px rounded-[3px]" style={{ background: modeColor.bg, color: modeColor.fg }}>
                  {p.execution_mode === "AUTO" ? "LIVE" : p.execution_mode ?? "PAPER"}
                </span>
              </div>
              <div className="text-[10.5px] text-faint">{p.strategy_label}</div>
            </div>
            {expanded ? <CaretUp size={11} className="text-faint shrink-0" /> : <CaretDown size={11} className="text-faint shrink-0" />}
          </button>
        </td>
        <td className="py-2.5 pr-3 text-[11px]">
          <div className="n">{p.expiry ?? "—"}</div>
          <div className="text-[10px] text-faint n">{formatDateTime(p.created_at) ?? "—"}</div>
        </td>
        <td className="py-2.5 pr-3 text-right">
          <div className="n text-[11.5px]">{inr(p.net_credit)}</div>
          <div className="text-[10px] n"><span className="text-gain">{inr(p.max_profit)}</span> <span className="text-faint">/</span> <span className="text-loss">{inr(p.max_loss)}</span></div>
        </td>
        <td className="py-2.5 pr-3 text-right text-[11.5px] n">{p.margin_required != null ? inr(p.margin_required) : "—"}</td>
        <td className="py-2.5 pr-3 text-[11.5px] n">{rr !== null ? `1 : ${rr.toFixed(2)}` : "—"}</td>
        <td className="py-2.5 pr-3"><ScoreChip score={p.quality_score} /></td>
        <td className="py-2.5 pr-3"><StatusMark status={p.status} exitReason={p.exit_reason} /></td>
        <td className={`py-2.5 pr-4 text-right n text-[12px] font-semibold ${pnl == null ? "text-faint" : pnl >= 0 ? "text-gain" : "text-loss"}`}>
          {pnl != null ? `${pnl >= 0 ? "+" : ""}${inr(pnl)}` : "—"}
          {p.status === "ACTIVE" && p.unrealized_pnl != null && (
            <div className="text-[9.5px] text-faint font-normal">{agoLabel(p.unrealized_pnl_updated_at)}</div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="px-4 pb-3" style={{ background: "var(--c-surface-2)" }}>
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
  const [mobileTab, setMobileTab] = useState("portfolio"); // portfolio | calendar | activity
  const [descOpen, setDescOpen] = useState(false);
  const [hideAmounts, setHideAmounts] = useState(false);
  const [realFunds, setRealFunds] = useState(null);
  const [growwRealFunds, setGrowwRealFunds] = useState(null);
  const [showAllModes, setShowAllModes] = useState(false);
  const [indices, setIndices] = useState([]);
  const [showDesktopCalendar, setShowDesktopCalendar] = useState(false);
  const [growwStatus, setGrowwStatus] = useState(null);
  const [growwConnecting, setGrowwConnecting] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/options-autotrade?resource=settings").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=positions").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=log").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=daily-stats").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=real-funds").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=indices").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=groww-status").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=groww-real-funds").then((r) => r.json()),
    ])
      .then(([s, posBody, logBody, dailyBody, fundsBody, indicesBody, growwBody, growwFundsBody]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSettings(s);
        setDraft((d) => ({ ...d, ...s }));
        setPositions({ active: posBody.active ?? [], closed: posBody.closed ?? [] });
        setLogEntries(logBody.entries ?? []);
        setDailyStats(dailyBody);
        setRealFunds(fundsBody);
        setIndices(indicesBody?.indices ?? []);
        setGrowwStatus(growwBody);
        setGrowwRealFunds(growwFundsBody);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const setActiveBroker = (broker) => {
    setSaving(true);
    fetch("/api/options-autotrade?resource=settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_broker: broker }),
    })
      .then((r) => r.json())
      .then((s) => { if (!s.error) setSettings(s); })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const connectGroww = () => {
    setGrowwConnecting(true);
    fetch("/api/options-autotrade?resource=groww-connect", { method: "POST" })
      .then((r) => r.json())
      .then((result) => { setGrowwStatus(result.ok ? { ok: true, connected: true, obtainedAt: new Date().toISOString() } : { ok: false, connected: false, error: result.error }); })
      .catch((e) => setGrowwStatus({ ok: false, connected: false, error: e.message }))
      .finally(() => setGrowwConnecting(false));
  };

  // A position's execution_mode is fixed at the moment it opened — a
  // PAPER position stays PAPER even after the switch is later moved to
  // AUTO. Once AUTO is active, PAPER history sitting in the same list as
  // real positions is actively misleading (it looks like real money that
  // isn't), so the default view filters to whichever mode is currently
  // selected; showAllModes opts back into seeing everything together.
  const visiblePositions = showAllModes || !settings?.execution_mode || settings.execution_mode === "OFF"
    ? positions
    : {
        active: positions.active.filter((p) => (p.execution_mode ?? "PAPER") === settings.execution_mode),
        closed: positions.closed.filter((p) => (p.execution_mode ?? "PAPER") === settings.execution_mode),
      };

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

  // Covers a page load/refresh landing directly on an already-AUTO (or
  // already-back-to-PAPER/OFF) account, not just the moment the switch is
  // flipped from here — dark exactly while AUTO is active, light the
  // moment it isn't, no manual refresh needed either direction.
  useEffect(() => {
    if (!settings?.execution_mode) return;
    const wantTheme = settings.execution_mode === "AUTO" ? "dark" : "light";
    try {
      if (document.documentElement.getAttribute("data-theme") !== wantTheme) {
        document.documentElement.setAttribute("data-theme", wantTheme);
        localStorage.setItem("thetalab-theme", wantTheme);
      }
    } catch { /* private browsing, etc. */ }
  }, [settings?.execution_mode]);

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

  const setExecutionMode = (mode) => {
    if (mode === "AUTO") {
      const broker = settings?.active_broker === "GROWW" ? "GROWW" : "KITE";
      const confirmed = window.confirm(
        broker === "GROWW"
          ? "Broker is set to GROWW.\n\n" +
            "Real order placement through Groww is NOT fully enabled yet — a required safety check (broker reconciliation, which prevents a duplicate real order firing when this system's records disagree with the broker's) only exists for Kite so far. Every Groww-routed entry will currently be refused rather than place a real order.\n\n" +
            "Switching to AUTO now will still enable real Kite closing orders for any EXISTING Kite positions, and live decisioning/sizing checks will run for real. Are you sure you want to switch to AUTO?"
          : "This places REAL orders on your real Zerodha (Kite) account with real money — not a simulation.\n\n" +
            "Every future scan cycle will size and fire live BUY/SELL orders the moment a candidate clears the quality gate, with no per-trade confirmation. " +
            "Position-monitor will also place real closing orders automatically.\n\n" +
            "Are you sure you want to switch to AUTO?",
      );
      if (!confirmed) return;
      // Real money gets a visually distinct app-wide theme, not just this
      // page's own badges — same data-theme/localStorage mechanism App.jsx
      // itself uses, so it sticks across section switches and reloads
      // exactly like a manual toggle would.
      try {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem("thetalab-theme", "dark");
      } catch { /* private browsing, etc. */ }
    }
    setSaving(true);
    fetch("/api/options-autotrade?resource=settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_mode: mode }),
    })
      .then((r) => r.json())
      .then((s) => { if (!s.error) setSettings(s); })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const triggerKillSwitch = () => {
    const activeCount = positions.active.length;
    const liveCount = positions.active.filter((p) => p.execution_mode === "AUTO").length;
    const confirmed = window.confirm(
      `This stops new entries (execution_mode -> OFF) — it does NOT close any open position.${
        activeCount > 0 ? ` ${activeCount} open position(s) remain open${liveCount ? `, ${liveCount} of them REAL on your Zerodha account` : ""} — position-monitor's own exit engine keeps evaluating and closing them independently on its cron, kill switch or not.` : ""
      } Continue?`,
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

  // Same filter as visiblePositions: an entry tagged for the OTHER mode
  // is hidden by default once a mode is active, so old PAPER activity
  // doesn't sit in the log looking like it's still happening under AUTO.
  // Untagged entries (batch-level, or written before this column existed)
  // always show — they were never claiming to be either mode.
  const modeFiltered = showAllModes || !settings?.execution_mode || settings.execution_mode === "OFF"
    ? logEntries
    : logEntries.filter((e) => !e.execution_mode || e.execution_mode === settings.execution_mode);
  const timeline = [
    ...modeFiltered.map((e) => ({ time: e.created_at, level: e.level, message: e.message })),
  ].slice(0, 30);

  const modeColor = MODE_COLOR[settings?.execution_mode] ?? MODE_COLOR.OFF;

  return (
    <div className="px-3 sm:px-6 pt-3 pb-20 sm:pb-6 max-w-[1560px] mx-auto relative" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}>
      {/* ── Header: title, mode badge, kill switch — one row, no wasted height ── */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <ChartLineUp size={17} weight="bold" className="text-accent shrink-0" />
          <h1 className="font-display text-[17px] sm:text-[20px] font-bold tracking-[-0.01em] truncate">Options Auto-Trader</h1>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-[var(--radius-sm)] shrink-0" style={{ background: modeColor.bg, color: modeColor.fg }}>
            {settings?.execution_mode ?? "…"}
          </span>
        </div>
        <motion.button
          whileHover={{ scale: killSwitchBusy ? 1 : 1.03 }}
          whileTap={{ scale: killSwitchBusy ? 1 : 0.97 }}
          onClick={triggerKillSwitch} disabled={killSwitchBusy}
          className="flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1.5 rounded-[var(--radius-sm)] shrink-0"
          style={{ background: "var(--c-surface)", color: "var(--c-loss)", border: "1px solid var(--c-loss)" }}
          title="Stops new entries only — position-monitor's own exit engine still evaluates and closes open positions independently"
        >
          <Shield size={13} weight="bold" />
          {killSwitchBusy ? "Stopping…" : "Kill Switch"}
        </motion.button>
      </div>

      <MarketStrip indices={indices} />

      {/* ── Execution mode: premium segmented control, compact contextual line, info on demand ── */}
      <div className="flex items-center gap-3 flex-wrap py-2.5 mb-3 px-3 rounded-[var(--radius-md)]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <span className="text-[11px] font-semibold text-muted shrink-0">Execution Mode</span>
        <div className="seg-track">
          {["OFF", "PAPER", "SHADOW", "AUTO"].map((mode) => (
            <motion.button key={mode} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              role="tab" aria-selected={settings?.execution_mode === mode} data-on={settings?.execution_mode === mode}
              onClick={() => setExecutionMode(mode)} disabled={saving} className="seg"
              style={settings?.execution_mode === mode ? { color: MODE_COLOR[mode].fg } : undefined}>
              {mode}
            </motion.button>
          ))}
        </div>
        {settings?.execution_mode && settings.execution_mode !== "OFF" && (
          <span className="text-[10.5px] font-semibold px-2 py-1 rounded-[var(--radius-sm)] inline-flex items-center gap-1.5" style={{ background: modeColor.bg, color: modeColor.fg }}>
            {settings.execution_mode === "AUTO" ? "Live decisions · real broker orders"
              : settings.execution_mode === "SHADOW" ? "Live decisions · simulated fills · zero broker orders"
              : "Live decisions · paper fills · zero broker orders"}
            <button onClick={() => setDescOpen((v) => !v)} className="opacity-70 hover:opacity-100" aria-label="More about this mode" title="What is this?">
              <Info size={12} weight="bold" />
            </button>
          </span>
        )}
      </div>

      {/* ── Broker: which account AUTO's real orders would route through.
          Kite stays wired in for market data/historical regardless — Groww's
          own 1-minute history only covers 3 months, it can't replace that. ── */}
      <div className="flex items-center gap-3 flex-wrap py-2.5 mb-3 px-3 rounded-[var(--radius-md)]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <span className="text-[11px] font-semibold text-muted shrink-0">Broker</span>
        <div className="seg-track">
          {["KITE", "GROWW"].map((broker) => (
            <button key={broker} role="tab" aria-selected={(settings?.active_broker ?? "KITE") === broker}
              data-on={(settings?.active_broker ?? "KITE") === broker}
              onClick={() => setActiveBroker(broker)} disabled={saving} className="seg">
              {broker}
            </button>
          ))}
        </div>
        {(settings?.active_broker ?? "KITE") === "GROWW" && (
          <>
            <span className="text-[10.5px] px-2 py-1 rounded-[var(--radius-sm)]" style={{ background: growwStatus?.connected ? "var(--c-gain-soft)" : "var(--c-warn-soft)", color: growwStatus?.connected ? "var(--c-gain)" : "var(--c-warn)" }}>
              {growwStatus?.connected ? `Connected${growwStatus.obtainedAt ? ` · ${agoLabel(growwStatus.obtainedAt)}` : ""}` : "Not connected"}
            </span>
            <button onClick={connectGroww} disabled={growwConnecting} className="topstep text-[11px]">
              {growwConnecting ? "Connecting…" : growwStatus?.connected ? "Reconnect Groww" : "Connect Groww"}
            </button>
            {growwStatus?.error && <span className="text-[10.5px] text-loss">{growwStatus.error}</span>}
            <span className="text-[10px] text-faint w-full">
              Connection only — real order placement isn't routed through Groww yet, AUTO still executes via Kite.
            </span>
          </>
        )}
      </div>

      {descOpen && (
        <p className="text-[11px] text-muted mb-3 max-w-[80ch] px-1">
          Defined-risk options selling (Iron Condor / Bull Put Spread / Bear Call Spread), decided from a live chain: skew-based
          strategy selection, strike optimization ranked by expected value per unit of risk, expiry selection, and a 0-100 trade
          quality score gate. Runs on its own 30-minute cron against live Kite data — this page only displays the result, it
          doesn't trigger a scan. PAPER and SHADOW modes: no real order is ever placed.
        </p>
      )}

      {killSwitchResult && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[var(--radius-md)] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <Shield size={15} weight="bold" className="shrink-0 mt-px text-loss" />
          <div className="text-[12px] flex-1">{killSwitchResult.ok === false ? `Kill switch failed: ${killSwitchResult.message}` : killSwitchResult.message}</div>
          <button onClick={() => setKillSwitchResult(null)} className="text-[11px] text-muted shrink-0">Dismiss</button>
        </div>
      )}

      {dailyStats?.locked && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[var(--radius-md)] mb-4" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
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

      {/* ── Settings: collapsed by default, risk-parameter fields only (mode moved above, always visible) ── */}
      <div className="rounded-[var(--radius-md)] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <button onClick={() => setSettingsOpen((v) => !v)} className="w-full flex items-center gap-3 sm:flex-wrap p-3 text-left">
          <Gear size={14} weight="bold" className="text-muted shrink-0" />
          <span className="text-[11.5px] font-semibold">Risk &amp; Strategy Settings</span>
          <span className="hidden sm:inline text-[10.5px] text-faint">Reserved fund {inr(settings?.reserved_fund ?? 0)}</span>
          <span className="flex-1" />
          {settingsOpen ? <CaretUp size={14} className="text-muted shrink-0" /> : <CaretDown size={14} className="text-muted shrink-0" />}
        </button>

        {settingsOpen && (
          <div className="px-3 pb-3 pt-1" style={{ borderTop: "1px solid var(--c-line)" }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {EDITABLE_GROUPS.map((group) => (
                <div key={group.title} className="p-2.5 rounded-[var(--radius-sm)]" style={{ background: "var(--c-surface-2)" }}>
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
        <div className="rounded-[var(--radius-lg)] h-[92px] mb-4 skeleton" />
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[var(--radius-md)]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12.5px] text-ink2">{error}</p>
        </div>
      ) : (
        <>
          {settings?.execution_mode === "AUTO" && (() => {
            const isGroww = settings?.active_broker === "GROWW";
            const funds = isGroww ? growwRealFunds : realFunds;
            const noSessionLabel = isGroww ? "No Groww session" : "No Kite session";
            const noSessionCode = isGroww ? "no_groww_session" : "no_kite_session";
            return (
              <div className="flex items-center gap-3 flex-wrap mb-3 p-3 rounded-[var(--radius-md)]" style={{ border: "1px solid var(--c-loss)", background: "var(--c-loss-soft)" }}>
                <span className="text-[11px] font-semibold text-loss">REAL {isGroww ? "GROWW" : "ZERODHA"} BALANCE</span>
                <span className="text-[15px] font-bold n text-loss">
                  {funds?.availableFunds != null ? inr(funds.availableFunds) : funds?.skipped === noSessionCode ? noSessionLabel : "—"}
                </span>
                {funds?.utilised != null && <span className="text-[10.5px] text-ink2">({inr(funds.utilised)} utilised)</span>}
                {isGroww && (
                  <span className="text-[10.5px] text-ink2">— real order placement through Groww is not enabled yet, entries are refused at a safety gate</span>
                )}
                <label className="flex items-center gap-1.5 text-[10.5px] text-ink2 ml-auto">
                  <input type="checkbox" checked={showAllModes} onChange={(e) => setShowAllModes(e.target.checked)} />
                  Show PAPER history too
                </label>
              </div>
            );
          })()}

          <RiskCommandBar positions={visiblePositions} settings={settings} hideAmounts={hideAmounts} setHideAmounts={setHideAmounts} realFunds={realFunds} />

          {visiblePositions.active.length === 0 && visiblePositions.closed.length === 0 ? (
            <EmptyState
              label="No active positions"
              sub={`The scanner is monitoring NIFTY, BANKNIFTY and SENSEX. New ${settings?.execution_mode === "AUTO" ? "AUTO" : settings?.execution_mode === "SHADOW" ? "SHADOW" : "PAPER"} positions appear automatically when a candidate qualifies.`}
            />
          ) : (
            <AnimatePresence mode="wait">
              {mobileTab === "activity" ? null : mobileTab === "calendar" ? (
                <motion.div key="calendar" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} className="sm:hidden">
                  <PnLCalendar positions={visiblePositions} hideAmounts={hideAmounts} />
                </motion.div>
              ) : (
                <motion.div key="portfolio" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
                  <MobilePortfolio positions={visiblePositions} hideAmounts={hideAmounts} />
                </motion.div>
              )}
            </AnimatePresence>
          )}

          <div className="hidden sm:flex items-center gap-3 mb-2">
            <h2 className="text-[13px] font-bold">
              Open Positions {visiblePositions.active.length > 0 ? <span className="font-normal text-muted">({visiblePositions.active.length} active)</span> : null}
            </h2>
            <button onClick={() => setShowDesktopCalendar((v) => !v)} className="topstep text-[11px] ml-auto">
              <CalendarBlank size={12} weight="bold" />
              {showDesktopCalendar ? "Hide Calendar" : "Show Calendar"}
            </button>
          </div>
          {showDesktopCalendar && (
            <div className="hidden sm:block mb-4">
              <PnLCalendar positions={visiblePositions} hideAmounts={hideAmounts} />
            </div>
          )}
          {visiblePositions.active.length === 0 && visiblePositions.closed.length === 0 ? null : (
            <div className="hidden sm:block overflow-x-auto rounded-[var(--radius-lg)]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-4 pr-2">Instrument</th>
                    <th className="font-medium py-2 pr-3">Expiry / Entry</th>
                    <th className="font-medium py-2 pr-3 text-right">Credit / Payoff</th>
                    <th className="font-medium py-2 pr-3 text-right">Margin</th>
                    <th className="font-medium py-2 pr-3">Risk : Reward</th>
                    <th className="font-medium py-2 pr-3">Score</th>
                    <th className="font-medium py-2 pr-3">Status</th>
                    <th className="font-medium py-2 pr-4 text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...visiblePositions.active, ...visiblePositions.closed].map((p) => <PositionRow key={p.id} p={p} />)}
                </tbody>
              </table>
            </div>
          )}

          <div className="hidden sm:block">
            <ActivityLog timeline={timeline} />
          </div>
          {mobileTab === "activity" && (
            <div className="sm:hidden">
              <ActivityLog timeline={timeline} />
            </div>
          )}
        </>
      )}

      <div className="sm:hidden fixed bottom-0 inset-x-0 z-40 flex" style={{ borderTop: "1px solid var(--c-line)", background: "var(--c-surface)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        <button onClick={() => setMobileTab("portfolio")} className="flex-1 flex flex-col items-center gap-0.5 py-2" style={{ color: mobileTab === "portfolio" ? "var(--c-accent)" : "var(--c-muted)", minHeight: 44 }}>
          <Wallet size={18} weight={mobileTab === "portfolio" ? "fill" : "regular"} />
          <span className="text-[10px] font-medium">Portfolio</span>
        </button>
        <button onClick={() => setMobileTab("calendar")} className="flex-1 flex flex-col items-center gap-0.5 py-2" style={{ color: mobileTab === "calendar" ? "var(--c-accent)" : "var(--c-muted)", minHeight: 44 }}>
          <CalendarBlank size={18} weight={mobileTab === "calendar" ? "fill" : "regular"} />
          <span className="text-[10px] font-medium">Calendar</span>
        </button>
        <button onClick={() => setMobileTab("activity")} className="flex-1 flex flex-col items-center gap-0.5 py-2" style={{ color: mobileTab === "activity" ? "var(--c-accent)" : "var(--c-muted)", minHeight: 44 }}>
          <Bell size={18} weight={mobileTab === "activity" ? "fill" : "regular"} />
          <span className="text-[10px] font-medium">Activity</span>
        </button>
      </div>
    </div>
  );
}
