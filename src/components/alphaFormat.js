import { useState, useEffect } from "react";
import { inr } from "./swingFormat.js";

// Shared non-component helpers for the hedged strategy dashboards (kept out
// of alphaUi.jsx so that file exports only components — fast refresh).

export const OAT_VARS = { "--oat-accent": "#5A55F7", "--oat-accent-2": "#6A63FF", "--oat-blue": "#3B82F6", "--oat-hairline": "rgba(20, 30, 55, 0.07)" };
export const EASE = [0.2, 0.8, 0.2, 1];

export const dirLabel = (d) => (d > 0 ? "BULLISH" : d < 0 ? "BEARISH" : "—");
export const dirTone = (d) => (d > 0 ? "var(--c-gain)" : d < 0 ? "var(--c-loss)" : "var(--c-muted)");
export const signed = (n) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${inr(Math.abs(n))}`);
export const pts = (n, dp = 2) => (n == null ? "—" : Number(n).toFixed(dp));

export function istNow() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, h: Number(g("hour")) % 24, m: Number(g("minute")), s: Number(g("second")), wd: g("weekday") };
}

/** Milliseconds until the next Wednesday 09:31 IST signal window (0 while a window is open). */
export function msToNextWindow() {
  const n = istNow();
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = order.indexOf(n.wd);
  const minutes = n.h * 60 + n.m;
  if (today === 3 && minutes >= 571 && minutes <= 871) return 0;
  let days = (3 - today + 7) % 7;
  if (days === 0 && minutes > 871) days = 7;
  const secondsToday = n.h * 3600 + n.m * 60 + n.s;
  return (days * 86400 + 571 * 60 - secondsToday) * 1000;
}

export function fmtDuration(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function useTicker(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

