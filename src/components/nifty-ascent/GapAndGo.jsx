/** Gap-and-Go workspace — the primary bot in full detail. */
import { useState } from "react";
import { useAscent } from "./store.js";
import { Card, Badge, Check, WsHead, KV, Reason, SideBadge } from "./ui.jsx";
import { lastIndex } from "./derive.js";
import { num, pct, hm, istTime, dur, REASON_LABEL } from "./format.js";
import { barStart, RESEARCH_RULES_V1 as R } from "../../nifty-ascent/core/rules.ts";

function Ring({ n, total = 31 }) {
  const r = 48, c = 2 * Math.PI * r, p = Math.min(1, n / total);
  return (
    <div className="na-ring" role="img" aria-label={`Opening range ${n} of ${total} closes`}>
      <svg width="112" height="112" viewBox="0 0 112 112">
        <circle cx="56" cy="56" r={r} fill="none" stroke="var(--c-surface-3)" strokeWidth="9" />
        <circle cx="56" cy="56" r={r} fill="none" stroke="url(#na-ring-g)" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} style={{ transition: "stroke-dasharray .4s" }} />
        <defs><linearGradient id="na-ring-g" x1="0" x2="1"><stop offset="0" stopColor="var(--c-accent)" /><stop offset="1" stopColor="var(--c-accent-2)" /></linearGradient></defs>
      </svg>
      <div className="na-ring-c"><div><b>{n}/{total}</b><span>closes</span></div></div>
    </div>
  );
}

/** Horizontal price scale: OR box, ±10% bands, previous close, live price. */
export function BandScale({ e, px }) {
  if (!e.or) return <div className="na-note" style={{ padding: 20 }}>The band scale appears once all 31 opening-range closes are confirmed (after 09:46:00).</div>;
  const pts = [e.or.downsideBand, e.or.upsideBand, e.prevClose, px].filter((v) => v != null);
  let lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = (hi - lo) * 0.12 || 10; lo -= pad; hi += pad;
  const x = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="na-scale" aria-hidden="true">
      <div className="na-scale-track" />
      <div className="na-scale-or" style={{ left: x(e.or.low), width: `calc(${x(e.or.high)} - ${x(e.or.low)})` }} />
      <div className="na-scale-mk" style={{ left: x(e.or.downsideBand), background: "var(--c-loss)" }} />
      <div className="na-scale-mk" style={{ left: x(e.or.upsideBand), background: "var(--c-gain)" }} />
      {e.prevClose != null && <div className="na-scale-mk" style={{ left: x(e.prevClose), background: "var(--c-text-2)", opacity: .6 }} />}
      <div className="na-scale-lb t na-loss" style={{ left: x(e.or.downsideBand) }}>down {num(e.or.downsideBand, 2)}</div>
      <div className="na-scale-lb t na-gain" style={{ left: x(e.or.upsideBand) }}>up {num(e.or.upsideBand, 2)}</div>
      <div className="na-scale-lb b" style={{ left: x((e.or.low + e.or.high) / 2) }}>OR {num(e.or.low, 2)}–{num(e.or.high, 2)}</div>
      {e.prevClose != null && <div className="na-scale-lb b na-muted" style={{ left: x(e.prevClose) }}>prev {num(e.prevClose, 2)}</div>}
      {px != null && <div className="na-scale-now" style={{ left: x(px) }} title={`NIFTY ${px}`} />}
    </div>
  );
}

