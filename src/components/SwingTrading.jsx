import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendUp, MagnifyingGlass, Gear, X, Warning, Briefcase, ListChecks, ArrowsClockwise, Brain, ClockCounterClockwise,
  CheckCircle, XCircle, Question, ShieldCheck, Plus, ArrowUp, SignOut, Info, Lightning,
} from "@phosphor-icons/react";
import { inr } from "./swingFormat.js";
import { OAT_VARS, EASE, signed } from "./alphaFormat.js";
import { Card, Pill, Stat } from "./alphaUi.jsx";

// Swing Trading (swing-india): Nifty 100 cash-equity swing scanner +
// paper-trading tracker. Everything is paper — no broker orders. The
// server computes every number; this page only reads and posts actions.

const API = "/api/swing-india";
const POLL_MS = 60_000;
const EXIT_REASONS = [
  ["t1_hit", "T1 hit"], ["t2_hit", "T2 hit"], ["stop_hit", "Stop hit"], ["trail_hit", "Trail stop hit"],
  ["time_stop", "Time stop"], ["discretionary", "Discretionary"], ["invalidation", "Invalidation"],
];
const SIGNAL_TONE = { EXIT: "loss", TRAIL: "gain", WATCH: "warn", "HOLD+": "accent", HOLD: "neutral" };
const VERDICT_TONE = { BUY: "gain", WAIT: "warn", SKIP: "loss" };

const n2 = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d));
const pct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const tone = (v) => (v == null ? undefined : v >= 0 ? "gain" : "loss");

