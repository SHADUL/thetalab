import { useMemo, useState } from "react";
import { Lock, Trash } from "@phosphor-icons/react";
import { Card, Badge } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import { validateConfig, diffConfig, presetById } from "../../nifty-pulse/core/config.ts";
import { inr } from "./format.js";

const GROUPS = [
  ["Strategy thresholds", [
    ["shortReturnThresholdPct", "Short return threshold", "R5 must exceed ± this", "%", 0.001],
    ["longReturnThresholdPct", "Long return threshold", "R15 must exceed ± this", "%", 0.001],
    ["confirmMin", "Direction confirmation count", "changes that must agree", "", 1],
    ["confirmLookback", "Confirmation lookback", "most recent 1-second changes", "", 1],
  ]],
  ["Lookback windows", [
    ["shortReturnWindowSec", "Short return window", "R5", "s", 1],
    ["longReturnWindowSec", "Long return window", "R15", "s", 1],
    ["maWindowSec", "Moving-average window", "MA60", "s", 1],
  ]],
  ["Data quality", [
    ["tickFreshnessMs", "Index tick freshness", "older = STALE, no signals", "ms", 100],
    ["quoteFreshnessMs", "Minimum quote freshness", "option quotes older are untradeable", "ms", 100],
  ]],
  ["Spread selection", [
    ["shortOtmStepsMin", "Short strike — nearest", "steps OTM from ATM (0 = ATM)", "", 1],
    ["shortOtmStepsMax", "Short strike — farthest", "steps OTM from ATM", "", 1],
    ["widthStepsMin", "Width — minimum", "strike steps", "", 1],
    ["widthStepsMax", "Width — maximum", "strike steps", "", 1],
    ["lots", "Lots", "quantity = lots × exchange lot size", "", 1],
    ["minCreditPts", "Minimum entry credit", "after slippage", "pts", 0.05],
    ["maxBidAskPts", "Maximum bid/ask spread", "per leg", "pts", 0.05],
    ["maxBidAskPct", "Maximum bid/ask spread", "per leg, % of mid", "%", 0.5],
    ["minDepthMultiple", "Minimum liquidity", "top-of-book qty ÷ order qty", "×", 0.5],
  ]],
  ["Exits", [
    ["profitTargetPctOfCredit", "Profit target", "% of gross entry credit (net)", "%", 1],
    ["stopLossPctOfCredit", "Stop-loss", "% of gross entry credit (net)", "%", 1],
    ["maxHoldSec", "Maximum holding duration", "time exit", "s", 5],
    ["cooldownSec", "Cooldown", "after each close", "s", 5],
  ]],
  ["Risk", [
    ["capital", "Capital assumption", "research account", "₹", 10000],
    ["maxLossPerTrade", "Maximum trade risk", "worst case incl. costs", "₹", 100],
    ["maxDailyLoss", "Daily loss limit", "realized", "₹", 100],
    ["maxMarginAllocation", "Maximum margin allocation", "paper estimate", "₹", 1000],
    ["maxTradesPerDay", "Maximum trades per day", "", "", 1],
    ["maxConcurrentPositions", "Maximum concurrent positions", "Strategy A supports 1", "", 1],
  ]],
  ["Costs", [
    ["roundTripCostEstimate", "Round-trip cost estimate", "baseline comparison", "₹", 10],
    ["slippagePtsPerLeg", "Estimated slippage", "per leg per fill", "pts", 0.05],
    ["costModel", "Cost model for decisions", "FLAT estimate or DETAILED schedule", "", null],
  ]],
];

