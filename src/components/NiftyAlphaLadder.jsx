import { useState, useEffect, useCallback, useRef } from "react";
import { inr } from "./swingFormat.js";

// SHADOW dashboard only — Milestone 3 scope. AUTO is visible per your
// instruction but structurally locked in this component: there is no
// broker-order code anywhere in this file, no click handler ever sets
// execution_mode to AUTO, and the toggle below is disabled with an
// explanatory label rather than merely styled to look inactive.
const POLL_MS = 30_000;

function fmtPct(travelled, distance) {
  if (!distance) return "0%";
  return `${Math.round((Math.min(travelled, distance) / distance) * 100)}%`;
}

function SignalStatusBadge({ signal }) {
  if (!signal) {
    return <span className="text-[11px] font-semibold text-faint">WAITING — no signal yet this week</span>;
  }
  return (
    <span className="text-[11px] font-semibold text-gain">SIGNAL FIRED · {signal.path === "crossing" ? "crossing" : "cutoff"}</span>
  );
}

function OrderFlowReadCard({ signal }) {
  if (!signal) {
    return (
      <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <div className="text-[10.5px] font-semibold text-muted mb-2">ORDER FLOW READ</div>
        <div className="text-[11px] text-faint">No signal has fired yet this week — nothing to show until the large-order/imbalance engine produces a decision.</div>
      </div>
    );
  }
  const alignedLabel = signal.alpha === 1 ? "ALIGNED" : "DIVERGENT";
  return (
    <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="text-[10.5px] font-semibold text-muted mb-2">ORDER FLOW READ</div>
      <div className="grid grid-cols-2 gap-2.5 text-[11px]">
        <div><span className="text-faint">G1 (large-order net)</span><div className="n font-semibold mt-0.5">{signal.g1_at_signal ?? signal.g1AtSignal}</div></div>
        <div><span className="text-faint">A1 (signed area)</span><div className="n font-semibold mt-0.5">{Math.round(signal.area1 ?? 0).toLocaleString()}</div></div>
        <div><span className="text-faint">G2 (imbalance)</span><div className="n font-semibold mt-0.5">{signal.g2_at_signal ?? signal.g2AtSignal}</div></div>
        <div><span className="text-faint">A2 (signed area)</span><div className="n font-semibold mt-0.5">{(signal.area2 ?? 0).toFixed(2)}</div></div>
        <div><span className="text-faint">Large-order direction (d1)</span><div className="font-semibold mt-0.5">{signal.d1 > 0 ? "BULLISH" : signal.d1 < 0 ? "BEARISH" : "—"}</div></div>
        <div><span className="text-faint">Imbalance direction (d2)</span><div className="font-semibold mt-0.5">{signal.d2 > 0 ? "BULLISH" : signal.d2 < 0 ? "BEARISH" : "—"}</div></div>
        <div><span className="text-faint">Alignment</span><div className="font-semibold mt-0.5">{alignedLabel}</div></div>
        <div><span className="text-faint">Base direction (D0)</span><div className="font-semibold mt-0.5">{signal.base_direction > 0 ? "BULLISH" : "BEARISH"}</div></div>
        <div><span className="text-faint">India VIX</span><div className="n font-semibold mt-0.5">{signal.vix_available ?? signal.vixAvailable ? signal.vix_value ?? signal.vixValue : "unavailable"}</div></div>
        <div><span className="text-faint">Variation C</span><div className="font-semibold mt-0.5">{(signal.variation_c_acted ?? signal.variationCActed) ? "ACTED" : "DID NOT ACT"}</div></div>
      </div>
      <div className="mt-2.5 pt-2 flex items-center justify-between" style={{ borderTop: "1px solid var(--c-line)" }}>
        <span className="text-[10.5px] text-faint">FINAL DIRECTION</span>
        <span className={`text-[13px] font-bold ${(signal.final_direction ?? signal.finalDirection) > 0 ? "text-gain" : "text-loss"}`}>
          {(signal.final_direction ?? signal.finalDirection) > 0 ? "BULLISH" : "BEARISH"}
        </span>
      </div>
    </div>
  );
}

