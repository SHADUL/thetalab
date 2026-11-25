/**
 * Site-wide red banner when the Kite login is missing or expired (trading days, 08:30–15:30 IST).
 * Polls /api/kite-status once a minute; the server checks Kite at most once a minute.
 */
import { useEffect, useState } from "react";

export default function KiteLoginBanner() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch("/api/kite-status").then((r) => (r.ok ? r.json() : null)).then((b) => { if (live && b) setS(b); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  if (!s?.alert) return null;
  return (
    <div role="alert" style={{ position: "sticky", top: 0, zIndex: 1000, background: "var(--c-loss, #dc2626)", color: "#fff", padding: "8px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 13, fontWeight: 600 }}>
      <span>⚠ {s.message}</span>
      <a href="/api/kite-callback" style={{ background: "#fff", color: "var(--c-loss, #dc2626)", borderRadius: 8, padding: "4px 12px", fontWeight: 800, textDecoration: "none", whiteSpace: "nowrap" }}>Log in to Kite</a>
    </div>
  );
}