export default function Settings() {
  const s = usePulse((x) => x);
  const activeKey = pulse.activeConfigId();
  const [baseKey, setBaseKey] = useState(activeKey);
  const base = s.configs.find((c) => `${c.id}@${c.version}` === baseKey || (c.immutable && c.id === baseKey)) ?? s.config;
  const [draft, setDraft] = useState({});
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(null);
  const merged = useMemo(() => ({ ...base, ...draft }), [base, draft]);
  const issues = validateConfig(merged);
  const issueBy = Object.fromEntries(issues.map((i) => [i.key, i.message]));
  const changed = Object.keys(draft).filter((k) => draft[k] !== base[k]);
  const baseline = presetById("strategy-a-baseline");
  const isActive = (c) => (c.immutable ? activeKey === c.id : activeKey === `${c.id}@${c.version}`);
  const keyOf = (c) => (c.immutable ? c.id : `${c.id}@${c.version}`);

  const set = (k, raw) => {
    const v = k === "costModel" ? raw : raw === "" ? NaN : Number(raw);
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(null);
  };
  const save = () => {
    const changes = Object.fromEntries(changed.map((k) => [k, draft[k]]));
    try {
      const v = pulse.saveVersion(base, changes, name.trim() || undefined);
      setSaved(v);
      setDraft({});
      setName("");
      setBaseKey(`${v.id}@${v.version}`);
    } catch (e) {
      setSaved({ error: String(e.message ?? e) });
    }
  };

  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Settings</div>
          <div className="np-ws-desc">Research configuration · presets are immutable · every change is saved as a new version and stored with each paper trade</div>
        </div>
      </div>
      <div className="np-grid np-split-l" style={{ gridTemplateColumns: "minmax(0, 0.8fr) minmax(0, 1.2fr)" }}>
        <div className="np-grid" style={{ gap: 12 }}>
          <Card title="Configurations" sub="Active configuration drives the engine. Switching is only possible while flat.">
            <div className="np-grid" style={{ gap: 10 }}>
              {s.configs.map((c) => {
                const k = keyOf(c);
                const on = isActive(c);
                return (
                  <div key={k} className={`np-card ${on ? "np-card-glow" : ""}`} style={{ padding: 12, cursor: "pointer", outline: baseKey === k ? "2px solid var(--c-accent-soft)" : "none" }} onClick={() => { setBaseKey(k); setDraft({}); setSaved(null); }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <b style={{ fontSize: 13 }}>{c.name}</b>
                      {c.immutable ? <Badge tone="accent"><Lock size={10} weight="bold" />Immutable</Badge> : <Badge>v{c.version}</Badge>}
                      <Badge>Paper only</Badge>
                      {on && <Badge tone="gain">● Active</Badge>}
                    </div>
                    <div className="np-card-s n" style={{ marginTop: 4 }}>{c.id}@v{c.version}{c.parentId ? ` · from ${c.parentId}` : ""}</div>
                    <div className="np-note" style={{ marginTop: 6 }}>{c.description}</div>
                    <div className="flex items-center gap-3 flex-wrap text-[11.5px]" style={{ marginTop: 8 }}>
                      <span>Max risk <b className="n">{inr(c.maxLossPerTrade)}</b></span>
                      <span>Daily loss <b className="n">{inr(c.maxDailyLoss)}</b></span>
                      <span>Trades/day <b className="n">{c.maxTradesPerDay}</b></span>
                      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        {!c.immutable && <button className="np-chipbtn" onClick={(e) => { e.stopPropagation(); pulse.deleteVersion(c); }} aria-label={`Delete ${c.name}`}><Trash size={13} /></button>}
                        <button className="np-chipbtn" disabled={on || !!s.position} title={s.position ? "Close or flatten the open paper position first" : undefined}
                          onClick={(e) => { e.stopPropagation(); pulse.activate(k); }}>{on ? "Active" : "Activate"}</button>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card title="Differences from the baseline" sub={`${merged.name}${changed.length ? " + unsaved edits" : ""}`}>
            {diffConfig(baseline, merged).length === 0 ? <div className="np-note">Identical to Strategy A — Baseline.</div> : (
              <table className="np-table">
                <thead><tr><th>Setting</th><th className="r">Baseline</th><th className="r">This</th></tr></thead>
                <tbody>{diffConfig(baseline, merged).map((k) => <tr key={k}><td>{k}</td><td className="r n np-muted">{String(baseline[k])}</td><td className="r n" style={{ fontWeight: 650 }}>{String(merged[k])}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </div>

        <Card glow title={<span className="flex items-center gap-2">Edit from {base.name} {base.immutable && <Badge tone="accent"><Lock size={10} weight="bold" />Preset unchanged</Badge>}</span>}
          sub="Saving creates a new paper-only version; the original is never modified"
          tools={<>
            <input className="np-chipbtn" style={{ width: 200 }} placeholder="Version name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Version name" />
            <button className="np-chipbtn" disabled={!changed.length} onClick={() => { setDraft({}); setSaved(null); }}>Reset</button>
            <button className="np-chipbtn" data-on={changed.length > 0 && !issues.length} disabled={!changed.length || issues.length > 0} onClick={save}>Save as new version</button>
          </>}>
          {saved && (saved.error
            ? <div className="np-banner" style={{ marginBottom: 12 }}>{saved.error}</div>
            : <div className="np-banner" data-tone="accent" style={{ marginBottom: 12 }}>Saved <b>{saved.name}</b> ({saved.id}@v{saved.version}). Activate it from the list when flat. Versions are kept in this browser until Phase 4 stores them server-side.</div>)}
          {changed.length > 0 && <div className="np-note" style={{ marginBottom: 8 }}>{changed.length} unsaved change{changed.length > 1 ? "s" : ""}{issues.length ? ` · ${issues.length} problem${issues.length > 1 ? "s" : ""} to fix` : ""}</div>}
          <div className="np-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "6px 28px" }}>
            {GROUPS.map(([g, fields]) => (
              <section key={g} style={{ marginBottom: 10 }}>
                <div className="lbl" style={{ margin: "10px 0 2px" }}>{g}</div>
                {fields.map(([k, label, hint, unit, step]) => {
                  const val = merged[k];
                  return (
                    <div key={k} className="np-field" data-changed={changed.includes(k) ? "true" : undefined} data-err={issueBy[k] ? "true" : undefined}>
                      <label htmlFor={`np-${k}`}>{label}{unit && <span className="np-faint"> · {unit}</span>}</label>
                      {k === "costModel" ? (
                        <select id={`np-${k}`} value={val} onChange={(e) => set(k, e.target.value)}><option value="FLAT">FLAT estimate</option><option value="DETAILED">DETAILED schedule</option></select>
                      ) : (
                        <input id={`np-${k}`} type="number" step={step ?? "any"} value={Number.isFinite(val) ? val : ""} onChange={(e) => set(k, e.target.value)} inputMode="decimal" />
                      )}
                      <small>{issueBy[k] ? <span className="np-loss">{issueBy[k]}</span> : hint}</small>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
          <div className="np-note" style={{ marginTop: 6 }}>
            These are research parameters, not validated profitable settings. Thresholds for the baseline can only change through a new version; the immutable presets keep the exact original values.
          </div>
        </Card>
      </div>
    </>
  );
}