function PositionCard({ position }) {
  if (!position) {
    return (
      <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <div className="text-[10.5px] font-semibold text-muted mb-1">POSITION</div>
        <div className="text-[11px] text-faint">No SHADOW position live right now.</div>
      </div>
    );
  }
  const legs = position.alpha_ladder_legs ?? [];
  return (
    <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-semibold">NIFTY Alpha Ladder <span className="text-[9px] font-bold px-1 py-px rounded-[3px]" style={{ background: "var(--c-accent-10, rgba(99,102,241,.12))", color: "var(--c-accent)" }}>SHADOW</span></span>
        <span className={`text-[12px] font-semibold ${position.direction > 0 ? "text-gain" : "text-loss"}`}>{position.direction > 0 ? "BULLISH" : "BEARISH"}</span>
      </div>
      <table className="w-full text-[11px] mb-2">
        <tbody>
          {legs.sort((a, b) => a.placement_order - b.placement_order).map((l) => (
            <tr key={l.id} style={{ borderTop: "1px solid var(--c-line)" }}>
              <td className="py-1 pr-2 font-medium">{l.side}</td>
              <td className="py-1 pr-2">{l.ratio} × {l.strike}{l.option_right}</td>
              <td className="py-1 text-[10px] text-faint">{l.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div><span className="text-faint">Units</span><div className="n font-semibold">{position.units}</div></div>
        <div><span className="text-faint">Net Debit</span><div className="n font-semibold">{position.net_debit_points != null ? `${position.net_debit_points.toFixed(2)} pts` : "—"}</div></div>
        <div><span className="text-faint">Status</span><div className="font-semibold">{position.status}</div></div>
        <div><span className="text-faint">Max Loss</span><div className="n font-semibold text-loss">{position.max_loss != null ? inr(position.max_loss) : "—"}</div></div>
        <div><span className="text-faint">Max Gain</span><div className="n font-semibold text-gain">{position.max_gain != null ? inr(position.max_gain) : "—"}</div></div>
        <div><span className="text-faint">Tail Value</span><div className="n font-semibold">{position.tail_value != null ? inr(position.tail_value) : "—"}</div></div>
      </div>
    </div>
  );
}

function MonitorCard() {
  // Milestone 3: monitor state is not yet wired into the API (the
  // worker's execution loop that would create alpha_ladder_monitor_state
  // rows is not connected to a live feed — see the Milestone 3 report).
  // Shown as an honest empty state rather than fabricated numbers.
  return (
    <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="text-[10.5px] font-semibold text-muted mb-1">NIFTY FUTURE MONITOR</div>
      <div className="text-[11px] text-faint">No monitor leg active — nothing to track until a SHADOW structure is live.</div>
    </div>
  );
}

function HealthCard({ health }) {
  const latest = health?.health?.[0];
  return (
    <div className="rounded-[var(--radius-md)] p-2.5 flex items-center justify-between" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="flex items-center gap-4 text-[11px]">
        <div><span className="text-faint">Market feed</span> <span className="font-semibold ml-1">{latest?.status ?? "no worker running"}</span></div>
        <div><span className="text-faint">Depth source</span> <span className="font-semibold ml-1">Nearest NIFTY Future</span></div>
      </div>
      <span className="text-[10px] text-faint">{latest ? new Date(latest.updated_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</span>
    </div>
  );
}

function ActivityTimeline({ entries }) {
  if (!entries?.length) {
    return <div className="text-[11px] text-faint">No activity yet.</div>;
  }
  return (
    <div className="space-y-2">
      {entries.map((e) => (
        <div key={e.id} className="flex items-start gap-2 text-[11px]">
          <span className="text-faint n shrink-0">{new Date(e.created_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
          <span className={e.level === "error" ? "text-loss" : ""}>{e.message}</span>
        </div>
      ))}
    </div>
  );
}

export default function NiftyAlphaLadder() {
  const [summary, setSummary] = useState(null);
  const [activity, setActivity] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/options-autotrade?resource=alpha-ladder-summary").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=alpha-ladder-activity").then((r) => r.json()),
      fetch("/api/options-autotrade?resource=alpha-ladder-health").then((r) => r.json()),
    ])
      .then(([s, a, h]) => {
        if (s?.error) { setError(s.message || s.error); return; }
        setError(null);
        setSummary(s);
        setActivity(a?.entries ?? []);
        setHealth(h);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-4" style={{ background: "var(--c-bg)" }}>
      <div className="max-w-3xl mx-auto space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-bold">Nifty Alpha Ladder</h1>
          <div className="flex items-center gap-2">
            <button className="text-[11px] font-semibold px-2.5 py-1 rounded-[6px]" style={{ background: "var(--c-accent)", color: "#fff" }} disabled>
              SHADOW
            </button>
            <button
              className="text-[11px] font-semibold px-2.5 py-1 rounded-[6px] cursor-not-allowed opacity-60"
              style={{ border: "1px solid var(--c-line)" }}
              disabled
              title="AUTO is locked until the Milestone 4 readiness report is reviewed and you explicitly approve it — see NIFTY_ALPHA_LADDER_IMPLEMENTATION_PLAN.md."
            >
              AUTO · Locked
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-[var(--radius-md)] p-3 text-[11px]" style={{ border: "1px solid var(--c-loss)", background: "var(--c-surface)", color: "var(--c-loss)" }}>
            {error} — most likely the database migration hasn't been applied yet (see NIFTY_ALPHA_LADDER_MILESTONE3_SHADOW_REPORT.md).
          </div>
        )}

        {/* Priority 1-3: P&L/position, signal status, direction — folded into one signal card since Milestone 3 has no live position yet. */}
        <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10.5px] font-semibold text-muted">SIGNAL STATUS</span>
            <SignalStatusBadge signal={summary?.latestSignal} />
          </div>
          <div className="text-[11px] text-faint">Next signal day: Wednesday (Thursday only on a Wednesday exchange holiday).</div>
        </div>

        {/* Priority 4-5: structure/legs, order-flow read */}
        <PositionCard position={summary?.activePosition} />
        <OrderFlowReadCard signal={summary?.latestSignal} />

        {/* Priority 6: monitor */}
        <MonitorCard />

        {/* Priority 7: worker/feed health */}
        <HealthCard health={health} />

        {/* Priority 8: activity timeline */}
        <div className="rounded-[var(--radius-md)] p-3" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
          <div className="text-[10.5px] font-semibold text-muted mb-2">ACTIVITY</div>
          <ActivityTimeline entries={activity} />
        </div>
      </div>
    </div>
  );
}
