import { useState, useEffect, useCallback, useRef } from "react";
import { ChartLineUp, Info, Wallet, Gear, CaretDown, CaretUp, CaretLeft, CaretRight, HandPalm, Bell, Eye, EyeSlash, SortAscending, CalendarBlank } from "@phosphor-icons/react";
import { inr, toneClass } from "./swingFormat.js";
import { ScoreBadge } from "./ScoreWidgets.jsx";

const POLL_MS = 60_000; // this dashboard only reads already-computed state (settings/positions/log) — the live chain fetch itself runs on its own 30-min cron, not on this poll

const STATUS_TONE = { ACTIVE: "muted", CLOSED: "muted", FAILED: "loss", CLOSE_FAILED: "loss" };

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
  const w = 64, h = 26;
  const path = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${h - (v / 100) * h}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <polyline points={path} fill="none" strokeWidth="1.5" stroke={positive ? "var(--c-gain)" : "var(--c-loss)"} strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </svg>
  );
}

function MobilePositionRow({ p, hideAmounts, isFirst }) {
  const [expanded, setExpanded] = useState(false);
  const isActive = p.status === "ACTIVE";
  const pnl = isActive ? p.unrealized_pnl : p.realized_pnl;
  const positive = (Number(pnl) || 0) >= 0;
  const fmt = (n) => (hideAmounts ? "••••••" : inr(n));
  const legs = p.options_autotrade_legs ?? [];
  return (
    <div style={{ borderTop: isFirst ? "none" : "1px solid var(--c-line)" }}>
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-2.5 px-3 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold truncate flex items-center gap-1">
            {p.symbol}
            {p.execution_mode === "AUTO" && (
              <span className="text-[8.5px] font-bold px-1 rounded-[3px]" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>LIVE</span>
            )}
            {expanded ? <CaretUp size={11} className="text-faint shrink-0" /> : <CaretDown size={11} className="text-faint shrink-0" />}
          </div>
          <div className="text-[11px] text-faint truncate">{p.strategy_label} · {p.lots} lot{p.lots === 1 ? "" : "s"}</div>
          {!isActive && (
            <div className={`text-[10px] mt-0.5 ${toneClass(STATUS_TONE[p.status] ?? "muted")}`}>{p.status}{p.exit_reason ? ` · ${p.exit_reason}` : ""}</div>
          )}
        </div>
        <Sparkline seed={p.id} positive={positive} />
        <div className="text-right shrink-0 min-w-[84px]">
          <div className={`text-[13.5px] font-semibold n ${pnl == null ? "text-faint" : positive ? "text-gain" : "text-loss"}`}>
            {pnl != null ? fmt(pnl) : "—"}
          </div>
          <div className="text-[10.5px] text-faint n">
            ({fmt(p.margin_required)})
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3" style={{ background: "var(--c-surface-2)" }}>
          <div className="grid grid-cols-2 gap-2 pt-2 pb-3 text-[11px]">
            <div><span className="text-faint">Expiry</span><div className="n font-medium">{p.expiry ?? "—"}</div></div>
            <div><span className="text-faint">Score</span><div className="font-medium">{Math.round(p.quality_score ?? 0)}/100</div></div>
            <div><span className="text-faint">Net Credit</span><div className="n font-medium">{fmt(p.net_credit)}</div></div>
            <div><span className="text-faint">Margin</span><div className="n font-medium">{p.margin_required != null ? fmt(p.margin_required) : "—"}</div></div>
            <div><span className="text-faint">Max Profit</span><div className="n font-medium text-gain">{fmt(p.max_profit)}</div></div>
            <div><span className="text-faint">Max Loss</span><div className="n font-medium text-loss">{fmt(p.max_loss)}</div></div>
            <div><span className="text-faint">Entry</span><div className="n font-medium">{formatDateTime(p.created_at) ?? "—"}</div></div>
            <div><span className="text-faint">Exit</span><div className="n font-medium">{!isActive ? (formatDateTime(p.updated_at) ?? "—") : "—"}</div></div>
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

/**
 * Mobile portfolio-card view — deliberately modeled on a real brokerage
 * app's Holdings screen (summary card with a hero number + return rows,
 * then a flat list of position rows each showing name/qty, a trend
 * sparkline, and current/reference value stacked on the right) rather than
 * the desktop table, which doesn't fit a phone screen. Shown only below the
 * sm breakpoint — see the "hidden sm:block" / "sm:hidden" split below.
 */
function MobilePortfolio({ positions, hideAmounts, setHideAmounts }) {
  const [filter, setFilter] = useState("active"); // active | closed
  const [sortByPnl, setSortByPnl] = useState(false);

  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const totalMargin = positions.active.reduce((s, p) => s + (Number(p.margin_required) || 0), 0);
  const totalUnrealized = positions.active.reduce((s, p) => s + (Number(p.unrealized_pnl) || 0), 0);
  // positions.closed (from the API) is the 200 most recent closed rows
  // overall, not scoped to today — filter by exit_date so this actually
  // means what its label says, rather than quietly including older history.
  const totalRealizedToday = positions.closed
    .filter((p) => p.exit_date === todayIST)
    .reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0);
  const todaysPnl = totalUnrealized + totalRealizedToday;
  const fmt = (n) => (hideAmounts ? "••••••" : inr(n));
  const pctOf = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(2)}%` : null);

  const list = filter === "active" ? positions.active : positions.closed;
  const sorted = sortByPnl
    ? [...list].sort((a, b) => Math.abs(Number(b.status === "ACTIVE" ? b.unrealized_pnl : b.realized_pnl) || 0) - Math.abs(Number(a.status === "ACTIVE" ? a.unrealized_pnl : a.realized_pnl) || 0))
    : list;

  return (
    <div className="sm:hidden">
      <div className="rounded-[16px] p-4 mb-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[11px] font-semibold text-muted tracking-wide">PAPER POSITIONS ({positions.active.length})</span>
          <button onClick={() => setHideAmounts((v) => !v)} className="ml-auto text-muted" aria-label="Toggle amount visibility">
            {hideAmounts ? <EyeSlash size={16} weight="regular" /> : <Eye size={16} weight="regular" />}
          </button>
        </div>

        <div className={`text-[26px] font-bold n leading-none mb-1 ${todaysPnl >= 0 ? "text-gain" : "text-loss"}`}>
          {todaysPnl >= 0 ? "+" : ""}{fmt(todaysPnl)}
        </div>
        <div className={`text-[11.5px] n mb-3 ${todaysPnl >= 0 ? "text-gain" : "text-loss"}`}>
          Today's P&L{pctOf(todaysPnl, totalMargin) ? ` (${pctOf(todaysPnl, totalMargin)})` : ""}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">Unrealized P&L</span>
            <span className={`n font-semibold ${totalUnrealized >= 0 ? "text-gain" : "text-loss"}`}>
              {totalUnrealized >= 0 ? "+" : ""}{fmt(totalUnrealized)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">Realized P&L (today)</span>
            <span className={`n font-semibold ${totalRealizedToday >= 0 ? "text-gain" : "text-loss"}`}>
              {totalRealizedToday >= 0 ? "+" : ""}{fmt(totalRealizedToday)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">Margin Committed</span>
            <span className="n font-semibold">{fmt(totalMargin)}</span>
          </div>
        </div>
      </div>

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

      <div className="rounded-[14px] overflow-hidden" style={{ border: "1px solid var(--c-line)" }}>
        {sorted.length === 0 ? (
          <p className="text-[12px] text-muted py-6 text-center">No {filter} positions.</p>
        ) : (
          sorted.map((p, i) => (
            <MobilePositionRow key={p.id} p={p} hideAmounts={hideAmounts} isFirst={i === 0} />
          ))
        )}
      </div>
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
    <div className="sm:hidden">
      <div className="rounded-[16px] p-4 mb-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
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
                className="rounded-[8px] py-1 flex flex-col items-center justify-center gap-0.5"
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

      <div className="rounded-[16px] p-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
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
        <td className="py-2 pr-2 text-[10.5px] font-semibold" style={{ color: p.execution_mode === "AUTO" ? "var(--c-loss)" : "var(--c-faint)" }}>
          {p.execution_mode === "AUTO" ? "LIVE" : "PAPER"}
        </td>
        <td className="py-2 pr-2 text-[11px]">{p.expiry}</td>
        <td className="py-2 pr-2 text-[11px] n">{formatDateTime(p.created_at) ?? "—"}</td>
        <td className="py-2 pr-2 text-[11px] n">{p.status !== "ACTIVE" ? (formatDateTime(p.updated_at) ?? "—") : "—"}</td>
        <td className="py-2 pr-2 text-right n">{p.lots}</td>
        <td className="py-2 pr-2 text-right n">{inr(p.net_credit)}</td>
        <td className="py-2 pr-2 text-right n text-gain">{inr(p.max_profit)}</td>
        <td className="py-2 pr-2 text-right n text-loss">{inr(p.max_loss)}</td>
        <td className="py-2 pr-2 text-right n">{p.margin_required != null ? inr(p.margin_required) : "—"}</td>
        <td className="py-2 pr-2"><ScoreBadge score={Math.round(p.quality_score ?? 0)} /></td>
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
      {expanded && (
        <tr>
          <td colSpan={14} className="px-3 pb-3" style={{ background: "var(--c-surface-2)" }}>
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
  const [showAllModes, setShowAllModes] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/options-autotrade?resource=settings").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=positions").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=log").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=daily-stats").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=real-funds").then((r) => r.json()),
    ])
      .then(([s, posBody, logBody, dailyBody, fundsBody]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSettings(s);
        setDraft((d) => ({ ...d, ...s }));
        setPositions({ active: posBody.active ?? [], closed: posBody.closed ?? [] });
        setLogEntries(logBody.entries ?? []);
        setDailyStats(dailyBody);
        setRealFunds(fundsBody);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

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

  // Covers a page load/refresh landing directly on an already-AUTO
  // account, not just the moment the switch is flipped from here.
  useEffect(() => {
    if (settings?.execution_mode !== "AUTO") return;
    try {
      if (document.documentElement.getAttribute("data-theme") !== "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem("thetalab-theme", "dark");
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
      const confirmed = window.confirm(
        "This places REAL orders on your real Zerodha account with real money — not a simulation.\n\n" +
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

  const timeline = [
    ...logEntries.map((e) => ({ time: e.created_at, level: e.level, message: e.message })),
  ].slice(0, 30);

  return (
    <div className="p-4 pb-20 sm:pb-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <ChartLineUp size={16} weight="bold" className="text-accent" />
          <h1 className="text-[16px] font-bold">Options Auto-Trader</h1>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px]"
            style={
              settings?.execution_mode === "AUTO"
                ? { background: "var(--c-loss-soft)", color: "var(--c-loss)" }
                : settings?.execution_mode === "PAPER"
                ? { background: "var(--c-gain-soft, #16a34a22)", color: "var(--c-gain)" }
                : { background: "var(--c-surface-2)", color: "var(--c-faint)" }
            }
          >
            {settings?.execution_mode ?? "…"}
          </span>
        </div>
        <button
          onClick={triggerKillSwitch} disabled={killSwitchBusy}
          className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-[8px]"
          style={{ background: "var(--c-loss-soft, #dc262622)", color: "var(--c-loss)", border: "1px solid var(--c-loss)" }}
          title="Stops new entries only — position-monitor's own exit engine still evaluates and closes open positions independently"
        >
          <HandPalm size={13} weight="bold" />
          {killSwitchBusy ? "Stopping…" : "Kill Switch"}
        </button>
      </div>
      <button onClick={() => setDescOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-muted mb-2">
        <Info size={12} weight="regular" />
        What is this?
        {descOpen ? <CaretUp size={11} /> : <CaretDown size={11} />}
      </button>
      {descOpen && (
        <p className="text-[11px] text-muted mb-3 max-w-[80ch]">
          Defined-risk options selling (Iron Condor / Bull Put Spread / Bear Call Spread), decided from a live chain: skew-based
          strategy selection, strike optimization ranked by expected value per unit of risk, expiry selection, and a 0-100 trade
          quality score gate. Runs on its own 30-minute cron against live Kite data — this page only displays the result, it
          doesn't trigger a scan. PAPER mode only: no real order is ever placed.
        </p>
      )}

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
        <button onClick={() => setSettingsOpen((v) => !v)} className="w-full flex items-center gap-3 sm:flex-wrap p-3 text-left">
          <Wallet size={15} weight="bold" className={settings?.execution_mode === "AUTO" ? "text-loss shrink-0" : "text-muted shrink-0"} />
          <span className="text-[11.5px] font-semibold">{settings?.execution_mode === "AUTO" ? "Live Execution" : "Paper Execution"}</span>
          <span className="hidden sm:inline text-[10.5px] text-faint">Reserved fund {inr(settings?.reserved_fund ?? 0)}</span>
          <span className="hidden sm:inline text-[10.5px] text-faint flex-1">
            {settings?.execution_mode === "AUTO"
              ? "REAL orders are placed on your Zerodha account the moment a candidate clears the quality gate."
              : settings?.execution_mode === "PAPER" ? "Passing candidates auto-open paper positions on the 30-min scan." : "Scans still run and log a decision, but no paper positions are opened."}
          </span>
          <span className="flex-1 sm:hidden" />
          {settingsOpen ? <CaretUp size={14} className="text-muted shrink-0" /> : <CaretDown size={14} className="text-muted shrink-0" />}
          <Gear size={14} weight="bold" className="text-muted shrink-0" />
        </button>

        {settingsOpen && (
          <div className="px-3 pb-3 pt-1" style={{ borderTop: "1px solid var(--c-line)" }}>
            <div className="flex items-center gap-3 flex-wrap py-2.5">
              <span className="text-[11px] font-semibold text-muted">Execution Mode</span>
              <div className="seg-track">
                {["OFF", "PAPER", "AUTO"].map((mode) => (
                  <button key={mode} role="tab" aria-selected={settings?.execution_mode === mode} data-on={settings?.execution_mode === mode}
                    onClick={() => setExecutionMode(mode)} disabled={saving} className="seg"
                    style={mode === "AUTO" && settings?.execution_mode === "AUTO" ? { color: "var(--c-loss)" } : undefined}>
                    {mode}
                  </button>
                ))}
              </div>
              {settings?.execution_mode === "AUTO" ? (
                <span className="text-[10.5px] font-semibold px-2 py-1 rounded-[6px]" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>
                  REAL MONEY — real orders are placed on your Zerodha account
                </span>
              ) : (
                <span className="text-[10.5px] text-faint px-2 py-1 rounded-[6px]" style={{ background: "var(--c-surface-2)" }}>
                  ALERT_ONLY/SEMI_AUTO aren't built yet
                </span>
              )}
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
          {settings?.execution_mode === "AUTO" && (
            <div className="flex items-center gap-3 flex-wrap mb-3 p-3 rounded-[12px]" style={{ border: "1px solid var(--c-loss)", background: "var(--c-loss-soft)" }}>
              <span className="text-[11px] font-semibold text-loss">REAL ACCOUNT BALANCE</span>
              <span className="text-[15px] font-bold n text-loss">
                {realFunds?.availableFunds != null ? inr(realFunds.availableFunds) : realFunds?.skipped === "no_kite_session" ? "No Kite session" : "—"}
              </span>
              {realFunds?.utilised != null && <span className="text-[10.5px] text-ink2">({inr(realFunds.utilised)} utilised)</span>}
              <label className="flex items-center gap-1.5 text-[10.5px] text-ink2 ml-auto">
                <input type="checkbox" checked={showAllModes} onChange={(e) => setShowAllModes(e.target.checked)} />
                Show PAPER history too
              </label>
            </div>
          )}

          <div className="hidden sm:grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-4">
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Open Positions</div>
              <div className="text-[14px] font-bold n">{visiblePositions.active.length} <span className="text-faint font-normal text-[11px]">/ {settings?.max_positions ?? "—"} max</span></div>
            </div>
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Margin Committed</div>
              <div className="text-[14px] font-bold n">{inr(visiblePositions.active.reduce((s, p) => s + (Number(p.margin_required) || 0), 0))}</div>
            </div>
            <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <div className="text-[11px] text-muted mb-0.5">Max Loss at Risk</div>
              <div className={`text-[14px] font-bold n ${visiblePositions.active.length ? "text-loss" : ""}`}>{inr(visiblePositions.active.reduce((s, p) => s + (Number(p.max_loss) || 0), 0))}</div>
            </div>
          </div>

          {visiblePositions.active.length === 0 && visiblePositions.closed.length === 0 ? (
            <p className="text-[12.5px] text-muted py-6 text-center">
              {settings?.execution_mode === "AUTO" && !showAllModes
                ? "No AUTO (real) positions yet — the 30-min scan opens one automatically once a candidate clears the quality threshold."
                : "No paper positions yet — the 30-min scan opens one automatically once a candidate clears the quality threshold."}
            </p>
          ) : mobileTab === "activity" ? null : mobileTab === "calendar" ? (
            <PnLCalendar positions={visiblePositions} hideAmounts={hideAmounts} />
          ) : (
            <MobilePortfolio positions={visiblePositions} hideAmounts={hideAmounts} setHideAmounts={setHideAmounts} />
          )}

          <h2 className="hidden sm:block text-[13px] font-bold mb-2">
            {settings?.execution_mode === "AUTO" ? "Live Positions" : "Paper Positions"} {visiblePositions.active.length > 0 ? <span className="font-normal text-muted">({visiblePositions.active.length} open)</span> : null}
          </h2>
          {visiblePositions.active.length === 0 && visiblePositions.closed.length === 0 ? null : (
            <div className="hidden sm:block overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-3 pr-2">Symbol / Strategy</th>
                    <th className="font-medium py-2 pr-2">Mode</th>
                    <th className="font-medium py-2 pr-2">Expiry</th>
                    <th className="font-medium py-2 pr-2">Entry</th>
                    <th className="font-medium py-2 pr-2">Exit</th>
                    <th className="font-medium py-2 pr-2 text-right">Lots</th>
                    <th className="font-medium py-2 pr-2 text-right">Net Credit</th>
                    <th className="font-medium py-2 pr-2 text-right">Max Profit</th>
                    <th className="font-medium py-2 pr-2 text-right">Max Loss</th>
                    <th className="font-medium py-2 pr-2 text-right">Margin</th>
                    <th className="font-medium py-2 pr-2">Score</th>
                    <th className="font-medium py-2 pr-2">Status</th>
                    <th className="font-medium py-2 pr-2 text-right">Unrealized P&L</th>
                    <th className="font-medium py-2 pr-3 text-right">Realized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...visiblePositions.active, ...visiblePositions.closed].map((p) => <PositionRow key={p.id} p={p} />)}
                </tbody>
              </table>
            </div>
          )}

          {/* Desktop always shows the log inline; on mobile it moved to its
              own bottom-nav tab (see mobileTab === "activity" below), since
              there's no room to show portfolio/calendar AND a log at once
              on a phone screen. */}
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
        <button onClick={() => setMobileTab("portfolio")} className="flex-1 flex flex-col items-center gap-0.5 py-2"
          style={{ color: mobileTab === "portfolio" ? "var(--c-accent)" : "var(--c-muted)" }}>
          <Wallet size={18} weight={mobileTab === "portfolio" ? "fill" : "regular"} />
          <span className="text-[10px] font-medium">Portfolio</span>
        </button>
        <button onClick={() => setMobileTab("calendar")} className="flex-1 flex flex-col items-center gap-0.5 py-2"
          style={{ color: mobileTab === "calendar" ? "var(--c-accent)" : "var(--c-muted)" }}>
          <CalendarBlank size={18} weight={mobileTab === "calendar" ? "fill" : "regular"} />
          <span className="text-[10px] font-medium">Calendar</span>
        </button>
        <button onClick={() => setMobileTab("activity")} className="flex-1 flex flex-col items-center gap-0.5 py-2"
          style={{ color: mobileTab === "activity" ? "var(--c-accent)" : "var(--c-muted)" }}>
          <Bell size={18} weight={mobileTab === "activity" ? "fill" : "regular"} />
          <span className="text-[10px] font-medium">Activity</span>
        </button>
      </div>
    </div>
  );
}