async function call(resource, body) {
  const r = await fetch(`${API}?resource=${resource}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({ error: "bad_response", message: `HTTP ${r.status}` }));
  if (b.error) throw new Error(b.message || b.error);
  return b;
}

function Btn({ children, onClick, disabled, kind = "ghost", icon: Icon, title }) {
  const styles = {
    primary: { background: "var(--oat-accent)", color: "#fff", border: "1px solid transparent" },
    danger: { background: "var(--c-loss-soft)", color: "var(--c-loss)", border: "1px solid transparent" },
    ghost: { background: "var(--c-surface)", color: "var(--c-text)", border: "1px solid var(--c-line)" },
  }[kind];
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className="inline-flex items-center justify-center gap-1.5 rounded-[9px] px-2.5 text-[11.5px] font-semibold whitespace-nowrap transition-opacity"
      style={{ ...styles, height: 30, opacity: disabled ? 0.45 : 1 }}>
      {Icon && <Icon size={13} weight="bold" />}{children}
    </button>
  );
}

function Drawer({ open, onClose, title, children }) {
  // Portalled to <body>: .oat-page isolates its stacking context.
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-40" style={{ background: "rgba(15,23,41,.28)" }} />
          <motion.aside initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.3, ease: EASE }}
            className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[480px] overflow-y-auto p-5 flex flex-col gap-4"
            style={{ ...OAT_VARS, background: "var(--c-surface)", boxShadow: "-20px 0 50px rgba(15,23,41,.12)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[17px] font-bold">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="text-muted"><X size={18} /></button>
            </div>
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-ink2">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] text-faint">{hint}</span>}
    </label>
  );
}
const inputStyle = { border: "1px solid var(--c-line)", background: "var(--c-surface)" };
const Input = (props) => <input {...props} className="px-3 py-2 rounded-[10px] n text-[13px] w-full" style={inputStyle} />;

function Kv({ k, v, t }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] font-semibold text-faint tracking-wide">{k}</span>
      <span className="n text-[12.5px] font-semibold truncate" style={{ color: t === "gain" ? "var(--c-gain)" : t === "loss" ? "var(--c-loss)" : undefined }}>{v}</span>
    </div>
  );
}

// ------------------------------------------------------------------ open positions

function OpenCard({ positions, onClose, onTrail, slots }) {
  return (
    <Card title="Open positions" icon={Briefcase} right={<Pill tone={slots.used >= slots.max ? "warn" : "neutral"}>{slots.used}/{slots.max} slots</Pill>}>
      {positions.length === 0 ? (
        <div className="text-[12px] text-ink2">No open paper trades. Run the scan, analyze a pick, add it to proposed, then mark it filled.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {positions.map((p) => {
            const L = p.live;
            return (
              <div key={p.id} className="rounded-[12px] p-3" style={{ border: "1px solid var(--oat-hairline)", background: "var(--c-surface)" }}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[15px] font-bold">{p.symbol}</span>
                    <Pill tone={SIGNAL_TONE[L.signal]}>{L.signal}</Pill>
                    <span className="text-[10.5px] text-faint">held {L.daysHeld}d/{L.horizon}d</span>
                  </div>
                  <div className="flex gap-1.5">
                    {L.trailStop != null && L.trailStop > Number(p.stop) && (
                      <Btn icon={ArrowUp} onClick={() => onTrail(p, L.trailStop)} title="Raise stop to ATR×1.5 below CMP">Trail to {inr(L.trailStop)}</Btn>
                    )}
                    <Btn icon={SignOut} kind={L.signal === "EXIT" ? "danger" : "ghost"} onClick={() => onClose(p)}>Close</Btn>
                  </div>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-3 gap-y-2">
                  <Kv k={`CMP${L.cmpLive ? "" : " (stale)"}`} v={inr(L.cmp)} />
                  <Kv k="ENTRY" v={inr(p.entry)} />
                  <Kv k="QTY" v={p.qty} />
                  <Kv k="STOP" v={`${inr(p.stop)}`} />
                  <Kv k="T1" v={inr(p.t1)} />
                  <Kv k="T2" v={inr(p.t2)} />
                  <Kv k="UNREALIZED" v={signed(L.unrealizedInr)} t={tone(L.unrealizedInr)} />
                  <Kv k="RETURN" v={pct(L.unrealizedPct)} t={tone(L.unrealizedPct)} />
                  <Kv k="R-MULTIPLE" v={`${L.rMultiple >= 0 ? "+" : ""}${L.rMultiple}R`} t={tone(L.rMultiple)} />
                  <Kv k="TO T1" v={pct(L.distToT1Pct)} />
                  <Kv k="TO STOP" v={pct(L.distToStopPct)} />
                  <Kv k="OPENED" v={p.opened_at?.slice(5)} />
                </div>
                <div className="mt-2 text-[11px] text-ink2">→ {L.reason}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ProposedCard({ proposed, onOpen, onDiscard, busy }) {
  if (!proposed.length) return null;
  return (
    <Card title="Proposed (queued)" icon={ListChecks} delay={0.05}>
      <div className="flex flex-col gap-2">
        {proposed.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2" style={{ border: "1px solid var(--oat-hairline)" }}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-[13px]">{p.symbol}</span>
              <Pill tone={VERDICT_TONE[p.verdict] ?? "neutral"}>{p.verdict}</Pill>
              <span className="n text-[11px] text-ink2">buy {inr(p.entry)} · stop {inr(p.stop)} · T1 {inr(p.t1)} · {p.qty} sh</span>
              {p.cmp != null && <span className="n text-[11px] text-faint">CMP {inr(p.cmp)}</span>}
            </div>
            <div className="flex gap-1.5">
              <Btn kind="primary" icon={CheckCircle} disabled={busy} onClick={() => onOpen(p)}>Mark filled</Btn>
              <Btn icon={X} disabled={busy} onClick={() => onDiscard(p)}>Discard</Btn>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10.5px] text-faint">Paper trade: "Mark filled" records the entry at your fill price. No order is sent anywhere.</div>
    </Card>
  );
}

// ------------------------------------------------------------------ scan

function ScanCard({ scan, loading, onRun, onAnalyze, error }) {
  return (
    <Card title="New scan — Nifty 100 top picks" icon={MagnifyingGlass} delay={0.1}
      right={<Btn icon={ArrowsClockwise} onClick={() => onRun(true)} disabled={loading}>{loading ? "Scanning…" : "Rescan"}</Btn>}>
      {error && <div className="mb-3 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
      {!scan ? (
        <div className="h-[140px] rounded-[12px] animate-pulse" style={{ background: "var(--c-surface-2)" }} />
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink2 mb-3">
            <span>Scanned <b className="n">{scan.scanned}</b></span>
            <span>Filtered <b className="n">{scan.filtered}</b></span>
            <span>Candidates <b className="n">{scan.candidates}</b></span>
            <span>Bars as of <b className="n">{scan.dataAsOf}</b></span>
            <span>CMP {scan.liveQuotes ? "live (Kite)" : "last close (stale)"}</span>
            <span>Learnings {scan.learningsActive ? `active (N=${scan.sampleSize})` : `off (N=${scan.sampleSize}/10)`}</span>
          </div>
          {scan.picks.length === 0 ? <div className="text-[12px] text-ink2">No setups pass every filter today. Sitting out is a position.</div> : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[12px] min-w-[860px]">
                <thead>
                  <tr className="text-[10px] text-faint tracking-wide text-right">
                    <th className="text-left font-semibold py-1.5 pl-1">#</th>
                    <th className="text-left font-semibold">TICKER</th>
                    <th className="font-semibold">SCORE</th><th className="font-semibold">CMP</th><th className="font-semibold">RSI</th>
                    <th className="font-semibold">ADX</th><th className="font-semibold">DMA+%</th><th className="font-semibold">ENTRY</th>
                    <th className="font-semibold">STOP</th><th className="font-semibold">T1</th><th className="font-semibold">T2</th>
                    <th className="font-semibold">QTY</th><th className="font-semibold">%CAP</th><th />
                  </tr>
                </thead>
                <tbody>
                  {scan.picks.map((p, i) => (
                    <tr key={p.symbol} className="oat-row text-right n" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
                      <td className="text-left py-2 pl-1 text-faint">{i + 1}</td>
                      <td className="text-left">
                        <div className="font-semibold font-sans">{p.symbol}</div>
                        <div className="text-[10px] text-faint font-sans truncate max-w-[160px]">{p.sector}</div>
                      </td>
                      <td><Pill tone={p.score >= 70 ? "gain" : p.score >= 50 ? "accent" : "neutral"}>{p.score}</Pill></td>
                      <td>{inr(p.cmp)}</td>
                      <td>{n2(p.technicals.rsi14)}</td>
                      <td>{n2(p.technicals.adx14)}</td>
                      <td>{n2(p.technicals.dmaPct)}</td>
                      <td>{inr(p.plan.entry)}</td>
                      <td style={{ color: "var(--c-loss)" }}>{inr(p.plan.stop)}</td>
                      <td style={{ color: "var(--c-gain)" }}>{inr(p.plan.t1)}</td>
                      <td style={{ color: "var(--c-gain)" }}>{inr(p.plan.t2)}</td>
                      <td>{p.plan.qty}</td>
                      <td>{n2(p.plan.positionPct)}</td>
                      <td className="pl-2"><Btn onClick={() => onAnalyze(p.symbol)}>Analyze</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 text-[10.5px] text-faint">
            Entry = CMP + 0.5×ATR · Stop = CMP − 1.5×ATR · T1 = 1.5R · T2 = 3R · Qty sized to {scan.riskPct}% risk of {inr(scan.capital)}.
            Score: RSI 40–50 +30 · ADX 35–50 +25 · 2–5% above 200DMA +20 · MACD accelerating +15 · favored +10.
          </div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ analyze drawer

function CheckRow({ c }) {
  const Icon = c.ok == null ? Question : c.ok ? CheckCircle : XCircle;
  const color = c.ok == null ? "var(--c-muted)" : c.ok ? "var(--c-gain)" : "var(--c-loss)";
  return (
    <div className="flex items-center justify-between gap-2 py-1.5" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
      <span className="flex items-center gap-1.5 text-[12px]"><Icon size={14} weight="fill" style={{ color }} />{c.label}</span>
      <span className="n text-[11px] text-ink2 text-right">{c.detail}</span>
    </div>
  );
}

function AnalyzeDrawer({ symbol, open, onClose, onProposed }) {
  const [query, setQuery] = useState(symbol ?? "");
  const [a, setA] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const run = useCallback((s) => {
    if (!s) return;
    setLoading(true); setError(null); setA(null);
    fetch(`${API}?resource=analyze&symbol=${encodeURIComponent(s)}`).then((r) => r.json())
      .then((b) => { if (b.error) setError(b.message || b.error); else setA(b); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (open && symbol) { setQuery(symbol); run(symbol); } }, [open, symbol, run]);

  const propose = () => {
    setAdding(true); setError(null);
    call("propose", { symbol: a.symbol }).then(() => { onProposed(`${a.symbol} added to proposed.`); onClose(); })
      .catch((e) => setError(e.message)).finally(() => setAdding(false));
  };

  const t = a?.technicals;
  return (
    <Drawer open={open} onClose={onClose} title="Analyze ticker">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(query.trim()); }}>
        <Input value={query} onChange={(e) => setQuery(e.target.value.toUpperCase())} placeholder="NSE symbol, e.g. RELIANCE" aria-label="Symbol" autoFocus />
        <Btn kind="primary" icon={MagnifyingGlass} disabled={loading || !query.trim()}>Go</Btn>
      </form>
      {error && <div className="text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
      {loading && <div className="h-[300px] rounded-[12px] animate-pulse" style={{ background: "var(--c-surface-2)" }} />}
      {a && (
        <>
          <div className="rounded-[14px] p-4" style={{ background: "var(--c-surface-2)" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-display text-[18px] font-bold">{a.symbol}.NS</div>
                <div className="text-[11px] text-faint">{a.name} · {a.sector}</div>
              </div>
              <Pill tone={VERDICT_TONE[a.verdict]}>{a.verdict}</Pill>
            </div>
            <div className="mt-2 text-[12px] text-ink2">{a.reason}</div>
            <div className="mt-1 text-[10.5px] text-faint">Learnings applied: {a.learningsApplied ? `yes (N=${a.sampleSize})` : `no (N=${a.sampleSize}/10 sample)`} · score {a.score}/100</div>
          </div>

          <div>
            <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-2">TECHNICAL</div>
            <div className="grid grid-cols-3 gap-3">
              <Kv k={`CMP${a.cmpLive ? "" : " (stale)"}`} v={inr(a.cmp)} />
              <Kv k="200DMA" v={inr(Math.round(t.dma200))} />
              <Kv k="50DMA" v={inr(Math.round(t.dma50))} />
              <Kv k="RSI 14" v={n2(t.rsi14)} />
              <Kv k="ADX 14" v={n2(t.adx14)} />
              <Kv k="ATR 14" v={n2(t.atr14, 2)} />
              <Kv k="WEEKLY" v={a.weeklyTrend ?? "—"} />
              <Kv k="FIB SUPPORT" v={inr(a.fib.support)} />
              <Kv k="RESISTANCE" v={inr(a.fib.resistance)} />
            </div>
          </div>

          <div>
            <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-2">POSITION · {inr(a.capital)} at {a.riskPct}% risk</div>
            <div className="grid grid-cols-3 gap-3">
              <Kv k="ENTRY TRIGGER" v={inr(a.plan.entry)} />
              <Kv k="STOP" v={inr(a.plan.stop)} t="loss" />
              <Kv k="QTY" v={`${a.plan.qty} sh`} />
              <Kv k="T1 (1.5R)" v={inr(a.plan.t1)} t="gain" />
              <Kv k="T2 (3R)" v={inr(a.plan.t2)} t="gain" />
              <Kv k="R:R T1 / T2" v={`${a.plan.rrT1} / ${a.plan.rrT2}`} />
              <Kv k="RISK" v={inr(a.plan.riskInr)} />
              <Kv k="VALUE" v={inr(a.plan.positionInr)} />
              <Kv k="% CAPITAL" v={`${n2(a.plan.positionPct)}%`} />
            </div>
            <div className="mt-2 text-[10.5px] text-faint">Horizon 3–{a.horizonDays} days · trail ATR(14)×1.5 after T1 · invalidation: hard stop, or daily close below {inr(a.fib.support ?? a.plan.stop)}.</div>
          </div>

          <div>
            <div className="text-[10.5px] font-semibold text-muted tracking-wide mb-1">GATES</div>
            {a.checks.map((c) => <CheckRow key={c.label} c={c} />)}
          </div>

          <div className="rounded-[12px] p-3 text-[11px] leading-snug" style={{ background: "var(--c-warn-soft)" }}>
            <div className="font-semibold mb-1 flex items-center gap-1"><Warning size={13} weight="bold" />Check yourself before entry (not automated)</div>
            <ul className="list-disc pl-4 text-ink2">
              <li>Quarterly results not within the next 7 days.</li>
              <li>Not in ASM / GSM / T2T surveillance (NSE site).</li>
              <li>Fundamentals: valuation vs peers, ROCE, debt — no DCF/comps feed here.</li>
              <li>Market cap ≥ ₹5,000 cr (Nifty 100 names all qualify).</li>
            </ul>
          </div>

          <Btn kind="primary" icon={Plus} disabled={adding || a.verdict === "SKIP"} onClick={propose}>
            {a.verdict === "SKIP" ? "SKIP — not tradable" : adding ? "Adding…" : "Add to proposed"}
          </Btn>
          {a.verdict === "BUY" && (
            <div className="text-[10.5px] text-faint">Paper trade 2 months minimum before real capital. SEBI FY25: 91% of retail F&O traders lost money. Cash-equity edge needs discipline and 50+ trades to be statistically meaningful.</div>
          )}
        </>
      )}
    </Drawer>
  );
}

// ------------------------------------------------------------------ close / fill / settings drawers

function CloseDrawer({ position, onClose, onDone }) {
  const [exit, setExit] = useState("");
  const [reason, setReason] = useState("discretionary");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!position) return;
    const L = position.live;
    setExit(String(L.cmp)); setNote(""); setError(null);
    setReason(L.cmp <= Number(position.stop) ? (Number(position.stop) > Number(position.initial_stop) ? "trail_hit" : "stop_hit")
      : L.cmp >= Number(position.t2) ? "t2_hit" : L.daysHeld >= L.horizon ? "time_stop" : L.cmp >= Number(position.t1) ? "t1_hit" : "discretionary");
  }, [position]);
  const R = position ? Number(position.entry) - Number(position.initial_stop ?? position.stop) : 0;
  const r = position && Number(exit) > 0 && R > 0 ? (Number(exit) - Number(position.entry)) / R : null;
  const submit = () => {
    setBusy(true); setError(null);
    call("close", { id: position.id, exit: Number(exit), reason, postmortem: note }).then((b) => { onDone(`${position.symbol} closed at ${inr(Number(exit))} — ${b.metrics.rMultiple}R, ${b.metrics.outcome}.`); onClose(); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Drawer open={!!position} onClose={onClose} title={`Close ${position?.symbol ?? ""}`}>
      {position && (
        <>
          <div className="grid grid-cols-3 gap-3 rounded-[12px] p-3" style={{ background: "var(--c-surface-2)" }}>
            <Kv k="ENTRY" v={inr(position.entry)} /><Kv k="INITIAL STOP" v={inr(position.initial_stop)} /><Kv k="QTY" v={position.qty} />
          </div>
          <Field label="Exit price (₹)" hint={r == null ? null : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R · P&L ${signed((Number(exit) - Number(position.entry)) * position.qty)}`}>
            <Input type="number" step="0.05" value={exit} onChange={(e) => setExit(e.target.value)} />
          </Field>
          <Field label="Reason">
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="px-3 py-2 rounded-[10px] text-[13px]" style={inputStyle}>
              {EXIT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Post-mortem" hint="What worked, what didn't — feeds the learnings compile.">
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} className="px-3 py-2 rounded-[10px] text-[13px]" style={inputStyle} />
          </Field>
          {error && <div className="text-[12px]" style={{ color: "var(--c-loss)" }}>{error}</div>}
          <Btn kind="primary" icon={SignOut} disabled={busy || !(Number(exit) > 0)} onClick={submit}>{busy ? "Closing…" : "Log close"}</Btn>
        </>
      )}
    </Drawer>
  );
}

