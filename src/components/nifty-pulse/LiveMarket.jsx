import { useMemo, useState } from "react";
import { Card, Spark, Timeline, Badge } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import PulseChart from "./PulseChart.jsx";
import { num, secs } from "./format.js";

/** Indicator history over the last `n` seconds (null where data was invalid). */
function history(samples, n, cfg) {
  const out = { r5: [], r15: [], dist: [] };
  const start = Math.max(0, samples.length - n);
  for (let i = start; i < samples.length; i++) {
    const p = (k) => (i - k >= 0 && samples[i - k].valid ? samples[i - k].price : null);
    let okRun = true;
    for (let k = 0; k <= cfg.longReturnWindowSec && okRun; k++) if (p(k) == null) okRun = false;
    const now = p(0);
    out.r5.push(okRun ? (now / p(cfg.shortReturnWindowSec) - 1) * 100 : null);
    out.r15.push(okRun ? (now / p(cfg.longReturnWindowSec) - 1) * 100 : null);
    let sum = 0, m = 0;
    for (let k = 0; k < cfg.maWindowSec; k++) { const v = p(k); if (v == null) break; sum += v; m++; }
    out.dist.push(m === cfg.maWindowSec ? now - sum / m : null);
  }
  return out;
}

function IndicatorTile({ label, value, series, threshold, unit, dp = 4 }) {
  const v = value;
  const tone = v == null ? "" : threshold != null ? (v > threshold ? "np-gain" : v < -threshold ? "np-loss" : "") : v > 0 ? "np-gain" : v < 0 ? "np-loss" : "";
  return (
    <div className="np-card" style={{ padding: "11px 12px" }}>
      <div className="flex items-center justify-between">
        <span className="lbl">{label}</span>
        {threshold != null && <span className="np-card-s n">±{threshold}{unit}</span>}
      </div>
      <div className={`n ${tone}`} style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 6px" }}>
        {v == null ? "—" : `${v > 0 ? "▲" : v < 0 ? "▼" : "▪"} ${num(v, dp, { sign: true })}${unit}`}
      </div>
      <Spark values={series} height={44} baseline={0} color="var(--c-accent)" />
      <div className="flex justify-between np-card-s" style={{ marginTop: 3 }}><span>−3 min</span><span>now</span></div>
    </div>
  );
}

function TickBars({ samples }) {
  const last = samples.slice(-60);
  const w = 600, h = 70, bw = w / 60;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Ticks received per second, last 60 seconds">
      {last.map((s, i) => {
        const stale = !s.valid;
        const v = stale ? 3 : Math.min(3, s.ticks);
        const bh = stale ? h - 6 : v === 0 ? 3 : (v / 3) * (h - 8);
        return <rect key={s.t} x={i * bw + 1} y={h - bh} width={bw - 2} height={bh} rx="1.5"
          fill={stale ? "var(--c-loss)" : v === 0 ? "var(--c-line-2)" : "var(--c-accent)"} opacity={stale ? 0.55 : v === 0 ? 1 : 0.35 + v * 0.2} />;
      })}
    </svg>
  );
}

