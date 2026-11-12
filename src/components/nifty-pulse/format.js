/** Formatting helpers for NIFTY PULSE. All times are IST. */
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

export const KIND_LABEL = { BULL_PUT: "Bull put", BEAR_CALL: "Bear call" };
export const EXIT_LABEL = {
  STOP_LOSS: "Stop loss", PROFIT_TARGET: "Profit target", TIME_EXIT: "Time exit",
  MANUAL_FLATTEN: "Paper flatten", KILL_SWITCH: "Kill switch", SESSION_END: "Session end",
};