export default function GapAndGo() {
  const S = useAscent();
  const e = S.replay.engine, now = S.replay.t;
  const [open, setOpen] = useState(false);
  const px = lastIndex(e)?.price;
  const orBars = e.index.bars.filter((b) => b.label >= R.orFirstBar && b.label <= R.orLastBar);
  const msTo1200 = barStart(e.date, R.gapGoLastBar + 1) - now;
  const up = e.gap?.direction === "UP";
  const sigGG = e.signal?.bot === "GAP_AND_GO" ? e.signal : null;
  const highlight = sigGG?.bar ?? e.standDown?.bar;
  const windowState = now < barStart(e.date, R.gapGoFirstBar) ? "not open (opens with the 09:46 bar)" : msTo1200 > 0 ? `open · ${dur(Math.ceil(msTo1200 / 1000))} until the 12:00 bar closes` : "closed (12:00 bar confirmed)";
  const outcome = sigGG ? { tone: "gain", tag: "SIGNAL", text: `Directional breakout: close ${num(sigGG.close, 2)} ${up ? ">" : "<"} ${num(sigGG.level, 2)} on the ${hm(sigGG.bar)} bar → BUY ${sigGG.right}.` }
    : e.standDown ? { tone: "warn", tag: "STAND DOWN", text: `${REASON_LABEL[e.standDown.reason]} — at ${hm(e.standDown.bar)} (close ${num(e.standDown.close, 2)}).` }
    : e.outcome?.reason === "no_gap" ? { tone: "warn", tag: "NO DIRECTION", text: "Zero gap: Gap-and-Go has no direction today (Q14)." }
    : e.outcome?.kind === "DATA_ERROR" ? { tone: "loss", tag: "DATA ERROR", text: e.outcome.detail }
    : { tone: undefined, tag: "PENDING", text: e.or ? "Watching 1-minute closes against the bands." : "Waiting for the opening range." };

  return (
    <>
      <WsHead title="Gap-and-Go" desc="Primary bot · 31 one-minute closes 09:15–09:45 · ±10% of OR width · strict close beyond the band · 09:46–12:00 · gap-up → CE only, gap-down → PE only" />
      <div className="na-grid na-split-l" style={{ marginBottom: 12 }}>
        <Card title="Opening range" sub="From confirmed 1-minute CLOSES — candle highs and lows are never used" glow>
          <div className="flex items-center gap-5 flex-wrap">
            <Ring n={e.orCollected} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <KV rows={[
                ["OR high (max close)", e.or ? num(e.or.high, 2) : "—"],
                ["OR low (min close)", e.or ? num(e.or.low, 2) : "—"],
                ["Width W", e.or ? num(e.or.width, 2) : "—"],
                ["Upper band = high + 0.10·W", e.or ? num(e.or.upsideBand, 2) : "—", "gain"],
                ["Lower band = low − 0.10·W", e.or ? num(e.or.downsideBand, 2) : "—", "loss"],
                ["Window", "bars 09:15 … 09:45 (inclusive)"],
              ]} />
            </div>
          </div>
          <BandScale e={e} px={px} />
          <button className="na-chipbtn" onClick={() => setOpen(!open)} aria-expanded={open} style={{ marginTop: 6 }}>{open ? "Hide" : "Show"} all {orBars.length} closes</button>
          {open && (
            <div className="na-closes" style={{ marginTop: 10 }}>
              {orBars.map((b) => (
                <div key={b.label} data-x={e.or && b.close === e.or.high ? "hi" : e.or && b.close === e.or.low ? "lo" : undefined} title={`last tick ${istTime(b.lastExchTs, true)} · ${b.ticks} ticks`}>
                  <span>{hm(b.label)}</span><b>{b.close != null ? num(b.close, 2) : "MISSING"}</b>
                </div>
              ))}
            </div>
          )}
        </Card>
        <div style={{ display: "grid", gap: 12 }}>
          <Card title="Gap" sub="Previous day 15:15 close vs today's first tick at/after 09:15:00">
            <KV rows={[
              ["Previous 15:15 close", num(e.prevClose, 2)],
              ["Today's reference", e.reference ? `${num(e.reference.price, 2)} · ${istTime(e.reference.exchTs, true)}` : "—"],
              ["Gap", e.gap ? `${num(e.gap.points, 2, { sign: true })} pts · ${pct(e.gap.pct, 4, { sign: false })}` : "—"],
              ["Direction (fixed for the day)", e.gap ? (up ? "▲ GAP UP → only CE" : e.gap.direction === "DOWN" ? "▼ GAP DOWN → only PE" : "◆ zero gap") : "—", up ? "gain" : e.gap?.direction === "DOWN" ? "loss" : undefined],
            ]} />
          </Card>
          <Card title="Stand-down watch">
            <div className="na-rule"><Check ok={!e.gapFill} /><span>Gap not filled (tick-based, Q3)</span><span className="na-muted n">{e.gapFill ? `filled ${istTime(e.gapFill.exchTs)} @ ${num(e.gapFill.price, 2)}` : "open"}</span></div>
            <div className="na-rule"><Check ok={e.standDown?.reason !== "opposite_first"} /><span>Opposite band not broken first</span><span className="na-muted n">{e.standDown?.reason === "opposite_first" ? `broken ${hm(e.standDown.bar)}` : "intact"}</span></div>
            <div className="na-rule"><Check ok={msTo1200 > 0 || !!sigGG} /><span>Signal window 09:46–12:00</span><span className="na-muted n" style={{ whiteSpace: "normal", textAlign: "right" }}>{windowState}</span></div>
            <div className="na-rule"><Check ok={e.state === "GAP_GO_ARMED"} /><span>Currently eligible to signal</span><span className="na-muted">{e.state === "GAP_GO_ARMED" ? "yes" : "no"}</span></div>
          </Card>
        </div>
      </div>
      <div className="na-grid na-two">
        <Card title="Outcome" sub="The exact reason is recorded with its bar and close">
          <Reason tone={outcome.tone} tag={outcome.tag}>{outcome.text}</Reason>
          {sigGG && <div className="flex items-center gap-2" style={{ marginTop: 10 }}><SideBadge right={sigGG.right} lg /><span className="na-muted" style={{ fontSize: 12 }}>signal confirmed at {istTime(sigGG.at)} · enters on the next bar</span></div>}
        </Card>
        <Card title="Gap-and-Go window closes" sub="Every confirmed close evaluated 09:46–12:00, newest first" bodyClass="">
          <div className="na-tablewrap" style={{ maxHeight: 270, overflowY: "auto" }}>
            <table className="na-table">
              <thead><tr><th>Bar</th><th className="r">Close</th><th className="r">vs up band</th><th className="r">vs down band</th><th>Result</th></tr></thead>
              <tbody>
                {e.index.bars.filter((b) => b.label >= R.gapGoFirstBar && b.label <= R.gapGoLastBar && (!highlight || b.label <= highlight)).slice(-40).reverse().map((b) => (
                  <tr key={b.label} data-sel={b.label === highlight ? "true" : undefined}>
                    <td>{hm(b.label)}</td>
                    <td className="r">{b.close != null ? num(b.close, 2) : "MISSING"}</td>
                    <td className="r">{e.or && b.close != null ? num(b.close - e.or.upsideBand, 2, { sign: true }) : "—"}</td>
                    <td className="r">{e.or && b.close != null ? num(b.close - e.or.downsideBand, 2, { sign: true }) : "—"}</td>
                    <td>{b.label === sigGG?.bar ? <Badge tone="gain">breakout</Badge> : b.label === e.standDown?.bar ? <Badge tone="warn">{e.standDown.reason}</Badge> : <span className="na-faint">inside</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