function QuoteBoard({ s }) {
  const chain = pulse.chain();
  const atm = Math.round(chain.spot / chain.strikeStep) * chain.strikeStep;
  const strikes = Array.from({ length: 13 }, (_, i) => atm + (6 - i) * chain.strikeStep);
  const legs = new Set(s.position ? [`${s.position.short.strike}${s.position.short.right}`, `${s.position.long.strike}${s.position.long.right}`] : []);
  const cell = (q, key) => {
    if (!q) return <><td className="r np-faint">—</td><td className="r np-faint">—</td><td className="r np-faint">—</td><td className="r np-faint">—</td></>;
    const sp = q.bid != null && q.ask != null ? q.ask - q.bid : null;
    const age = q.ts != null ? chain.at - q.ts : null;
    const stale = age == null || age > s.config.quoteFreshnessMs;
    const hl = legs.has(key) ? { background: "var(--c-accent-soft)", fontWeight: 650 } : undefined;
    return (
      <>
        <td className="r n" style={hl}>{q.bid != null ? num(q.bid, 2) : <span className="np-loss">no bid</span>}<div className="np-faint" style={{ fontSize: 10 }}>{q.bidQty || ""}</div></td>
        <td className="r n" style={hl}>{q.ask != null ? num(q.ask, 2) : <span className="np-loss">no ask</span>}<div className="np-faint" style={{ fontSize: 10 }}>{q.askQty || ""}</div></td>
        <td className={`r n ${sp != null && sp > s.config.maxBidAskPts ? "np-loss" : ""}`}>{sp != null ? sp.toFixed(2) : "—"}</td>
        <td className={`r n ${stale ? "np-loss" : "np-muted"}`}>{age != null ? secs(age) : "—"}</td>
      </>
    );
  };
  return (
    <div className="np-tablewrap">
      <table className="np-table" style={{ fontSize: 11.5 }}>
        <thead>
          <tr><th className="r" colSpan={4} style={{ textAlign: "center" }}>Calls (CE)</th><th className="c">Strike</th><th className="r" colSpan={4} style={{ textAlign: "center" }}>Puts (PE)</th></tr>
          <tr><th className="r">Bid · qty</th><th className="r">Ask · qty</th><th className="r">Spread</th><th className="r">Age</th><th className="c">{chain.expiry}</th><th className="r">Bid · qty</th><th className="r">Ask · qty</th><th className="r">Spread</th><th className="r">Age</th></tr>
        </thead>
        <tbody>
          {strikes.map((k) => (
            <tr key={k} style={k === atm ? { boxShadow: "inset 0 1px 0 var(--c-accent), inset 0 -1px 0 var(--c-accent)" } : undefined}>
              {cell(chain.quote(k, "CE"), `${k}CE`)}
              <td className="c n" style={{ fontWeight: 650, background: "var(--c-surface-2)" }}>{k}{k === atm && <div className="np-accent" style={{ fontSize: 9, letterSpacing: ".08em" }}>ATM</div>}</td>
              {cell(chain.quote(k, "PE"), `${k}PE`)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KINDS = ["ALL", "SIGNAL", "SELECTION", "REJECT", "ENTRY", "EXIT", "EXPIRED", "DATA", "ENGINE"];

export default function LiveMarket() {
  const s = usePulse((x) => x);
  const [kind, setKind] = useState("ALL");
  const samples = pulse.engine.samples;
  const cfg = s.config;
  // Recompute once per store update, not per render.
  const h = useMemo(() => history(samples, 180, cfg), [s.v, cfg]); // eslint-disable-line react-hooks/exhaustive-deps
  const ind = s.indicators?.ready ? s.indicators : null;
  const last60 = samples.slice(-60);
  let u60 = 0, d60 = 0, f60 = 0;
  for (let i = 1; i < last60.length; i++) {
    if (!last60[i].valid || !last60[i - 1].valid) continue;
    const d = last60[i].price - last60[i - 1].price;
    if (d > 0) u60++; else if (d < 0) d60++; else f60++;
  }
  const events = kind === "ALL" ? pulse.engine.timeline : pulse.engine.timeline.filter((e) => e.kind === kind);
  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Live Market</div>
          <div className="np-ws-desc">Index series, data quality, option quotes and the decision timeline · SIMULATION source</div>
        </div>
      </div>
      <div className="np-grid np-split-l" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", marginBottom: 12 }}>
        <Card title="NIFTY 50 · one-second sampled series" sub="Line = 1-second samples · bars = exchange ticks received each second" bodyClass="">
          <PulseChart height={360} timeframe="1s" showMA showSignals compact />
        </Card>
        <div className="np-grid" style={{ gridTemplateColumns: "1fr", gap: 12 }}>
          <IndicatorTile label={`${cfg.shortReturnWindowSec}-second return`} value={ind?.r5 ?? null} series={h.r5} threshold={cfg.shortReturnThresholdPct} unit="%" />
          <IndicatorTile label={`${cfg.longReturnWindowSec}-second return`} value={ind?.r15 ?? null} series={h.r15} threshold={cfg.longReturnThresholdPct} unit="%" />
          <IndicatorTile label={`Distance from MA${cfg.maWindowSec}`} value={ind?.maDistance ?? null} series={h.dist} unit=" pts" dp={2} />
        </div>
      </div>

      <div className="np-grid np-three" style={{ marginBottom: 12 }}>
        <Card title="Tick arrival" sub="Last 60 seconds · Kite does not send exactly one tick per second">
          <TickBars samples={samples} />
          <div className="np-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10 }}>
            {[["Ticks", s.feed.ticks60], ["Fresh s", s.feed.fresh], ["Held s", s.feed.held], ["Stale s", s.feed.stale]].map(([k, v]) => (
              <div key={k}><div className="lbl">{k}</div><div className={`n ${k === "Stale s" && v ? "np-loss" : ""}`} style={{ fontSize: 16, fontWeight: 600 }}>{v}</div></div>
            ))}
          </div>
        </Card>
        <Card title="Data freshness" sub="Receipt-time freshness · exchange-time ordering">
          <dl className="np-kv">
            <dt>Latest sample</dt><dd><Badge tone={s.sample?.valid ? "gain" : "loss"}>{s.sample?.status ?? "WAITING"}</Badge></dd>
            <dt>Price age at sample</dt><dd>{secs(s.dataAgeMs)}</dd>
            <dt>Freshness limit</dt><dd>{secs(cfg.tickFreshnessMs)}</dd>
            <dt>Tick latency (avg · max)</dt><dd>{s.feed.latAvg != null ? `${Math.round(s.feed.latAvg)} · ${s.feed.latMax} ms` : "—"}</dd>
            <dt>Feed gaps today</dt><dd>{s.feed.gaps}</dd>
            <dt>Ticks accepted · dropped</dt><dd>{s.feed.accepted.toLocaleString("en-IN")} · {s.feed.dropped}</dd>
            <dt>Option quote limit</dt><dd>{secs(cfg.quoteFreshnessMs)}</dd>
          </dl>
        </Card>
        <Card title="Directional change counters" sub="One-second price changes · flat never counts as confirmation">
          <div className="lbl" style={{ marginBottom: 6 }}>Last {cfg.confirmLookback} seconds</div>
          <div className="np-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
            <div><div className="np-gain n" style={{ fontSize: 22, fontWeight: 650 }}>▲ {ind?.ups ?? "—"}</div><div className="np-card-s">up</div></div>
            <div><div className="np-loss n" style={{ fontSize: 22, fontWeight: 650 }}>▼ {ind?.downs ?? "—"}</div><div className="np-card-s">down</div></div>
            <div><div className="n" style={{ fontSize: 22, fontWeight: 650 }}>→ {ind?.flats ?? "—"}</div><div className="np-card-s">flat</div></div>
          </div>
          <div className="lbl" style={{ marginBottom: 6 }}>Last 60 seconds</div>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--c-surface-3)" }} aria-label={`${u60} up, ${d60} down, ${f60} flat`}>
            <span style={{ flex: u60, background: "var(--c-gain)" }} /><span style={{ flex: f60, background: "var(--c-line-2)" }} /><span style={{ flex: d60, background: "var(--c-loss)" }} />
          </div>
          <div className="flex justify-between np-card-s n" style={{ marginTop: 5 }}><span>▲ {u60} up</span><span>→ {f60} flat</span><span>▼ {d60} down</span></div>
          <div className="np-note" style={{ marginTop: 10 }}>Confirmation needs ≥ {cfg.confirmMin} of the last {cfg.confirmLookback} changes in the signal direction.</div>
        </Card>
      </div>

      <div className="np-grid np-split-l" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)" }}>
        <Card title="Option quotes · nearest weekly" sub={`Best bid/ask with top-of-book quantity · ATM ±6 · position legs highlighted · SIM spot ${num(s.price, 2)}`} bodyClass="">
          <QuoteBoard s={s} />
        </Card>
        <Card title="Signal timeline" sub={`${pulse.engine.timeline.length.toLocaleString("en-IN")} events this session`}
          tools={<select className="np-chipbtn" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter events">{KINDS.map((k) => <option key={k} value={k}>{k === "ALL" ? "All events" : k.toLowerCase()}</option>)}</select>}>
          <div style={{ maxHeight: 520, overflowY: "auto" }}><Timeline events={events} limit={80} showKind /></div>
        </Card>
      </div>
      <div className="np-note" style={{ marginTop: 10 }}>All figures on this page come from the deterministic replay and are synthetic.</div>
    </>
  );
}
