/** Formatting helpers for NIFTY ASCENT. All times are IST. */
const IST_MS = 330 * 60_000;

export function istTime(ms, withMs = false) {
  if (ms == null) return "—";
  const s = new Date(ms + IST_MS).toISOString();
  return withMs ? s.slice(11, 23) : s.slice(11, 19);
}
export function istHm(ms) { return ms == null ? "—" : new Date(ms + IST_MS).toISOString().slice(11, 16); }
export function istDate(ms) {
  if (ms == null) return "—";
  const d = new Date(ms + IST_MS);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function inr(x, { sign = false, dp = 0 } = {}) {
  if (x == null || !Number.isFinite(x)) return "—";
  const abs = Math.abs(x).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const s = x < 0 ? "−" : sign && x > 0 ? "+" : "";
  return `${s}₹${abs}`;
}
export function num(x, dp = 2, { sign = false } = {}) {
  if (x == null || !Number.isFinite(x)) return "—";
  const s = x < 0 ? "−" : sign && x > 0 ? "+" : "";
  return `${s}${Math.abs(x).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
export function pct(x, dp = 2, { sign = true } = {}) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${num(x, dp, { sign })}%`;
}
export function secs(ms) {
  if (ms == null) return "—";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}
export function dur(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
/** Sign word so P&L never relies on colour alone. */
export function tone(x) { return x == null ? "flat" : x > 0 ? "gain" : x < 0 ? "loss" : "flat"; }
export function arrow(x) { return x == null || x === 0 ? "▪" : x > 0 ? "▲" : "▼"; }

export const EXIT_LABEL = { FIXED_STOP: "Fixed stop −30%", TRAILING_STOP: "Trailing stop", TIME_EXIT: "15:15 time exit", KILL_FLATTEN: "Kill / flatten" };
export const BOT_LABEL = { GAP_AND_GO: "Gap-and-Go", WILLIAMS: "Williams" };
export const REASON_LABEL = {
  opposite_first: "opposite_first — the opposite band broke first",
  filled: "filled — the gap had already filled",
  no_break: "no_break — no breakout by 12:00",
  no_gap: "no_gap — zero gap (no direction)",
  narrow_or: "Skipped — opening range below the minimum width",
  williams_gap_ineligible: "Williams forbidden — gap in [0.2%, 0.5%)",
  williams_no_trigger: "Williams — no level broke by 14:29",
  entry_rejected: "Entry rejected",
  data_error: "DATA_ERROR — required data missing",
  killed: "Kill switch",
  unresolved_exit: "Exit unresolved — no bid observed",
};
export const STATE_LABEL = (s) => (s ?? "").replaceAll("_", " ");
/** IST HH:MM for a bar label (minutes after midnight). */
export function hm(label) { return label == null ? "—" : `${String(Math.floor(label / 60)).padStart(2, "0")}:${String(label % 60).padStart(2, "0")}`; }
