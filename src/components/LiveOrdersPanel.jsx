/**
 * Live trading (REAL Zerodha orders) panel — shared by NIFTY ASCENT and Naked Sell.
 * Talks only to /api/live-orders. Arming needs the typed phrase; FLATTEN closes the
 * real positions and disarms. Nothing here is ever armed automatically.
 */
import { useState, useEffect, useCallback } from "react";

const API = "/api/live-orders";
const LABEL = {
  NIFTY_ASCENT: { stopBufferPct: ["Broker stop distance %", "crash-guard stop sits this far beyond the strategy's fixed stop"] },
  NAKED_SELL: {
    lots: ["Lots per trade", "LIVE only — paper/shadow keep their own"],
    maxEntriesPerDay: ["Entries per day", "across NIFTY + SENSEX"],
    maxDailyLoss: ["Daily loss limit ₹", "real P&L; blocks new LIVE entries"],
    stopBufferPct: ["Broker stop distance %", "crash-guard stop sits this far beyond the strategy stop"],
  },
};
const STATUS_TONE = { OPEN: "var(--c-warn)", OPENING: "var(--c-warn)", CLOSING: "var(--c-warn)", CLOSE_FAILED: "var(--c-loss)", CLOSED: "var(--c-text-2)", ENTRY_FAILED: "var(--c-text-2)" };
const rs = (v) => (v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const signed = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const t = (ms) => (ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");

async function post(resource, body) {
  const r = await fetch(`${API}?resource=${resource}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!r.ok || b.ok === false) throw new Error(b.message || `HTTP ${r.status}`);
  return b;
}

const box = { border: "1px solid var(--c-line)", borderRadius: 14, background: "var(--c-surface)", padding: 14 };
const btn = (bg, fg = "#fff") => ({ height: 32, padding: "0 12px", borderRadius: 9, fontSize: 12, fontWeight: 700, background: bg, color: fg, border: "1px solid var(--c-line)" });

export default function LiveOrdersPanel({ strategy, title = "Live trading · real Zerodha orders", note }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  const [recon, setRecon] = useState(null);

  const load = useCallback((reconcile = false) => {
    return fetch(`${API}?resource=status${reconcile ? "&reconcile=1" : ""}`).then((r) => r.json()).then((b) => {
      setErr(null); setD(b);
      if (reconcile) setRecon(b.strategies?.[strategy]?.reconcile ?? []);
    }).catch((e) => setErr(e.message));
  }, [strategy]);
  useEffect(() => { load(); const id = setInterval(() => load(), 10_000); return () => clearInterval(id); }, [load]);

  const S = d?.strategies?.[strategy];
  const c = S?.control;
  // Saved limits until the owner edits a field; polling never overwrites an edit in progress.
  const form = edit ?? (c ? c.settings : null);
  const setField = (k, v) => setEdit((f) => ({ ...(f ?? c.settings), [k]: v }));
  const act = (fn) => { setBusy(true); setMsg(null); fn().then((b) => { setMsg(b?.message ?? "done"); return load(); }).catch((e) => setMsg(e.message)).finally(() => setBusy(false)); };

  const arm = () => {
    const phrase = d?.armPhrase ?? "ARM LIVE";
    const typed = window.prompt(`REAL MONEY. This lets ${strategy === "NIFTY_ASCENT" ? "NIFTY ASCENT" : "Naked Sell"} send real orders to your Zerodha account on its next signal.\n\nType ${phrase} to arm:`);
    if (typed == null) return;
    act(() => post("arm", { strategy, armed: true, confirm: typed.trim() }));
  };
  const disarm = () => act(() => post("arm", { strategy, armed: false }));
  const flatten = () => { if (window.confirm("FLATTEN LIVE: send real orders now to close every open LIVE position of this strategy, and disarm?")) act(() => post("flatten", { strategy })); };
  const saveSettings = () => act(() => post("settings", { strategy, settings: Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])) }).then(() => { setEdit(null); return { message: "live limits saved" }; }));

  if (!d) return <div style={box}><div style={{ fontSize: 12, color: "var(--c-text-2)" }}>{err ? `Live trading status unavailable: ${err}` : "Loading live trading status…"}</div></div>;
  if (!d.configured) return <div style={box}><b style={{ fontSize: 13 }}>{title}</b><div style={{ fontSize: 12, color: "var(--c-text-2)", marginTop: 6 }}>Not available on this server.</div></div>;

  const armed = !!c?.armed;
  const open = (S?.today ?? []).filter((p) => !["CLOSED", "ENTRY_FAILED"].includes(p.status));
  const closed = (S?.recent ?? []).filter((p) => p.status === "CLOSED");
  const allNet = closed.reduce((a, p) => a + Number(p.net ?? 0), 0);
  const todayNet = (S?.today ?? []).filter((p) => p.status === "CLOSED").reduce((a, p) => a + Number(p.net ?? 0), 0);
  const changed = form && c && Object.keys(form).some((k) => Number(form[k]) !== Number(c.settings[k]));
  const spec = S?.spec ?? {};

  return (
    <div style={{ ...box, borderColor: armed ? "var(--c-loss)" : "var(--c-line)", boxShadow: armed ? "0 0 0 2px var(--c-loss-soft, rgba(220,38,38,.15))" : undefined }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: "var(--c-text-2)", marginTop: 2 }}>{note ?? "Off unless the server switch is on AND you arm it here. Paper results are kept separate."}</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, padding: "4px 9px", borderRadius: 999, background: armed ? "var(--c-loss)" : "var(--c-surface-2, transparent)", color: armed ? "#fff" : "var(--c-text-2)", border: "1px solid var(--c-line)" }}>
          {armed ? "● LIVE ARMED — REAL ORDERS" : "LIVE OFF"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 12, fontSize: 12 }}>
        <div><div style={{ color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700 }}>SERVER SWITCH</div><b style={{ color: d.serverSwitch ? "var(--c-gain)" : "var(--c-text-2)" }}>{d.serverSwitch ? "LIVE_ORDERS = on" : "off (cannot arm)"}</b></div>
        <div><div style={{ color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700 }}>DATABASE</div><b style={{ color: d.migration === false ? "var(--c-loss)" : undefined }}>{d.migration === false ? "migration not applied" : d.migration ? "ready" : "—"}</b></div>
        <div><div style={{ color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700 }}>LIVE TODAY</div><b style={{ color: todayNet >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{signed(todayNet)}</b> <span style={{ color: "var(--c-text-2)" }}>· {open.length} open</span></div>
        <div><div style={{ color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700 }}>LIVE (LAST 50)</div><b style={{ color: allNet >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{closed.length ? signed(allNet) : "—"}</b> <span style={{ color: "var(--c-text-2)" }}>· {closed.length} closed</span></div>
        {armed && c?.armedAt && <div><div style={{ color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700 }}>ARMED AT</div><b>{new Date(c.armedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</b></div>}
        {strategy === "NIFTY_ASCENT" && d.ascentMirror?.lastSkip && <div><div style={{ color: "var(--c-text-2)", fontSize: 10.5, fontWeight: 700 }}>LAST SKIP</div><b>{d.ascentMirror.lastSkip}</b></div>}
      </div>

      {S?.halt && (
        <div style={{ marginTop: 12, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--c-loss)", color: "var(--c-loss)", fontSize: 12, fontWeight: 700 }}>
          NEW LIVE ENTRIES STOPPED — {S.halt}
        </div>
      )}

      {form && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 12 }}>
          {Object.keys(spec).map((k) => (
            <label key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>{LABEL[strategy]?.[k]?.[0] ?? k}</span>
              <input type="number" value={form[k]} min={spec[k][0]} max={spec[k][1]} step={spec[k][3] ? 1 : 0.5} onChange={(e) => setField(k, e.target.value)}
                style={{ padding: "6px 9px", borderRadius: 9, border: "1px solid var(--c-line)", background: "var(--c-surface)", color: "var(--c-text)", fontSize: 13 }} />
              <span style={{ fontSize: 10.5, color: "var(--c-text-2)" }}>{LABEL[strategy]?.[k]?.[1]} · {spec[k][0]}–{spec[k][1]}</span>
            </label>
          ))}
        </div>
      )}
      {strategy === "NIFTY_ASCENT" && <div style={{ fontSize: 11, color: "var(--c-text-2)", marginTop: 8 }}>Size, budget and rules are exactly the live paper settings: live sends the same contract and quantity when the paper entry fills, and exits when paper exits (latest 15:20).</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {!armed
          ? <button disabled={busy || !d.serverSwitch} onClick={arm} style={{ ...btn("var(--c-loss)"), opacity: busy || !d.serverSwitch ? 0.45 : 1 }} title={d.serverSwitch ? "" : "Set LIVE_ORDERS=on on the server first"}>Arm live…</button>
          : <button disabled={busy} onClick={disarm} style={btn("var(--c-surface)", "var(--c-text)")}>Disarm (no new real entries)</button>}
        <button disabled={busy || !open.length} onClick={flatten} style={{ ...btn("#7f1d1d"), opacity: busy || !open.length ? 0.45 : 1 }}>FLATTEN LIVE</button>
        {changed && <button disabled={busy} onClick={saveSettings} style={btn("var(--oat-accent, var(--c-accent))")}>Save live limits</button>}
        <button disabled={busy} onClick={() => { setBusy(true); load(true).finally(() => setBusy(false)); }} style={btn("var(--c-surface)", "var(--c-text)")}>Check Zerodha positions</button>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
      {recon && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {!recon.length ? "No open live positions to check." : recon.map((r) => (
            <div key={r.tradingsymbol} style={{ color: r.match ? "var(--c-gain)" : "var(--c-loss)" }}>
              {r.tradingsymbol}: expected {r.qty}, Zerodha {r.broker ?? "unknown"} {r.match ? "✓" : "— MISMATCH (a manual trade in the same contract also shows here)"}
            </div>
          ))}
        </div>
      )}

      {!!(S?.recent ?? []).length && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", fontSize: 11.5, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: "var(--c-text-2)", textAlign: "left" }}>{["Date", "Contract", "Status", "Qty", "Entry", "Exit", "Stop", "Reason", "Net"].map((h) => <th key={h} style={{ padding: "4px 6px", fontWeight: 700 }}>{h}</th>)}</tr></thead>
            <tbody>
              {(S.recent ?? []).slice(0, 15).map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--c-line)" }}>
                  <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{p.date.slice(5)} {t(p.entryAt ?? p.createdAt)}</td>
                  <td style={{ padding: "4px 6px" }}>{p.entrySide === "SELL" ? "SELL " : "BUY "}{p.tradingsymbol}</td>
                  <td style={{ padding: "4px 6px", color: STATUS_TONE[p.status], fontWeight: 700 }}>{p.status.replace("_", " ")}</td>
                  <td style={{ padding: "4px 6px" }}>{p.qty || p.requestedQty}</td>
                  <td style={{ padding: "4px 6px" }}>{rs(p.entryPrice)}</td>
                  <td style={{ padding: "4px 6px" }}>{rs(p.exitPrice)}</td>
                  <td style={{ padding: "4px 6px" }}>{p.stop?.trigger ? `${rs(p.stop.trigger)} ${p.stop.status === "COMPLETE" ? "(filled)" : p.stop.status === "CANCELLED" ? "(cancelled)" : p.stop.status === "REJECTED" ? "(REJECTED)" : ""}` : "—"}</td>
                  <td style={{ padding: "4px 6px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.log?.at(-1)?.msg}>{p.exitReason ?? p.log?.at(-1)?.msg ?? ""}</td>
                  <td style={{ padding: "4px 6px", fontWeight: 700, color: p.net == null ? undefined : p.net >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{p.net == null ? "—" : signed(p.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