function FillDrawer({ position, onClose, onDone }) {
  const [fill, setFill] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (position) { setFill(String(position.entry)); setError(null); } }, [position]);
  const submit = () => {
    setBusy(true); setError(null);
    call("open", { id: position.id, fillPrice: Number(fill) }).then(() => { onDone(`${position.symbol} is now an open paper trade.`); onClose(); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Drawer open={!!position} onClose={onClose} title={`Mark ${position?.symbol ?? ""} filled`}>
      {position && (
        <>
          <div className="text-[12px] text-ink2">Planned entry trigger {inr(position.entry)} · stop {inr(position.stop)} · T1 {inr(position.t1)} · T2 {inr(position.t2)} · {position.qty} shares.</div>
          <Field label="Fill price (₹)" hint="Stop and targets stay fixed. If the fill is chased so far that R:R to T1 drops below 1.5, it's refused — re-analyze instead.">
            <Input type="number" step="0.05" value={fill} onChange={(e) => setFill(e.target.value)} />
          </Field>
          {error && <div className="text-[12px]" style={{ color: "var(--c-loss)" }}>{error}</div>}
          <Btn kind="primary" icon={CheckCircle} disabled={busy || !(Number(fill) > 0)} onClick={submit}>{busy ? "Saving…" : "Confirm paper fill"}</Btn>
        </>
      )}
    </Drawer>
  );
}

function SettingsDrawer({ open, onClose, data, onDone }) {
  const [capital, setCapital] = useState("");
  const [risk, setRisk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open && data) { setCapital(String(data.capital)); setRisk(String(data.riskPct)); setError(null); } }, [open, data]);
  const save = () => {
    setBusy(true); setError(null);
    call("settings", { capital: Number(capital), riskPct: Number(risk) }).then(() => { onDone("Settings saved."); onClose(); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Drawer open={open} onClose={onClose} title="Paper account">
      <Field label="Capital (₹)" hint="Paper capital used for sizing and month P&L %.">
        <Input type="number" step="10000" value={capital} onChange={(e) => setCapital(e.target.value)} />
      </Field>
      <Field label="Risk per trade (%)" hint="Hard rule: never above 1%.">
        <Input type="number" step="0.1" min="0.1" max="1" value={risk} onChange={(e) => setRisk(e.target.value)} />
      </Field>
      {error && <div className="text-[12px]" style={{ color: "var(--c-loss)" }}>{error}</div>}
      <Btn kind="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Btn>
    </Drawer>
  );
}

// ------------------------------------------------------------------ side cards

function HistoryCard({ stats, closed }) {
  return (
    <Card title="Closed history" icon={ClockCounterClockwise} delay={0.1}>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <Kv k="TRADES" v={`${stats.count} (W${stats.wins} L${stats.losses} BE${stats.breakeven})`} />
        <Kv k="WIN RATE" v={stats.winRate == null ? "—" : `${stats.winRate}%`} />
        <Kv k="EXPECTANCY" v={stats.avgR == null ? "—" : `${stats.avgR}R`} t={tone(stats.avgR)} />
        <Kv k="AVG WIN" v={stats.avgWinR == null ? "—" : `${stats.avgWinR}R`} />
        <Kv k="AVG LOSS" v={stats.avgLossR == null ? "—" : `${stats.avgLossR}R`} />
        <Kv k="AVG HOLD" v={stats.avgDaysHeld == null ? "—" : `${stats.avgDaysHeld}d`} />
      </div>
      {closed.length === 0 ? <div className="text-[11.5px] text-faint">No closed trades yet.</div> : (
        <div className="flex flex-col max-h-[260px] overflow-y-auto">
          {closed.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 py-1.5 text-[11.5px]" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
              <span className="flex items-center gap-1.5"><b>{c.symbol}</b><span className="text-faint">{c.exit_reason?.replace("_", " ")} · {c.days_held}d</span></span>
              <span className="n" style={{ color: Number(c.pnl_inr) >= 0 ? "var(--c-gain)" : "var(--c-loss)" }}>{Number(c.r_multiple) >= 0 ? "+" : ""}{c.r_multiple}R · {signed(Number(c.pnl_inr))}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function LearningsCard({ learnings, onCompile, busy }) {
  const [show, setShow] = useState(false);
  return (
    <Card title="Learnings" icon={Brain} delay={0.15}
      right={<Btn icon={Lightning} onClick={onCompile} disabled={busy || learnings.closedCount < 10} title={learnings.closedCount < 10 ? "Needs 10 closed trades" : "Rewrite learnings from closed trades"}>Compile</Btn>}>
      <div className="text-[11.5px] text-ink2 mb-2">
        {learnings.applied ? <>Active from <b>N={learnings.sampleSize}</b> closed trades{learnings.compiledAt ? ` · compiled ${learnings.compiledAt.slice(0, 10)}` : ""}.</>
          : <>Inactive — rules adapt after <b>10</b> closed trades ({learnings.closedCount}/10 so far).</>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Kv k="RSI CAP" v={learnings.rsiMaxEntry} />
        <Kv k="MIN ADX" v={learnings.minAdx} />
        <Kv k="MAX HOLD" v={`${learnings.maxHoldingDays}d`} />
      </div>
      {learnings.skipList?.length > 0 && <div className="mt-2 text-[11px]"><b>Skip:</b> {learnings.skipList.join(", ")}</div>}
      {learnings.favorList?.length > 0 && <div className="mt-1 text-[11px]"><b>Favor:</b> {learnings.favorList.join(", ")}</div>}
      {learnings.markdown && (
        <>
          <button onClick={() => setShow((s) => !s)} className="mt-2 text-[11px] font-semibold" style={{ color: "var(--oat-accent)" }}>{show ? "Hide" : "Show"} full learnings</button>
          {show && <pre className="mt-2 text-[10.5px] whitespace-pre-wrap leading-snug rounded-[10px] p-3 max-h-[320px] overflow-y-auto" style={{ background: "var(--c-surface-2)" }}>{learnings.markdown}</pre>}
        </>
      )}
    </Card>
  );
}

function RulesCard() {
  const rules = [
    "Cash equity only — no F&O, options or futures.",
    "Large caps only (Nifty 100), ADV ≥ ₹5 cr.",
    "Max 3 concurrent open positions.",
    "Risk ≤ 1% of capital per trade; position ≤ 35%.",
    "R:R ≥ 1.5 to T1 (T2 at 3R).",
    "Halt new entries when the month is below −3%.",
    "Skip if results are < 7 days away or the stock is under ASM/GSM/T2T (manual check).",
  ];
  return (
    <Card title="Hard rules" icon={ShieldCheck} delay={0.2}>
      <ul className="flex flex-col gap-1.5 text-[11.5px] text-ink2 leading-snug">
        {rules.map((r) => <li key={r} className="flex gap-1.5"><CheckCircle size={13} weight="fill" className="shrink-0 mt-[1px]" style={{ color: "var(--oat-accent)" }} />{r}</li>)}
      </ul>
      <div className="mt-3 text-[10.5px] text-faint flex gap-1"><Info size={12} className="shrink-0 mt-[1px]" />Paper trading only — nothing here places a broker order. Prices: Kite live quotes, daily bars from NSE bhavcopy.</div>
    </Card>
  );
}

// ------------------------------------------------------------------ page

export default function SwingTrading() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [scan, setScan] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [analyzeSym, setAnalyzeSym] = useState(null);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [closing, setClosing] = useState(null);
  const [filling, setFilling] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`${API}?resource=dashboard`).then((r) => r.json())
      .then((b) => { if (b.error) setError(b.message || b.error); else { setError(null); setData(b); } })
      .catch((e) => setError(e.message));
  }, []);
  const runScan = useCallback((refresh = false) => {
    setScanLoading(true); setScanError(null);
    fetch(`${API}?resource=scan${refresh ? "&refresh=1" : ""}`).then((r) => r.json())
      .then((b) => { if (b.error) setScanError(b.message || b.error); else setScan(b); })
      .catch((e) => setScanError(e.message)).finally(() => setScanLoading(false));
  }, []);
  useEffect(() => { load(); runScan(false); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load, runScan]);

  const done = (msg) => { setNotice(msg); load(); };
  const discard = (p) => {
    if (!window.confirm(`Discard the proposed ${p.symbol} trade?`)) return;
    setBusy(true); call("discard", { id: p.id }).then(() => done(`${p.symbol} discarded.`)).catch((e) => setNotice(e.message)).finally(() => setBusy(false));
  };
  const trail = (p, stop) => {
    if (!window.confirm(`Raise ${p.symbol} stop from ${inr(p.stop)} to ${inr(stop)}? (Book 50% at T1 per plan.)`)) return;
    call("trail", { id: p.id, stop }).then(() => done(`${p.symbol} stop raised to ${inr(stop)}.`)).catch((e) => setNotice(e.message));
  };
  const compile = () => {
    setBusy(true);
    call("compile", {}).then((b) => done(b.ok ? `Learnings compiled: ${b.diff.length ? b.diff.join("; ") : "no rule changes"}.` : b.message))
      .catch((e) => setNotice(e.message)).finally(() => { setBusy(false); runScan(true); });
  };
  const openAnalyze = (sym) => { setAnalyzeSym(sym); setAnalyzeOpen(true); };

  if (data?.needsMigration) {
    return (
      <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-8">
        <Card title="Setup required" icon={Warning}>
          <div className="text-[12.5px] text-ink2">Run <code className="n">src/swing-india/migrations/001_swing_india.sql</code> in the Supabase SQL editor, then reload.</div>
        </Card>
      </div>
    );
  }

  const s = data?.stats;
  return (
    <div className="oat-page max-w-[1180px] mx-auto px-3 sm:px-6 py-5 sm:py-7">
      <motion.header initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}
        className="oat-hero rounded-[var(--radius-lg)] px-4 py-4 sm:px-6 sm:py-5 mb-4" style={{ border: "1px solid var(--c-line)", boxShadow: "var(--e-2)" }}>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center rounded-[12px] text-white shrink-0" style={{ width: 42, height: 42, background: "linear-gradient(135deg, var(--c-gain), var(--oat-blue))", boxShadow: "0 8px 20px rgba(16,150,90,.25)" }}>
              <TrendUp size={22} weight="bold" />
            </span>
            <div>
              <h1 className="font-display text-[20px] sm:text-[22px] font-bold tracking-[-0.02em] leading-tight">Swing Trading</h1>
              <div className="text-[11.5px] text-muted">Nifty 100 cash-equity swings · 3–15 day holds · paper trading</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data && <Pill tone={data.kiteConnected ? "gain" : "warn"}>{data.kiteConnected ? "LIVE QUOTES" : "STALE PRICES"}</Pill>}
            {data && <Pill tone="accent">PAPER · {inr(data.capital)}</Pill>}
            <button onClick={() => openAnalyze(null)} className="topstep"><MagnifyingGlass size={13} weight="bold" />Analyze</button>
            <button onClick={() => setSettingsOpen(true)} className="topstep"><Gear size={13} weight="bold" />Settings</button>
          </div>
        </div>
        <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mt-5 pt-4" style={{ borderTop: "1px solid var(--oat-hairline)" }}>
          <Stat label="UNREALIZED" value={data ? signed(data.portfolio.unrealized) : "—"} tone={data ? tone(data.portfolio.unrealized) : undefined}
            sub={data ? `${pct(data.portfolio.unrealizedPctInv)} on invested · ${n2(data.portfolio.deployedPct)}% deployed` : ""} />
          <Stat label="REALIZED" value={s?.count ? signed(s.realizedInr) : "—"} tone={s?.count ? tone(s.realizedInr) : undefined} sub={s ? `${s.count} closed` : ""} />
          <Stat label="WIN RATE" value={s?.winRate == null ? "—" : `${s.winRate}%`} sub={s?.avgR == null ? "no closed trades" : `avg ${s.avgR}R per trade`} />
          <Stat label="THIS MONTH" value={data ? pct(data.month.pct) : "—"} tone={data ? tone(data.month.pct) : undefined} sub={data ? `${signed(data.month.inr)} · halt below −3%` : ""} />
        </div>
      </motion.header>

      {error && <div className="mb-4 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-loss-soft)", color: "var(--c-loss)" }}>{error}</div>}
      {data?.warnings?.map((w) => (
        <div key={w} className="mb-3 flex items-center gap-2 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-warn-soft)" }}><Warning size={14} weight="bold" />{w}</div>
      ))}
      <AnimatePresence>{notice && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 flex items-center justify-between gap-2 text-[12px] rounded-[10px] px-3 py-2" style={{ background: "var(--c-accent-soft)" }}>
          <span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={13} /></button>
        </motion.div>
      )}</AnimatePresence>

      {!data ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {[0, 1].map((i) => <div key={i} className={`oat-glass rounded-[var(--radius-lg)] h-[240px] animate-pulse ${i === 0 ? "lg:col-span-7" : "lg:col-span-5"}`} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 flex flex-col gap-4">
            <OpenCard positions={data.open} slots={data.slots} onClose={setClosing} onTrail={trail} />
            <ProposedCard proposed={data.proposed} onOpen={setFilling} onDiscard={discard} busy={busy} />
          </div>
          <div className="lg:col-span-5 flex flex-col gap-4">
            <HistoryCard stats={data.stats} closed={data.closed} />
            <LearningsCard learnings={data.learnings} onCompile={compile} busy={busy} />
          </div>
          <div className="lg:col-span-12">
            <ScanCard scan={scan} loading={scanLoading} error={scanError} onRun={runScan} onAnalyze={openAnalyze} />
          </div>
          <div className="lg:col-span-12"><RulesCard /></div>
        </div>
      )}

      <AnalyzeDrawer open={analyzeOpen} symbol={analyzeSym} onClose={() => setAnalyzeOpen(false)} onProposed={done} />
      <CloseDrawer position={closing} onClose={() => setClosing(null)} onDone={done} />
      <FillDrawer position={filling} onClose={() => setFilling(null)} onDone={done} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} data={data} onDone={done} />
    </div>
  );
}
