import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChartLineUp, Info, Wallet, Gear, CaretDown, CaretUp, CaretLeft, CaretRight, Shield, Bell, Eye, EyeSlash, CalendarBlank, ListBullets } from "@phosphor-icons/react";
import { inr, toneClass, scoreTone, scoreLabel } from "./swingFormat.js";
import { kiteLoginUrl } from "../lib/kiteClient.js";

const POLL_MS = 60_000; // this dashboard only reads already-computed state (settings/positions/log) — the live chain fetch itself runs on its own 30-min cron, not on this poll

const STATUS_TONE = { ACTIVE: "muted", CLOSED: "muted", FAILED: "loss", CLOSE_FAILED: "loss" };

const INDEX_LABEL = { NIFTY: "NIFTY 50", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX" };

// AUTO is deliberately NOT red — red is reserved for loss/danger/kill-switch
// states (see the redesign's color rules). AUTO gets a solid indigo fill
// instead: distinct enough from SHADOW's soft indigo tint to read as the
// "armed, live" state, without borrowing the alarm color normal broker
// capital and mode badges must never wear.
const MODE_COLOR = {
  OFF: { fg: "var(--c-faint)", bg: "var(--c-surface-3)" },
  PAPER: { fg: "var(--c-gain)", bg: "var(--c-gain-soft)" },
  SHADOW: { fg: "var(--c-accent)", bg: "var(--c-accent-soft)" },
  AUTO: { fg: "var(--c-accent-ink)", bg: "var(--c-accent)" },
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
    <div className="oat-glass hidden sm:flex items-center gap-1 flex-wrap px-3 py-2 mb-3 rounded-[var(--radius-md)] sm:order-[20]">
      <span className="live-dot shrink-0" aria-hidden="true" />
      {rows.map((idx, i) => {
        const positive = (idx.change ?? 0) >= 0;
        return (
          <div key={idx.symbol} className="flex items-baseline gap-1.5 px-2.5 py-0.5" style={{ borderLeft: i > 0 ? "1px solid var(--c-line)" : "none" }}>
            <span className="text-[11px] font-semibold text-muted tracking-wide">{INDEX_LABEL[idx.symbol] ?? idx.symbol}</span>
            <AnimatePresence mode="wait">
              <motion.span key={idx.lastPrice} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="text-[13.5px] font-bold n">
                {idx.lastPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </motion.span>
            </AnimatePresence>
            <span className={`text-[10.5px] font-semibold n flex items-center gap-0.5 ${positive ? "text-gain" : "text-loss"}`}>
              {positive ? "▲" : "▼"} {Math.abs(idx.change ?? 0).toFixed(2)} ({Math.abs(idx.changePct ?? 0).toFixed(2)}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Mobile-only single-line ticker — rather than stacking NIFTY/BANKNIFTY/
 * SENSEX as three lines (too much vertical space on a small screen), this
 * shows exactly one index at a time and auto-advances to the next every
 * 3.5s with a vertical slide + crossfade. Same `indices` data as
 * MarketStrip (desktop keeps the all-at-once strip); this is presentation
 * only — no new data, no polling change.
 */
function RotatingTicker({ indices }) {
  const [i, setI] = useState(0);
  const rows = (indices ?? []).filter((idx) => idx.lastPrice != null);
  useEffect(() => {
    if (rows.length < 2) return;
    const t = setInterval(() => setI((v) => (v + 1) % rows.length), 3500);
    return () => clearInterval(t);
  }, [rows.length]);
  if (!rows.length) return null;
  const idx = rows[i % rows.length];
  const positive = (idx.change ?? 0) >= 0;
  return (
    <div className="sm:hidden flex items-center gap-1.5 px-3 py-2 mb-2.5 rounded-[var(--radius-md)] overflow-hidden order-[5]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <span className="live-dot shrink-0" aria-hidden="true" />
      <div className="relative h-[18px] flex-1 min-w-0 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={idx.symbol}
            initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 flex items-baseline gap-1.5"
          >
            <span className="text-[11px] font-semibold text-muted tracking-wide shrink-0">{INDEX_LABEL[idx.symbol] ?? idx.symbol}</span>
            <span className="text-[13px] font-bold n shrink-0">{idx.lastPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
            <span className={`text-[10.5px] font-semibold n flex items-center gap-0.5 shrink-0 ${positive ? "text-gain" : "text-loss"}`}>
              {positive ? "▲" : "▼"} {Math.abs(idx.change ?? 0).toFixed(2)} ({Math.abs(idx.changePct ?? 0).toFixed(2)}%)
            </span>
          </motion.div>
        </AnimatePresence>
      </div>
      {rows.length > 1 && (
        <div className="flex items-center gap-1 shrink-0" aria-hidden="true">
          {rows.map((_, d) => (
            <span key={d} className="rounded-full" style={{ width: 3, height: 3, background: d === i % rows.length ? "var(--c-accent)" : "var(--c-line-2)" }} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Independent PAPER/SHADOW/AUTO execution profiles (migration 019) — a
 * KITE/GROWW-style segmented tab selector picks WHICH profile the rest of
 * the page (Today's P&L, Open Positions, Activity) is currently showing —
 * viewing AUTO shows only AUTO's own activity, never mixed with SHADOW's
 * even if both are enabled. Just a bare on/off switch next to the tabs —
 * no separate card, no label text next to it (a label whose width changes
 * between "ON"/"OFF" was shifting the whole switch sideways on toggle,
 * which read as the knob "going out" — removed rather than padded around).
 * Switching tabs never changes what's enabled; the switch only ever
 * affects the currently-selected tab.
 */
function ExecutionProfilesPanel({ selectedProfile, setSelectedProfile, enabledProfiles, setProfileEnabled, saving, dailyStatsByMode }) {
  const enabled = enabledProfiles.includes(selectedProfile);
  const locked = !!dailyStatsByMode[selectedProfile]?.locked;
  const color = MODE_COLOR[selectedProfile];

  return (
    <div className="flex items-center gap-2 flex-wrap py-2 mb-3 order-[40]">
      <span className="text-[10.5px] font-semibold text-muted shrink-0">Profile</span>
      <div className="seg-track">
        {["PAPER", "SHADOW", "AUTO"].map((p) => (
          <button key={p} role="tab" aria-selected={selectedProfile === p} data-on={selectedProfile === p}
            onClick={() => setSelectedProfile(p)} className="seg inline-flex items-center gap-1">
            {p}
            {enabledProfiles.includes(p) && <span className="live-dot" style={{ background: "currentColor" }} aria-hidden="true" />}
          </button>
        ))}
      </div>
      {locked && (
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "var(--c-warn-soft)", color: "var(--c-warn)" }}>LOCKED</span>
      )}
      <motion.button
        whileTap={{ scale: 0.94 }}
        onClick={() => setProfileEnabled(selectedProfile, !enabled)}
        disabled={saving} role="switch" aria-checked={enabled}
        aria-label={`Turn ${selectedProfile} ${enabled ? "off" : "on"}`}
        // Flexbox alignment slides the knob, not an absolute-positioned
        // transform against an assumed track width — the knob (16px) can
        // never render outside a 30px flex content box (34px track minus
        // 2px padding each side) no matter what else on the page affects
        // sizing, unlike the previous x-translate version which could
        // overflow if the track's rendered width ever drifted from the
        // 34px this component assumed.
        className="inline-flex items-center shrink-0 rounded-full p-[2px] box-border"
        style={{
          width: 34, height: 20,
          justifyContent: enabled ? "flex-end" : "flex-start",
          background: enabled ? (selectedProfile === "AUTO" ? `linear-gradient(135deg, var(--oat-accent), var(--oat-accent-2))` : color.bg) : "var(--c-surface-3)",
          border: enabled ? "none" : "1px solid var(--c-line)",
        }}
      >
        <motion.span layout transition={{ type: "spring", stiffness: 500, damping: 32 }}
          className="rounded-full shadow-sm" style={{ width: 16, height: 16, background: "#fff" }} />
      </motion.button>
    </div>
  );
}

/**
 * Mobile-only top utility row — surfaces the broker toggle and connection
 * health BEFORE the page title, since on a small screen "which broker/
 * account am I about to trade real money on" is the first thing worth
 * confirming. Same setActiveBroker/connectGroww handlers as the desktop
 * BrokerCapitalCard's left side, just the top-of-screen presentation.
 */
function MobileBrokerBar({ settings, growwStatus, growwConnecting, connectGroww, kiteStatus, setActiveBroker, saving }) {
  const activeBroker = settings?.active_broker ?? "KITE";
  const isGroww = activeBroker === "GROWW";
  // KITE's server-side session (kite_session, read via resource=kite-status)
  // is completely separate from Groww's — a real connected/not-connected
  // check either way, not just shown for Groww.
  const connected = isGroww ? growwStatus?.connected : kiteStatus?.connected;
  return (
    <div className="sm:hidden flex items-center gap-2 flex-wrap py-1.5 mb-2 order-[10]">
      <div className="seg-track">
        {["KITE", "GROWW"].map((broker) => (
          <button key={broker} role="tab" aria-selected={activeBroker === broker} data-on={activeBroker === broker}
            onClick={() => setActiveBroker(broker)} disabled={saving} className="seg" style={{ minHeight: 32 }}>
            {broker}
          </button>
        ))}
      </div>
      <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold px-2 py-1 rounded-full"
        style={{ background: connected ? "var(--c-gain-soft)" : "var(--c-warn-soft)", color: connected ? "var(--c-gain)" : "var(--c-warn)" }}>
        <span className="live-dot" style={{ background: connected ? "var(--c-gain)" : "var(--c-warn)" }} aria-hidden="true" />
        {connected ? "Connected" : "Not connected"}
      </span>
      {isGroww ? (
        <button onClick={connectGroww} disabled={growwConnecting} className="topstep text-[10.5px] ml-auto" style={{ minHeight: 32 }}>
          {growwConnecting ? "Connecting…" : connected ? "Reconnect" : "Connect"}
        </button>
      ) : (
        <a href={kiteLoginUrl()} className="topstep text-[10.5px] ml-auto" style={{ minHeight: 32 }}>
          {connected ? "Reconnect" : "Connect"}
        </a>
      )}
    </div>
  );
}

/**
 * Utility Bar — broker connection + execution mode + settings trigger, all
 * as one slim, flat, low-visual-weight row. Replaces what used to be two
 * separate large cards (a standalone Execution Mode card, and a
 * BrokerCapitalCard combining broker connection with a big "Live Broker
 * Capital" panel): operational controls that aren't the reason the user
 * opened this page shouldn't out-weigh the portfolio/positions content
 * below them. Live capital itself now lives inside RiskCommandBar as one
 * more metric alongside P&L/margin/risk, not a separate showcase panel.
 * Desktop only — mobile keeps its own MobileBrokerBar (top) + compact
 * execution-mode row, already tuned for a small screen's different
 * information order.
 */
function UtilityBar({
  settings, growwStatus, growwConnecting, connectGroww, kiteStatus, setActiveBroker, saving,
  enabledProfiles, settingsOpen, setSettingsOpen, showAllModes, setShowAllModes,
}) {
  const [brokerInfoOpen, setBrokerInfoOpen] = useState(false);
  const activeBroker = settings?.active_broker ?? "KITE";
  const isGroww = activeBroker === "GROWW";
  // KITE's server-side session (kite_session, read via resource=kite-status)
  // is completely separate from Groww's — show a real connected/not-
  // connected state either way, not just for Groww.
  const brokerStatus = isGroww ? growwStatus : kiteStatus;
  const connected = brokerStatus?.connected;

  return (
    <div className="hidden sm:block sm:order-[30] mb-3">
      <div className="oat-glass flex items-center gap-4 flex-wrap py-2 px-3 rounded-[var(--radius-md)]">
        {/* Broker */}
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-semibold text-muted shrink-0">Broker</span>
          <div className="seg-track">
            {["KITE", "GROWW"].map((broker) => (
              <button key={broker} role="tab" aria-selected={activeBroker === broker} data-on={activeBroker === broker}
                onClick={() => setActiveBroker(broker)} disabled={saving} className="seg">
                {broker}
              </button>
            ))}
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold px-2 py-0.5 rounded-full"
            style={{ background: connected ? "var(--c-gain-soft)" : "var(--c-warn-soft)", color: connected ? "var(--c-gain)" : "var(--c-warn)" }}>
            <span className="live-dot" style={{ background: connected ? "var(--c-gain)" : "var(--c-warn)" }} aria-hidden="true" />
            {connected ? "Connected" : "Not connected"}
          </span>
          {connected && brokerStatus?.obtainedAt && (
            <span className="text-[10.5px] text-faint">synced {agoLabel(brokerStatus.obtainedAt)}</span>
          )}
          {isGroww ? (
            <button onClick={connectGroww} disabled={growwConnecting} className="text-[10.5px] font-medium text-accent hover:opacity-70">
              {growwConnecting ? "Connecting…" : connected ? "Reconnect" : "Connect"}
            </button>
          ) : (
            <a href={kiteLoginUrl()} className="text-[10.5px] font-medium text-accent hover:opacity-70">
              {connected ? "Reconnect" : "Connect"}
            </a>
          )}
          {isGroww && growwStatus?.error && <span className="text-[10.5px] text-loss">{growwStatus.error}</span>}
          <button onClick={() => setBrokerInfoOpen((v) => !v)} className="text-faint hover:text-muted" aria-label="About broker routing" title="About broker routing">
            <Info size={12} weight="bold" />
          </button>
        </div>

        <div className="hidden lg:block w-px h-5" style={{ background: "var(--c-line)" }} />

        <div className="flex-1" />

        {enabledProfiles.length > 0 && (
          <label className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <input type="checkbox" checked={showAllModes} onChange={(e) => setShowAllModes(e.target.checked)} />
            Show other profiles
          </label>
        )}

        <button onClick={() => setSettingsOpen((v) => !v)} className="flex items-center gap-1.5 text-[11px] font-medium text-muted hover:text-ink">
          <Gear size={13} weight="bold" />
          Settings
          {settingsOpen ? <CaretUp size={11} /> : <CaretDown size={11} />}
        </button>
      </div>

      {brokerInfoOpen && (
        <p className="text-[10.5px] text-muted mt-1.5 px-1 max-w-[70ch] leading-relaxed">
          {isGroww
            ? "AUTO real orders route through Groww when selected — sized against Groww's real balance, protected by the same broker-reconciliation safety check as Kite."
            : "Kite supplies live market data and historical depth for every mode, and routes AUTO's real orders when selected as the active broker."}
        </p>
      )}
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
  {
    title: "Entry Filters", fields: [
      { key: "min_max_profit_rupees", label: "Min sized max profit (₹)", step: 100, min: 0,
        hint: "Skip a new entry if its max profit after lot sizing falls below this — too small isn't worth the risk/charges once a profit-target exit is factored in." },
      { key: "entry_window_start_minutes_ist", label: "No new entries before (min since IST midnight)", step: 5, min: 0, max: 900,
        hint: "585 = 09:45 IST. Existing positions still close normally regardless of this." },
    ],
  },
];

const DEFAULT_DRAFT = {
  reserved_fund: 0, max_risk_per_trade_pct: 2, max_daily_loss_pct: 4, max_weekly_loss_pct: 8,
  max_portfolio_risk_pct: 10, max_margin_utilization_pct: 60, max_positions: 5,
  max_underlying_delta: 300, max_gamma: 50, max_vega: 5000, max_correlated_group_risk_pct: 6,
  no_trade_below: 70, watch_below: 80, high_conviction_at_or_above: 90, min_dte: 2, max_dte: 60,
  profit_target_pct: 50, stop_loss_credit_multiple: 2, time_exit_dte: 2, strike_breach_buffer_pct: 0,
  max_consecutive_losses: 3, min_max_profit_rupees: 2000, entry_window_start_minutes_ist: 585,
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

// A leg's own P&L, real either way — never an even split of the position
// total (that would fabricate a number this leg didn't actually produce).
// Closed: fill_price vs the leg's own recorded exit_fill_price, exact.
// Still open: fill_price vs last_quoted_price, the live price
// position-monitor's own re-quote pass persists per leg (same quote it
// already uses for the position-level unrealized_pnl) — null (shown as
// "—") until at least one re-quote pass has run since this leg opened.
function legPnl(l) {
  const exitPrice = l.exit_fill_price ?? l.last_quoted_price;
  if (exitPrice == null || l.fill_price == null) return null;
  return (l.side === "SELL" ? 1 : -1) * (Number(l.fill_price) - Number(exitPrice)) * Number(l.quantity);
}

function ActivityLog({ timeline }) {
  return (
    <>
      <h2 className="text-[13px] font-bold mt-5 mb-2.5">Activity Log</h2>
      {timeline.length === 0 ? (
        <p className="text-[12.5px] text-muted py-6 text-center">No activity yet.</p>
      ) : (
        <div className="oat-timeline flex flex-col gap-3 pl-1">
          {timeline.map((e, i) => {
            const isError = e.level === "error";
            return (
              <motion.div key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18, delay: Math.min(i, 8) * 0.02, ease: [0.2, 0.8, 0.2, 1] }}
                className="flex items-start gap-3">
                <span className="oat-timeline-dot shrink-0 mt-0.5" style={isError ? { borderColor: "var(--oat-danger)" } : undefined}>
                  <span style={{ width: 4, height: 4, borderRadius: "50%", background: isError ? "var(--oat-danger)" : "var(--c-muted)" }} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[10.5px] text-faint n shrink-0">{new Date(e.time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <span className={`text-[11.5px] ${isError ? "text-loss" : "text-ink2"}`}>{e.message}</span>
                </div>
              </motion.div>
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
    <div>
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold n" style={{ color }}>
        {s}
        <span className="text-[9.5px] font-bold tracking-wide opacity-80">{scoreLabel(s)}</span>
      </span>
      <div className="oat-score-bar mt-1 w-[42px]">
        <span style={{ width: `${Math.min(100, Math.max(0, s))}%`, background: color }} />
      </div>
    </div>
  );
}

/** ACTIVE gets a small live dot; anything closed gets a muted status word — color is never the only signal (text is always present too). */
/** Quiet glyph for a closed position's exit reason — purely a label prefix,
 * derived from the exact same exitReason string already shown as text, so
 * an unrecognized reason still displays correctly with no glyph rather
 * than a guessed one. */
function exitGlyph(exitReason) {
  if (!exitReason) return null;
  if (exitReason.includes("PROFIT")) return "✓ ";
  if (exitReason.includes("STOP_LOSS") || exitReason.includes("BREACH")) return "× ";
  if (exitReason.includes("TIME_EXIT") || exitReason.includes("SESSION_END") || exitReason.includes("DATA_END")) return "◷ ";
  return null;
}

// The close DECISION is made off a live quote snapshot, then a real
// MARKET order fills moments later — on a fast-moving or thin chain
// those can genuinely disagree (confirmed live: position #39 closed on
// a PROFIT_TARGET signal, but the real closing fill came in worse than
// the quote it decided on, realizing an actual loss). exitReason
// describes why the system decided to close, not a promise about the
// outcome — realized_pnl is the only authoritative number. This just
// flags it visibly rather than letting "✓ PROFIT_TARGET" sit next to a
// real loss looking like a contradiction nobody explained.
function exitSlipped(exitReason, realizedPnl) {
  if (!exitReason || realizedPnl == null) return false;
  const favorable = exitReason.includes("PROFIT");
  const unfavorable = exitReason.includes("STOP_LOSS") || exitReason.includes("BREACH");
  if (favorable) return realizedPnl < 0;
  if (unfavorable) return realizedPnl > 0;
  return false;
}

function StatusMark({ status, exitReason, realizedPnl }) {
  if (status === "ACTIVE") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--c-gain)" }}>
        <span className="live-dot" style={{ background: "var(--c-gain)" }} aria-hidden="true" />
        Active
      </span>
    );
  }
  const slipped = exitSlipped(exitReason, realizedPnl);
  return (
    <span className={`text-[11px] ${toneClass(STATUS_TONE[status] ?? "muted")}`} style={status === "CLOSED" ? { opacity: 0.72 } : undefined}>
      {status}{exitReason ? ` · ${exitGlyph(exitReason) ?? ""}${exitReason}` : ""}
      {slipped && (
        <span title="Decided on a live quote, but the real closing fill came in worse than that quote — the actual P&L disagrees with this reason." className="text-loss font-semibold" style={{ opacity: 1 }}> ⚠ slipped on execution</span>
      )}
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
function RiskCommandBar({ positions, settings, hideAmounts, setHideAmounts, realFunds, growwRealFunds }) {
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const totalMargin = positions.active.reduce((s, p) => s + (Number(p.margin_required) || 0), 0);
  const totalUnrealized = positions.active.reduce((s, p) => s + (Number(p.unrealized_pnl) || 0), 0);
  const totalRealizedToday = positions.closed.filter((p) => p.exit_date === todayIST).reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0);
  // All-time realized across every closed position this view currently
  // holds (same list positions.closed already is — capped at the API's
  // 200 most recent closed rows, see PnLCalendar's own note on that same
  // limitation) + current unrealized on whatever's still open now.
  const totalRealizedAllTime = positions.closed.reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0);
  const totalReturns = totalRealizedAllTime + totalUnrealized;
  const maxLossAtRisk = positions.active.reduce((s, p) => s + (Number(p.max_loss) || 0), 0);
  const todaysPnl = totalUnrealized + totalRealizedToday;
  const fmt = (n) => (hideAmounts ? "••••••" : inr(n));
  // Mirrors executionProfiles.ts's derivation: once any toggle column is
  // explicitly set, it governs; otherwise falls back to the legacy single
  // execution_mode. (If AUTO and SHADOW are both enabled at once, this
  // still only drives ONE capital-display branch below — a full per-
  // profile "Today" card is a follow-up, not yet built.)
  const settingsHasToggles = settings?.paper_enabled != null || settings?.shadow_enabled != null || settings?.auto_enabled != null;
  const isLive = settingsHasToggles ? !!settings?.auto_enabled : settings?.execution_mode === "AUTO";
  const isShadow = settingsHasToggles ? !!settings?.shadow_enabled : settings?.execution_mode === "SHADOW";

  const isGrowwBroker = (settings?.active_broker ?? "KITE") === "GROWW";
  const activeRealFunds = isGrowwBroker ? growwRealFunds : realFunds;
  const capitalBase = isLive ? activeRealFunds?.availableFunds ?? null : Number(settings?.reserved_fund) || null;
  const riskPct = capitalBase && capitalBase > 0 ? (maxLossAtRisk / capitalBase) * 100 : null;
  const brokerCapital = isLive ? activeRealFunds?.availableFunds ?? null : null;
  const [expanded, setExpanded] = useState(false);

  // Everything past "Today" — collapsed by default on mobile (only
  // Today's P&L shows until the caret is tapped), always visible on
  // desktop (rendered a second time below via display:contents so it
  // stays real flex-row siblings, not wrapped in an extra box).
  const secondaryContent = (
    <>
      <div className="hidden sm:block w-px self-stretch" style={{ background: "var(--c-line)" }} />

      <div className="min-w-[140px]">
        <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-0.5">TOTAL RETURN</div>
        <div className={`font-display text-[20px] sm:text-[22px] font-bold n leading-none ${totalReturns >= 0 ? "text-gain" : "text-loss"}`}>
          {totalReturns >= 0 ? "+" : ""}{fmt(totalReturns)}
        </div>
      </div>

      <div className="hidden sm:block w-px self-stretch" style={{ background: "var(--c-line)" }} />

      <div className="grid grid-cols-2 sm:flex sm:items-center gap-x-6 gap-y-2.5 sm:gap-8 flex-1">
        <RiskMetric label="Realized" value={fmt(totalRealizedToday)} tone={totalRealizedToday >= 0 ? "gain" : "loss"} signed />
        <RiskMetric label="Unrealized" value={fmt(totalUnrealized)} tone={totalUnrealized >= 0 ? "gain" : "loss"} signed />
        <RiskMetric label="Margin Used" value={fmt(totalMargin)} />
        <RiskMetric label="Max Risk" value={fmt(maxLossAtRisk)} tone={positions.active.length ? "loss" : undefined} />
        {riskPct !== null && (
          <RiskMetric label="Risk Utilization" value={`${riskPct.toFixed(1)}%`} tone={riskPct > 80 ? "loss" : riskPct > 50 ? "warn" : "gain"} />
        )}
      </div>

      {isLive && brokerCapital != null && (
        <div className="oat-tile rounded-[var(--radius-md)] px-3.5 py-2.5 w-full sm:w-auto">
          <div className="text-[9.5px] font-semibold text-muted tracking-wide mb-0.5">LIVE CAPITAL</div>
          <div className="font-display text-[17px] font-bold n leading-tight text-ink">{fmt(brokerCapital)}</div>
          <span className="text-[9px] font-bold" style={{ color: "var(--oat-accent)" }}>{isGrowwBroker ? "GROWW" : "KITE"}</span>
        </div>
      )}
    </>
  );

  return (
    <div className="oat-hero rounded-[var(--radius-lg)] mb-4 px-4 py-4 sm:px-6 sm:py-5" style={{ border: "1px solid var(--c-line)", boxShadow: "var(--e-2)" }}>
      <div className="relative flex items-start sm:items-center gap-4 sm:gap-8 flex-wrap">
        <div className="min-w-[140px] flex-1 sm:flex-initial">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10.5px] font-semibold text-muted tracking-wide">TODAY</span>
            <motion.button whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.9 }} onClick={() => setHideAmounts((v) => !v)} className="text-muted" aria-label="Toggle amount visibility">
              {hideAmounts ? <EyeSlash size={13} weight="regular" /> : <Eye size={13} weight="regular" />}
            </motion.button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <AnimatePresence mode="wait">
              <motion.div key={hideAmounts ? "hidden" : todaysPnl} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                className={`font-display text-[32px] sm:text-[38px] font-bold n leading-none ${todaysPnl >= 0 ? "text-gain" : "text-loss"}`}>
                {todaysPnl >= 0 ? "+" : ""}{fmt(todaysPnl)}
              </motion.div>
            </AnimatePresence>
            {/* Mobile-only expand toggle — desktop always shows everything,
                nothing to collapse there. */}
            <motion.button
              onClick={() => setExpanded((v) => !v)}
              className="sm:hidden flex items-center justify-center shrink-0 text-muted"
              style={{ width: 30, height: 30, borderRadius: 999, background: "var(--c-surface-3)" }}
              aria-label={expanded ? "Hide portfolio details" : "Show portfolio details"}
              aria-expanded={expanded}
            >
              <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }} style={{ display: "flex" }}>
                <CaretDown size={14} weight="bold" />
              </motion.span>
            </motion.button>
          </div>
        </div>

        <div className="hidden sm:contents">{secondaryContent}</div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
            className="sm:hidden overflow-hidden"
          >
            <div className="flex items-start gap-4 flex-wrap pt-4 mt-1" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
              {secondaryContent}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative text-[10px] text-faint mt-3 pt-3" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
        {isLive ? "LIVE" : isShadow ? "SHADOW" : "PAPER"} positions ({positions.active.length}{settings?.max_positions ? ` / ${settings.max_positions} max` : ""})
      </div>
    </div>
  );
}

/** Shared risk/strategy parameter fields — rendered from two different
 * triggers (the mobile Settings accordion, and desktop's UtilityBar
 * "Settings" button) but the exact same fields/handlers either way. */
function SettingsFields({ draft, setField, saving, saveSettings }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      {EDITABLE_GROUPS.map((group) => (
        <div key={group.title} className="p-2.5 rounded-[var(--radius-sm)]" style={{ background: "var(--c-surface-2)" }}>
          <div className="text-[10.5px] font-semibold text-muted mb-1.5">{group.title}</div>
          <div className="flex flex-col gap-1.5">
            {group.fields.map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-2 text-[11px]" title={f.hint}>
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
      <div className="col-span-full flex items-center gap-2.5 mt-1">
        <button onClick={saveSettings} disabled={saving} className="topstep text-[11.5px]">{saving ? "Saving…" : "Save Settings"}</button>
        <span className="text-[10.5px] text-faint">Last saved values are pre-filled above — unsaved edits are only local until you click Save.</span>
      </div>
    </div>
  );
}

function RiskMetric({ label, value, tone, signed }) {
  const color = tone === "gain" ? "var(--c-gain)" : tone === "loss" ? "var(--c-loss)" : tone === "warn" ? "var(--c-warn)" : "var(--c-text)";
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
    <div className={`rounded-[var(--radius-md)] overflow-hidden ${isFirst ? "" : "mt-2.5"}`}
      style={{
        border: "1px solid var(--c-line)",
        background: isActive ? "var(--c-surface)" : "rgba(20,30,55,0.022)",
        boxShadow: isActive ? "inset 2px 0 0 rgba(10,143,98,0.4)" : "none",
      }}>
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
          <StatusMark status={p.status} exitReason={p.exit_reason} realizedPnl={p.realized_pnl} />
        </div>
        <div className="flex items-center justify-between gap-3 mt-2 pt-2" style={{ borderTop: "1px solid var(--c-line)" }}>
          <div className="flex items-baseline gap-2.5 text-[11px] min-w-0">
            {/* Trade-taken date is the primary visible date on mobile — far
                more relevant to "what's happening right now" than expiry
                during a quick scan. Expiry moves into the expanded detail
                grid below, still fully available, just not front-and-center. */}
            <span className="text-ink2 font-medium n truncate">Taken {formatDateTime(p.created_at) ?? "—"}</span>
            <span className="text-faint shrink-0">Credit <b className="text-ink2 font-semibold n">{fmt(p.net_credit)}</b></span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Sparkline seed={p.id} positive={positive} />
            {expanded ? <CaretUp size={12} className="text-faint" /> : <CaretDown size={12} className="text-faint" />}
          </div>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
            style={{ background: "var(--c-surface-2)", borderTop: "1px solid var(--c-line)" }}
          >
          <div className="px-3 pb-3">
          <div className="grid grid-cols-3 gap-2.5 pt-3 pb-3 text-[11px]">
            <div><span className="text-faint">Max Profit</span><div className="n font-semibold text-gain mt-0.5">{fmt(p.max_profit)}</div></div>
            <div><span className="text-faint">Max Loss</span><div className="n font-semibold text-loss mt-0.5">{fmt(p.max_loss)}</div></div>
            <div><span className="text-faint">Margin</span><div className="n font-semibold mt-0.5">{p.margin_required != null ? fmt(p.margin_required) : "—"}</div></div>
            <div><span className="text-faint">Score</span><div className="mt-0.5"><ScoreChip score={p.quality_score} /></div></div>
            <div><span className="text-faint">Expiry</span><div className="n font-medium mt-0.5">{p.expiry ?? "—"}</div></div>
            <div><span className="text-faint">Exit</span><div className="n font-medium mt-0.5">{!isActive ? (formatDateTime(p.updated_at) ?? "—") : "—"}</div></div>
          </div>

          {legs.length > 0 && (
            <div className="mb-3">
              <div className="text-[10.5px] font-semibold text-muted mb-1">Legs</div>
              <table className="w-full text-[11px]">
                <tbody>
                  {legs.map((l) => {
                    const pnl = legPnl(l);
                    const legPositive = (pnl ?? 0) >= 0;
                    return (
                      <tr key={l.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                        <td className="py-1 pr-2 font-medium">{l.side}</td>
                        <td className="py-1 pr-2">{l.strike}{l.option_right}</td>
                        <td className="py-1 pr-2 text-right n">{l.quantity}</td>
                        <td className="py-1 pr-2 text-right n">{fmt(l.fill_price)}</td>
                        <td className={`py-1 text-right n font-medium ${pnl == null ? "text-faint" : legPositive ? "text-gain" : "text-loss"}`}>
                          {pnl != null ? `${legPositive ? "+" : ""}${fmt(pnl)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Mobile positions list — Active and Closed are now separate BOTTOM-NAV
 * tabs (Portfolio shows active only, Trades shows closed only) rather
 * than a segmented switch within one screen, so this just renders
 * whichever single `list` it's handed, plus the sort control. No filter
 * state of its own anymore.
 */
function MobilePositionsList({ list, hideAmounts, emptyState }) {
  return (
    <div className="sm:hidden">
      {list.length === 0 ? emptyState : (
        list.map((p, i) => (
          <PositionCardMobile key={p.id} p={p} hideAmounts={hideAmounts} isFirst={i === 0} />
        ))
      )}
    </div>
  );
}

function EmptyState({ label, sub, live }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-[var(--radius-md)] py-9 px-5 text-center flex flex-col items-center gap-2"
      style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
    >
      <div className="w-9 h-9 rounded-full flex items-center justify-center mb-0.5" style={{ background: "var(--c-surface-3)" }}>
        <ChartLineUp size={16} weight="bold" className="text-faint" />
      </div>
      <p className="text-[13px] font-semibold text-ink">{label}</p>
      {sub && <p className="text-[11.5px] text-muted max-w-[42ch] leading-relaxed">{sub}</p>}
      {live && (
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-muted mt-1">
          <span className="live-dot" style={{ background: "var(--c-gain)" }} aria-hidden="true" />
          Scanner live — monitoring for candidates
        </span>
      )}
    </motion.div>
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
  // Only cells actually IN this month (the 42-cell grid pads with a few
  // leading/trailing days from the adjacent months so every week row is
  // full) — those padding days must not leak into this month's total.
  const monthTrades = grid.filter((c) => c.inMonth).reduce((s, c) => s + c.trades.length, 0);
  const monthTotal = grid.filter((c) => c.inMonth).reduce((s, c) => s + c.pnl, 0);

  const selectedCell = grid.find((c) => c.key === selected) ?? { key: selected, trades: byDay[selected] ?? [], pnl: (byDay[selected] ?? []).reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0) };
  const selectedLabel = new Date(selected + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="sm:flex sm:gap-4 sm:items-start">
      <div className="sm:w-[360px] sm:shrink-0 rounded-[var(--radius-lg)] p-4 mb-3 sm:mb-0" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <div className="flex items-center gap-1 mb-1">
          <button onClick={() => shiftMonth(-1)} className="topstep !px-2" aria-label="Previous month"><CaretLeft size={12} weight="bold" /></button>
          <span className="text-[13px] font-semibold flex-1 text-center n">{monthTitle}</span>
          <button onClick={() => shiftMonth(1)} className="topstep !px-2" aria-label="Next month"><CaretRight size={12} weight="bold" /></button>
        </div>

        <div className="flex items-center justify-center gap-1.5 mb-3">
          <span className="text-[10.5px] text-muted">Month total</span>
          <span className={`text-[13px] font-bold n ${monthTrades === 0 ? "text-faint" : monthTotal >= 0 ? "text-gain" : "text-loss"}`}>
            {monthTrades === 0 ? "—" : `${monthTotal >= 0 ? "+" : ""}${fmt(monthTotal)}`}
          </span>
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
function PositionRow({ p, onClosed }) {
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);
  const legs = p.options_autotrade_legs ?? [];
  const modeColor = MODE_COLOR[p.execution_mode] ?? MODE_COLOR.PAPER;
  const pnl = p.status === "ACTIVE" ? p.unrealized_pnl : p.realized_pnl;
  const rr = p.max_loss > 0 && p.max_profit != null ? p.max_profit / p.max_loss : null;

  const closeManually = () => {
    const warning = p.execution_mode === "AUTO"
      ? `This places REAL closing orders on ${p.broker ?? "your broker"} for every leg of position #${p.id} (${p.symbol} ${p.strategy_label}). If you've already closed a leg manually in Kite/Groww, do that check first — this will still try to close ALL legs. Continue?`
      : `Close position #${p.id} (${p.symbol} ${p.strategy_label}, ${p.execution_mode}) now? This only updates this dashboard's own record — there's no real broker position to touch in ${p.execution_mode} mode.`;
    if (!window.confirm(warning)) return;
    setClosing(true);
    setCloseError(null);
    fetch("/api/options-autotrade?resource=manual-close", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionId: p.id }),
    })
      .then((r) => r.json())
      .then((body) => {
        if (body?.error) { setCloseError(body.message || body.error); return; }
        if (body?.ok === false) { setCloseError(body.message || "Close failed — check the broker directly."); }
        onClosed?.();
      })
      .catch((e) => setCloseError(e.message))
      .finally(() => setClosing(false));
  };

  return (
    <>
      <tr style={{ borderTop: "1px solid var(--c-line)" }} className="oat-row" data-selected={expanded} data-status={p.status === "ACTIVE" ? "active" : "closed"}>
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
          {/* Trade-taken date is primary here (bold, dark) — far more
              relevant to a quick scan of "what's happening" than expiry;
              expiry is still right here, just visually secondary. */}
          <div className="n font-medium text-ink">{formatDateTime(p.created_at) ?? "—"}</div>
          <div className="text-[10px] text-faint n">Exp {p.expiry ?? "—"}</div>
        </td>
        <td className="py-2.5 pr-3 text-right">
          <div className="n text-[11.5px]">{inr(p.net_credit)}</div>
          <div className="text-[10px] n"><span className="text-gain">{inr(p.max_profit)}</span> <span className="text-faint">/</span> <span className="text-loss">{inr(p.max_loss)}</span></div>
        </td>
        <td className="py-2.5 pr-3 text-right text-[11.5px] n">{p.margin_required != null ? inr(p.margin_required) : "—"}</td>
        <td className="py-2.5 pr-3 text-[11.5px] n">{rr !== null ? `1 : ${rr.toFixed(2)}` : "—"}</td>
        <td className="py-2.5 pr-3"><ScoreChip score={p.quality_score} /></td>
        <td className="py-2.5 pr-3"><StatusMark status={p.status} exitReason={p.exit_reason} realizedPnl={p.realized_pnl} /></td>
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
                    {legs.map((l) => {
                      const legP = legPnl(l);
                      const legPositive = (legP ?? 0) >= 0;
                      return (
                        <tr key={l.id}>
                          <td className="py-0.5 pr-2 font-medium">{l.side}</td>
                          <td className="py-0.5 pr-2">{l.strike}{l.option_right}</td>
                          <td className="py-0.5 pr-2 text-faint n">{l.tradingsymbol}</td>
                          <td className="py-0.5 pr-2 text-right n">{l.quantity}</td>
                          <td className="py-0.5 pr-2 text-right n">{inr(l.fill_price)}</td>
                          <td className={`py-0.5 pr-2 text-right n font-medium ${legP == null ? "text-faint" : legPositive ? "text-gain" : "text-loss"}`}>
                            {legP != null ? `${legPositive ? "+" : ""}${inr(legP)}` : "—"}
                          </td>
                          <td className="py-0.5 text-[10px] text-faint">{l.status}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="text-[10.5px] font-semibold text-muted mb-1">Decision Explanation</div>
                <pre className="text-[10.5px] text-ink2 whitespace-pre-wrap font-sans">{p.decision_explanation ?? "—"}</pre>
                {p.status === "ACTIVE" && (
                  <div className="mt-2">
                    <button
                      onClick={closeManually}
                      disabled={closing}
                      className="text-[10.5px] font-semibold px-2 py-1 rounded-[4px]"
                      style={{ background: "var(--c-loss-bg, #fde8e8)", color: "var(--c-loss, #b42318)" }}
                    >
                      {closing ? "Closing…" : p.execution_mode === "AUTO" ? "Close manually (real order)" : "Close manually"}
                    </button>
                    {closeError && <div className="text-[10px] text-loss mt-1">{closeError}</div>}
                  </div>
                )}
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
  const [dailyStatsByMode, setDailyStatsByMode] = useState({ PAPER: null, SHADOW: null, AUTO: null });
  const [clearingLock, setClearingLock] = useState(false);
  const [mobileTab, setMobileTab] = useState("portfolio"); // portfolio | trades | calendar | activity
  const [hideAmounts, setHideAmounts] = useState(false);
  const [realFunds, setRealFunds] = useState(null);
  const [growwRealFunds, setGrowwRealFunds] = useState(null);
  const [showAllModes, setShowAllModes] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState("PAPER");
  const [indices, setIndices] = useState([]);
  const [showDesktopCalendar, setShowDesktopCalendar] = useState(false);
  const [growwStatus, setGrowwStatus] = useState(null);
  const [kiteStatus, setKiteStatus] = useState(null);
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
      fetch("/api/options-autotrade?resource=kite-status").then((r) => r.json()),
      // One per profile (migration 019 gave daily_stats an execution_mode
      // dimension) — each profile's own card shows its own P&L/lock state,
      // never a shared one.
      fetch("/api/options-autotrade?resource=daily-stats&mode=PAPER").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=daily-stats&mode=SHADOW").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=daily-stats&mode=AUTO").then((r) => r.json()),
    ])
      .then(([s, posBody, logBody, dailyBody, fundsBody, indicesBody, growwBody, growwFundsBody, kiteBody, paperDaily, shadowDaily, autoDaily]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSettings(s);
        setDraft((d) => ({ ...d, ...s }));
        setPositions({ active: posBody.active ?? [], closed: posBody.closed ?? [] });
        setLogEntries(logBody.entries ?? []);
        setDailyStats(dailyBody);
        setDailyStatsByMode({ PAPER: paperDaily, SHADOW: shadowDaily, AUTO: autoDaily });
        setRealFunds(fundsBody);
        setIndices(indicesBody?.indices ?? []);
        setGrowwStatus(growwBody);
        setGrowwRealFunds(growwFundsBody);
        setKiteStatus(kiteBody);
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

  // Mirrors executionProfiles.ts's derivation exactly: once any toggle
  // column has been explicitly set, PAPER/SHADOW/AUTO become independent
  // (any subset can be enabled at once) and the legacy single execution_mode
  // is ignored; otherwise falls back to that one legacy mode.
  const hasToggles = settings?.paper_enabled != null || settings?.shadow_enabled != null || settings?.auto_enabled != null;
  const enabledProfiles = hasToggles
    ? ["PAPER", "SHADOW", "AUTO"].filter((m) => settings?.[`${m.toLowerCase()}_enabled`])
    : settings?.execution_mode && settings.execution_mode !== "OFF" ? [settings.execution_mode] : [];

  // Everything else on the page (Today's P&L, Open Positions, Activity
  // log) follows whichever profile tab you're currently looking at, NOT
  // the set of enabled profiles — "if I'm inside AUTO only show what's
  // happening in it" means viewing AUTO must show only AUTO, even if
  // SHADOW is also enabled and running in the background. showAllModes
  // opts back into seeing every profile's history together.
  // Every position is also tagged with the broker it was actually routed
  // through (or, for PAPER, whichever broker was active at scan time) —
  // filtering by profile alone let a KITE-routed AUTO position and a
  // GROWW-routed one show side by side while viewing just one broker tab.
  const activeBroker = settings?.active_broker ?? "KITE";
  const visiblePositions = showAllModes
    ? positions
    : {
        active: positions.active.filter((p) => (p.execution_mode ?? "PAPER") === selectedProfile && (p.broker ?? "KITE") === activeBroker),
        closed: positions.closed.filter((p) => (p.execution_mode ?? "PAPER") === selectedProfile && (p.broker ?? "KITE") === activeBroker),
      };

  const clearDailyLock = (mode) => {
    setClearingLock(true);
    fetch("/api/options-autotrade?resource=clear-daily-lock", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
    })
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

  // Independent PAPER/SHADOW/AUTO toggles (migration 019) — replaces the
  // old mutually-exclusive execution_mode segmented control. Any subset can
  // be on at once; each enabled profile runs its own full, independent
  // scan/entry/exit cycle server-side (see executionProfiles.ts). AUTO
  // still gets the same real-money confirmation dialog as the legacy
  // control when being turned ON (never when turning it off).
  const setProfileEnabled = (profile, enabled) => {
    if (profile === "AUTO" && enabled) {
      const broker = settings?.active_broker === "GROWW" ? "GROWW" : "KITE";
      const confirmed = window.confirm(
        broker === "GROWW"
          ? "Broker is set to GROWW.\n\n" +
            "This places REAL orders on your real Groww account with real money — not a simulation.\n\n" +
            "Every future scan cycle will size and fire live BUY/SELL orders the moment a candidate clears the quality gate, with no per-trade confirmation. " +
            "Position-monitor will also place real closing orders automatically.\n\n" +
            "Are you sure you want to turn AUTO on?"
          : "This places REAL orders on your real Zerodha (Kite) account with real money — not a simulation.\n\n" +
            "Every future scan cycle will size and fire live BUY/SELL orders the moment a candidate clears the quality gate, with no per-trade confirmation. " +
            "Position-monitor will also place real closing orders automatically.\n\n" +
            "Are you sure you want to turn AUTO on?",
      );
      if (!confirmed) return;
    }
    setSaving(true);
    fetch("/api/options-autotrade?resource=settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [`${profile.toLowerCase()}_enabled`]: enabled }),
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

  // Same filter as visiblePositions: an entry tagged for another profile
  // is hidden while viewing this one, so old PAPER activity doesn't sit in
  // the log looking like it's still happening under AUTO. Untagged entries
  // (batch-level, or written before this column existed) always show —
  // they were never claiming to be any specific profile. A shared-scan log
  // line (execution_mode like "SHADOW+AUTO") shows if the selected profile
  // is any one of the modes joined together.
  const modeFiltered = showAllModes
    ? logEntries
    : logEntries.filter((e) => !e.execution_mode || e.execution_mode === selectedProfile || e.execution_mode?.split("+").includes(selectedProfile));
  const timeline = [
    ...modeFiltered.map((e) => ({ time: e.created_at, level: e.level, message: e.message })),
  ].slice(0, 30);

  // Header badge shows every currently-enabled profile (PAPER/SHADOW/AUTO
  // can all run at once now) — its color/pulse follows the highest-stakes
  // one enabled (AUTO > SHADOW > PAPER), same visual priority the old
  // single-mode badge gave AUTO.
  const badgeMode = enabledProfiles.includes("AUTO") ? "AUTO" : enabledProfiles.includes("SHADOW") ? "SHADOW" : enabledProfiles[0];
  const modeColor = MODE_COLOR[badgeMode] ?? MODE_COLOR.OFF;
  const badgeLabel = enabledProfiles.length > 0 ? enabledProfiles.join(" + ") : "OFF";
  // Trades and Activity are now dedicated full-screen tabs on mobile — just
  // the header (title/mode/kill switch stay reachable everywhere) plus
  // that tab's own list, none of the ticker/mode/portfolio-hero/capital/
  // settings sections Portfolio and Calendar still show above their content.
  const mobileFullScreenTab = mobileTab === "trades" || mobileTab === "activity";

  return (
    // flex-col + explicit order-[N] on each top-level section below: mobile
    // needs a genuinely different section SEQUENCE (broker context and
    // capital surfaced early, per the mobile redesign brief), not just
    // this same desktop stack squeezed narrower. Desktop's order-[N] values
    // exactly mirror this file's own source order, so desktop is a no-op
    // here — only the unprefixed (mobile) values actually move anything.
    <div className="oat-page flex flex-col px-3 sm:px-6 pt-3 pb-20 sm:pb-6 max-w-[1560px] mx-auto relative" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}>
      {!mobileFullScreenTab && (
        <MobileBrokerBar
          settings={settings} growwStatus={growwStatus} growwConnecting={growwConnecting}
          connectGroww={connectGroww} kiteStatus={kiteStatus} setActiveBroker={setActiveBroker} saving={saving}
        />
      )}

      {/* ── Header: title, mode badge, kill switch — floats slightly above
          the page with a soft hairline beneath, reads as a command bar
          rather than a plain heading row. ── */}
      <div className="flex items-center justify-between gap-3 mb-3 pb-3 order-[20] sm:order-[10]" style={{ borderBottom: "1px solid var(--oat-hairline)" }}>
        <div className="flex items-center gap-2 min-w-0">
          <ChartLineUp size={17} weight="bold" className="text-accent shrink-0" />
          <h1 className="font-display text-[17px] sm:text-[20px] font-bold tracking-[-0.01em] truncate">Options Auto-Trader</h1>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-[var(--radius-sm)] shrink-0 inline-flex items-center gap-1"
            style={badgeMode === "AUTO"
              ? { background: `linear-gradient(135deg, var(--oat-accent), var(--oat-accent-2))`, color: modeColor.fg, boxShadow: "0 2px 8px rgba(90,85,247,0.35)" }
              : { background: modeColor.bg, color: modeColor.fg }}>
            {badgeMode === "AUTO" && <span className="live-dot" style={{ background: "currentColor" }} aria-hidden="true" />}
            {settings ? badgeLabel : "…"}
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
      {!mobileFullScreenTab && <RotatingTicker indices={indices} />}

      {/* ── Execution profiles: independent, expandable PAPER/SHADOW/AUTO
          sections — shared between mobile and desktop. Each one carries its
          own on/off switch plus (expanded) its own today's P&L, active-
          position count and lock state — see ProfileToggleCard's own
          header for why this replaced the earlier compact pill row. ── */}
      {!mobileFullScreenTab && (
        <ExecutionProfilesPanel
          selectedProfile={selectedProfile} setSelectedProfile={setSelectedProfile}
          enabledProfiles={enabledProfiles} setProfileEnabled={setProfileEnabled} saving={saving}
          dailyStatsByMode={dailyStatsByMode}
        />
      )}

      {/* ── Utility Bar: broker + settings, one slim flat row — desktop
          only. Mobile gets MobileBrokerBar (top) + the execution-profiles
          panel above instead; live capital lives inside the Today card
          itself (RiskCommandBar's own LIVE CAPITAL tile), not a separate
          card. ── */}
      <UtilityBar
        settings={settings} growwStatus={growwStatus} growwConnecting={growwConnecting}
        connectGroww={connectGroww} kiteStatus={kiteStatus} setActiveBroker={setActiveBroker} saving={saving}
        enabledProfiles={enabledProfiles}
        settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
        showAllModes={showAllModes} setShowAllModes={setShowAllModes}
      />
      <AnimatePresence initial={false}>
        {settingsOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
            className="hidden sm:block sm:order-[35] overflow-hidden">
            <div className="mb-3 p-3 rounded-[var(--radius-md)]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
              <SettingsFields draft={draft} setField={setField} saving={saving} saveSettings={saveSettings} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {killSwitchResult && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-[var(--radius-md)] mb-4 order-[50] sm:order-[60]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <Shield size={15} weight="bold" className="shrink-0 mt-px text-loss" />
          <div className="text-[12px] flex-1">{killSwitchResult.ok === false ? `Kill switch failed: ${killSwitchResult.message}` : killSwitchResult.message}</div>
          <button onClick={() => setKillSwitchResult(null)} className="text-[11px] text-muted shrink-0">Dismiss</button>
        </div>
      )}

      {/* Separate per-profile risk lock (migration 019) — PAPER/SHADOW/AUTO
          each get their own banner+Clear Lock now, since they no longer
          share one daily_stats row. */}
      {["PAPER", "SHADOW", "AUTO"].map((profile) => {
        const stats = dailyStatsByMode[profile];
        if (!stats?.locked) return null;
        return (
          <div key={profile} className="flex items-start gap-2.5 px-4 py-3 rounded-[var(--radius-md)] mb-4 order-[50] sm:order-[70]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
            <Info size={15} weight="duotone" className="shrink-0 mt-px text-warn" />
            <div className="text-[12px] flex-1 text-ink2">
              <span className="font-semibold">{profile} daily risk lock engaged</span> ({stats.lock_reason}) — new {profile} entries are refused for the rest of today.
              Realized P&L today: {inr(stats.realized_pnl ?? 0)}, consecutive losses: {stats.consecutive_losses ?? 0}.
            </div>
            <button onClick={() => clearDailyLock(profile)} disabled={clearingLock} className="topstep text-[11px] shrink-0">
              {clearingLock ? "Clearing…" : "Clear Lock"}
            </button>
          </div>
        );
      })}

      {/* ── Settings: mobile-only accordion (desktop's trigger lives in
          UtilityBar, fields render just below it there) — collapsed by
          default, risk-parameter fields only. Ordered AFTER positions on
          mobile per the redesign brief (operational detail, not primary
          content the user opens the page to see). ── */}
      {!mobileFullScreenTab && (
      <div className="sm:hidden rounded-[var(--radius-md)] mb-4 order-[90]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <button onClick={() => setSettingsOpen((v) => !v)} className="w-full flex items-center gap-3 p-3 text-left">
          <Gear size={14} weight="bold" className="text-muted shrink-0" />
          <span className="text-[11.5px] font-semibold">Risk &amp; Strategy Settings</span>
          <span className="flex-1" />
          {settingsOpen ? <CaretUp size={14} className="text-muted shrink-0" /> : <CaretDown size={14} className="text-muted shrink-0" />}
        </button>

        <AnimatePresence initial={false}>
          {settingsOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }} className="overflow-hidden">
              <div className="px-3 pb-3 pt-1" style={{ borderTop: "1px solid var(--c-line)" }}>
                <SettingsFields draft={draft} setField={setField} saving={saving} saveSettings={saveSettings} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}

      {loading ? (
        <div className="rounded-[var(--radius-md)] h-[92px] mb-4 skeleton order-[60] sm:order-[90]" />
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[var(--radius-md)] order-[60] sm:order-[90]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12.5px] text-ink2">{error}</p>
        </div>
      ) : (
        <>
          <div className={mobileFullScreenTab ? "hidden sm:block sm:order-[90]" : "order-[60] sm:order-[90]"}>
            <RiskCommandBar positions={visiblePositions} settings={settings} hideAmounts={hideAmounts} setHideAmounts={setHideAmounts} realFunds={realFunds} growwRealFunds={growwRealFunds} />
          </div>

          <div className="order-[80] sm:order-[100]">
            {/* Desktop: unaffected by mobile's tabs — same combined
                active+closed empty check as always. */}
            <div className="hidden sm:block">
              {visiblePositions.active.length === 0 && visiblePositions.closed.length === 0 && (
                <EmptyState
                  label="No active positions"
                  sub={`The scanner is monitoring NIFTY, BANKNIFTY and SENSEX. New ${settings?.execution_mode === "AUTO" ? "AUTO" : settings?.execution_mode === "SHADOW" ? "SHADOW" : "PAPER"} positions appear automatically when a candidate qualifies.`}
                  live={settings?.execution_mode && settings.execution_mode !== "OFF"}
                />
              )}
            </div>

            {/* Mobile: each bottom-nav tab shows its own single list —
                Portfolio = active only, Trades = closed only. */}
            <div className="sm:hidden">
              <AnimatePresence mode="wait">
                {mobileTab === "activity" ? null : mobileTab === "calendar" ? (
                  <motion.div key="calendar" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
                    <PnLCalendar positions={visiblePositions} hideAmounts={hideAmounts} />
                  </motion.div>
                ) : mobileTab === "trades" ? (
                  <motion.div key="trades" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
                    <MobilePositionsList
                      list={visiblePositions.closed} hideAmounts={hideAmounts}
                      emptyState={<EmptyState label="No closed trades yet" sub="Positions will appear here once a trade exits." />}
                    />
                  </motion.div>
                ) : (
                  <motion.div key="portfolio" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
                    <MobilePositionsList
                      list={visiblePositions.active} hideAmounts={hideAmounts}
                      emptyState={
                        <EmptyState
                          label="No active positions"
                          sub={`The scanner is monitoring NIFTY, BANKNIFTY and SENSEX. New ${settings?.execution_mode === "AUTO" ? "AUTO" : settings?.execution_mode === "SHADOW" ? "SHADOW" : "PAPER"} positions appear automatically when a candidate qualifies.`}
                          live={settings?.execution_mode && settings.execution_mode !== "OFF"}
                        />
                      }
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-3 mb-2 sm:order-[110]">
            <h2 className="text-[13px] font-bold">
              Open Positions {visiblePositions.active.length > 0 ? <span className="font-normal text-muted">({visiblePositions.active.length} active)</span> : null}
            </h2>
            <button onClick={() => setShowDesktopCalendar((v) => !v)} className="topstep text-[11px] ml-auto">
              <CalendarBlank size={12} weight="bold" />
              {showDesktopCalendar ? "Hide Calendar" : "Show Calendar"}
            </button>
          </div>
          {showDesktopCalendar && (
            <div className="hidden sm:block mb-4 sm:order-[120]">
              <PnLCalendar positions={visiblePositions} hideAmounts={hideAmounts} />
            </div>
          )}
          {visiblePositions.active.length === 0 && visiblePositions.closed.length === 0 ? null : (
            <div className="hidden sm:block overflow-x-auto rounded-[var(--radius-md)] sm:order-[130]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="oat-sticky-head text-muted text-left">
                    <th className="font-medium py-2 pl-4 pr-2">Instrument</th>
                    <th className="font-medium py-2 pr-3">Trade Taken</th>
                    <th className="font-medium py-2 pr-3 text-right">Credit / Payoff</th>
                    <th className="font-medium py-2 pr-3 text-right">Margin</th>
                    <th className="font-medium py-2 pr-3">Risk : Reward</th>
                    <th className="font-medium py-2 pr-3">Score</th>
                    <th className="font-medium py-2 pr-3">Status</th>
                    <th className="font-medium py-2 pr-4 text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...visiblePositions.active, ...visiblePositions.closed].map((p) => <PositionRow key={p.id} p={p} onClosed={load} />)}
                </tbody>
              </table>
            </div>
          )}

          <div className="hidden sm:block sm:order-[140]">
            <ActivityLog timeline={timeline} />
          </div>
          {mobileTab === "activity" && (
            <div className="sm:hidden order-[90]">
              <ActivityLog timeline={timeline} />
            </div>
          )}
        </>
      )}

      <div className="sm:hidden fixed bottom-0 inset-x-0 z-40 flex" style={{ borderTop: "1px solid var(--c-line)", background: "var(--c-surface)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {[
          { key: "portfolio", label: "Portfolio", Icon: Wallet },
          { key: "trades", label: "Trades", Icon: ListBullets },
          { key: "calendar", label: "Calendar", Icon: CalendarBlank },
          { key: "activity", label: "Activity", Icon: Bell },
        ].map(({ key, label, Icon }) => {
          const active = mobileTab === key;
          return (
            <button key={key} onClick={() => setMobileTab(key)} className="relative flex-1 flex flex-col items-center gap-0.5 py-2" style={{ color: active ? "var(--c-accent)" : "var(--c-muted)", minHeight: 44 }}>
              {active && (
                <motion.span layoutId="mobile-nav-indicator" className="absolute top-0 rounded-full" style={{ width: 28, height: 2.5, background: "var(--c-accent)" }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} />
              )}
              <Icon size={18} weight={active ? "fill" : "regular"} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
