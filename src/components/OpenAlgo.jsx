/**
 * OpenAlgo — a separate, open-source trading platform (github.com/marketcalls/openalgo,
 * AGPL-3.0) installed beside ThetaLab at its own address. This page shows whether it is
 * up and links to it. ThetaLab never sends orders through OpenAlgo.
 */
import { useState, useEffect } from "react";
import { ArrowSquareOut, CheckCircle, Circle, Warning } from "@phosphor-icons/react";

const box = { border: "1px solid var(--c-line)", borderRadius: 14, background: "var(--c-surface)", padding: 16 };
const label = { color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700, letterSpacing: ".02em" };

function Step({ done, title, children }) {
  return (
    <li style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderTop: "1px solid var(--c-line)" }}>
      <span style={{ marginTop: 1, color: done ? "var(--c-gain)" : "var(--c-text-2)" }}>{done ? <CheckCircle size={18} weight="fill" /> : <Circle size={18} />}</span>
      <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div style={{ color: "var(--c-text-2)" }}>{children}</div>
      </div>
    </li>
  );
}

export default function OpenAlgo() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/openalgo").then((r) => r.json()).then((b) => { if (alive) setS(b); }).catch(() => { if (alive) setS({ up: false, error: "status unavailable" }); });
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const url = s?.url ?? "https://openalgo.130-210-19-135.sslip.io";
  const state = !s ? "Checking…" : !s.up ? "Not reachable" : s.needsSetup ? "Running — first-time setup needed" : "Running";
  const tone = !s ? "var(--c-text-2)" : !s.up ? "var(--c-loss)" : s.needsSetup ? "var(--c-warn, #d97706)" : "var(--c-gain)";

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 16 }}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "grid", gap: 14 }}>
        <div style={{ ...box, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>OpenAlgo</div>
            <div style={{ fontSize: 12, color: "var(--c-text-2)", marginTop: 3, maxWidth: 560 }}>
              Open-source trading platform: broker connection, order and portfolio screens, TradingView / Amibroker webhooks,
              a visual strategy builder and an Analyzer (paper) mode. It runs as its own app with its own login.
            </div>
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "0 14px", borderRadius: 9, fontSize: 12.5, fontWeight: 700, background: "var(--c-accent, #2563eb)", color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>
            Open OpenAlgo <ArrowSquareOut size={15} weight="bold" />
          </a>
        </div>

        <div style={{ ...box, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          <div><div style={label}>STATUS</div><b style={{ color: tone, fontSize: 13 }}>{state}</b>{s?.error && <div style={{ fontSize: 11, color: "var(--c-text-2)" }}>{s.error}</div>}</div>
          <div style={{ minWidth: 0 }}><div style={label}>ADDRESS</div><b style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{url.replace(/^https:\/\//, "")}</b></div>
          <div><div style={label}>BROKER</div><b style={{ fontSize: 12.5 }}>None yet — Analyzer (paper) first</b></div>
          <div><div style={label}>LAST CHECK</div><b style={{ fontSize: 12.5 }}>{s?.checkedAt ? new Date(s.checkedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</b></div>
        </div>

        <div style={box}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>Getting started</div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <Step done={s?.up && s.needsSetup === false} title="1. Create your OpenAlgo admin account">
              Open OpenAlgo and complete its first-time setup with your own username and password. Until that is done, the address only answers your own internet connection.
            </Step>
            <Step done={false} title="2. Switch on Analyzer mode and try it">
              In OpenAlgo, turn on Analyzer mode. Orders are then simulated in its sandbox with virtual funds — nothing reaches a broker.
            </Step>
            <Step done={false} title="3. Later: connect Zerodha with a second Kite Connect app">
              Create a new app at developers.kite.trade with the redirect URL <code style={{ fontSize: 11.5 }}>{url}/zerodha/callback</code>, then enter its API key and secret in OpenAlgo → Broker Configuration.
              Do not reuse ThetaLab's Kite app: it would end ThetaLab's Kite session (ASCENT, Naked Sell, PULSE).
            </Step>
          </ol>
        </div>

        <div style={{ ...box, borderColor: "var(--c-warn, #d97706)", display: "flex", gap: 10 }}>
          <span style={{ color: "var(--c-warn, #d97706)", marginTop: 1 }}><Warning size={18} weight="fill" /></span>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: "var(--c-text-2)" }}>
            Once a broker is connected, OpenAlgo trades the <b>same Zerodha account</b> as Naked Sell LIVE and NIFTY ASCENT live: same funds and margin.
            Its limits are separate from ThetaLab's, and a position it opens in the same contract would show up in ThetaLab's live position check.
            OpenAlgo is AGPL-3.0 software by marketcalls, run here unmodified.
          </div>
        </div>
      </div>
    </div>
  );
}
