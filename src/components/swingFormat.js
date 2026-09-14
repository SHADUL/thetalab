// Shared display helpers for the Swing Scanner UI (scanner table, portfolio
// table, and the sizing/settings modals) — pulled out once a third
// consumer needed the same formatting rather than a fourth copy-paste.

export const PRESETS = [
  { id: "balanced", label: "Balanced" },
  { id: "momentum", label: "Momentum" },
  { id: "breakout", label: "Breakout" },
  { id: "early_breakout", label: "Early Breakout" },
  { id: "pullback", label: "Pullback" },
  { id: "aggressive", label: "Aggressive" },
];

export function toneClass(tone, prefix = "text") {
  return { gain: `${prefix}-gain`, loss: `${prefix}-loss`, warn: `${prefix}-warn`, accent: `${prefix}-accent`, muted: `${prefix}-muted` }[tone] ?? `${prefix}-muted`;
}
export function fm(v, d = 2) { return v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d); }
export function inr(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
export function pctSigned(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
export function scoreTone(score) {
  if (score >= 80) return "gain";
  if (score >= 60) return "accent";
  return "muted";
}

export function scoreLabel(score) {
  if (score >= 90) return "VERY STRONG";
  if (score >= 80) return "STRONG";
  if (score >= 70) return "GOOD";
  if (score >= 60) return "FAIR";
  return "WEAK";
}

export function tradingViewUrl(symbol) {
  return `https://www.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}`;
}
