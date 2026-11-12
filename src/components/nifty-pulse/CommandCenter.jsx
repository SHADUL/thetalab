import { useState } from "react";
import { Card, Kpi, Spark, DirBadge, PnL, Timeline, Meter, Badge, Check } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import PulseChart from "./PulseChart.jsx";
import { istTime, num, pct, secs, inr, dur, KIND_LABEL } from "./format.js";

function lastPrices(samples, n) {
  const out = [];
  for (let i = Math.max(0, samples.length - n); i < samples.length; i++) out.push(samples[i].valid ? samples[i].price : null);
  return out;
}

function StatusStrip({ s }) {
  const items = [
    ["NIFTY 50 · SIM", s.price != null ? num(s.price, 2) : "WAITING", s.changePct != null ? (s.changePct >= 0 ? "gain" : "loss") : null],
    ["Day change", s.changePct != null ? `${s.changePct >= 0 ? "▲" : "▼"} ${pct(s.changePct, 2)}` : "—", s.changePct != null ? (s.changePct >= 0 ? "gain" : "loss") : null],
    ["Market", s.marketOpen ? "Open" : "Closed", null],
    ["IST (sim clock)", istTime(s.now), null],
    ["Last tick", s.lastTickAt ? istTime(s.lastTickAt, true) : "—", null],
    ["Data age", s.dataAgeMs != null ? secs(s.dataAgeMs) : "—", s.sample && !s.sample.valid ? "loss" : null],
    ["Feed health", s.sample?.valid ? `${s.feed.fresh + s.feed.held}/60 valid` : s.sample ? "STALE" : "WAITING", s.sample && !s.sample.valid ? "loss" : null],
    ["Engine", s.killSwitch ? "Killed" : s.running ? "Running" : "Stopped", s.running ? null : "warn"],
    ["Execution", "Paper", null],
  ];
  return (
    <div className="np-card np-strip">
      {items.map(([k, v, t]) => (
        <div key={k}>
          <div className="lbl" style={{ fontSize: 9 }}>{k}</div>
          <div className={`n ${t ? `np-${t}` : ""}`} style={{ fontSize: 13.5, fontWeight: 600, marginTop: 2, whiteSpace: "nowrap" }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

export function SignalPanel({ s }) {
  const sig = s.signal;
  const ind = s.indicators;
  const dir = sig?.direction ?? "NEUTRAL";
  const ready = ind?.ready;
  const lead = sig?.agreement?.side;
  const count = sig?.agreement?.count ?? 0;
  const ageSec = s.episode ? Math.round((s.now - s.episode.startedAt) / 1000) : null;
  const reason = s.statusReason;
  const reasonTone = /NO ELIGIBLE|Risk limit|stale|Kill|limit reached/i.test(reason) ? "loss" : /Waiting|Cooldown|stopped|pending/i.test(reason) ? "warn" : s.position ? "gain" : undefined;
  return (
    <Card bodyClass="" glow>
      <div className="np-signal-hero" data-dir={dir}>
        <div className="flex items-center justify-between">
          <div className="lbl">Current signal</div>
          <span className="np-card-s n">age {ageSec != null ? dur(ageSec) : "—"}</span>
        </div>
        <div className={`np-dir ${dir === "BULLISH" ? "np-gain" : dir === "BEARISH" ? "np-loss" : ""}`} style={{ margin: "10px 0 12px" }}>
          {dir === "BULLISH" ? "▲ " : dir === "BEARISH" ? "▼ " : "◆ "}{dir}
        </div>
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <span className="text-[11.5px] np-muted">Rule agreement{lead ? ` · ${lead.toLowerCase()}` : ""}</span>
          <b className="n text-[12px]">{ready ? `${count} / 4 rules` : "—"}</b>
        </div>
        <div className="np-segs" aria-label={`${count} of 4 rules agree`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ background: i < count ? (lead === "BEARISH" ? "var(--c-loss)" : "var(--c-gain)") : undefined, opacity: i < count ? (count === 4 ? 1 : 0.55) : 1 }} />
          ))}
        </div>
        <div className="np-note" style={{ marginTop: 6, fontSize: 10.5 }}>Rule agreement counts satisfied rules. It is not a probability of profit.</div>
      </div>
      <div className="np-card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <dl className="np-kv">
          <dt>5-second return</dt><dd className={ready ? (ind.r5 > 0 ? "np-gain" : ind.r5 < 0 ? "np-loss" : "") : "np-muted"}>{ready ? `${ind.r5 >= 0 ? "▲" : "▼"} ${pct(ind.r5, 4)}` : "—"}</dd>
          <dt>15-second return</dt><dd className={ready ? (ind.r15 > 0 ? "np-gain" : ind.r15 < 0 ? "np-loss" : "") : "np-muted"}>{ready ? `${ind.r15 >= 0 ? "▲" : "▼"} ${pct(ind.r15, 4)}` : "—"}</dd>
          <dt>60-second MA</dt><dd>{ready ? num(ind.ma60, 2) : "—"}</dd>
          <dt>Price vs MA60</dt><dd className={ready ? (ind.maDistance > 0 ? "np-gain" : ind.maDistance < 0 ? "np-loss" : "") : "np-muted"}>{ready ? `${num(ind.maDistance, 2, { sign: true })} pts` : "—"}</dd>
          <dt>Directional confirmation</dt><dd>{ready ? `${ind.ups}↑ ${ind.downs}↓ ${ind.flats}→` : "—"}</dd>
          <dt>Valid seconds in buffer</dt><dd>{ind ? `${Math.min(ind.validRun, 9999)}${ind.ready ? "" : ` / ${ind.needed}`}` : "—"}</dd>
        </dl>
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>Last five 1-second changes</div>
          <div className="np-chg">
            {ready ? ind.lastChanges.map((c, i) => (
              <span key={i} data-s={c.sign} title={`${num(c.delta, 2, { sign: true })} pts`}>{c.sign > 0 ? "▲" : c.sign < 0 ? "▼" : "→"} {Math.abs(c.delta).toFixed(2)}</span>
            )) : [0, 1, 2, 3, 4].map((i) => <span key={i}>—</span>)}
          </div>
        </div>
        {sig?.rules?.length > 0 && (
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: 2 }}>
              <span className="lbl">Rules</span>
              <span className="lbl" style={{ display: "flex", gap: 14 }}><span>Bull</span><span>Bear</span></span>
            </div>
            {sig.rules.map((r) => (
              <div key={r.key} className="np-rule" style={{ gridTemplateColumns: "minmax(0,1fr) auto 18px 18px", columnGap: 10 }}>
                <span className="np-muted">{r.label}</span>
                <span className="n" style={{ fontSize: 11.5 }}>{r.value}</span>
                <Check ok={r.bull} /><Check ok={r.bear} />
              </div>
            ))}
          </div>
        )}
        <div className="np-reason" data-tone={reasonTone}>
          <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: ".08em", marginTop: 2 }}>WHY</span>
          <span>{reason}</span>
        </div>
      </div>
    </Card>
  );
}

export function PositionCard({ s, go }) {
  const p = s.position;
  if (!p) {
    return (
      <Card title="Open paper position" sub="Strategy A allows one position at a time">
        <div className="flex items-center gap-3" style={{ minHeight: 120 }}>
          <div className="np-note" style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--c-text)" }}>Flat</div>
            {s.cooldownLeft > 0 ? `Cooldown active — ${s.cooldownLeft}s before the next entry is allowed.` : "No open paper position. Entries require all four momentum rules plus a liquid spread inside the risk limit."}
            {s.lastRejection && <div style={{ marginTop: 8 }}>Last rejection at {istTime(s.lastRejection.at)}: <span style={{ color: "var(--c-text)" }}>{s.lastRejection.reason}</span></div>}
          </div>
        </div>
      </Card>
    );
  }
  const held = Math.round((s.now - p.entryAt) / 1000);
  const m = p.mark;
  const progress = Math.min(1, held / s.config.maxHoldSec);
  return (
    <Card glow title={<span className="flex items-center gap-2">{p.id} <Badge tone={p.direction === "BULLISH" ? "gain" : "loss"}>{KIND_LABEL[p.kind]}</Badge> {p.status === "PENDING_EXIT" && <Badge tone="warn">Exit pending</Badge>}</span>}
      sub={`${p.short.tradingsymbol} / ${p.long.tradingsymbol} · ${p.qty} qty · ${p.configName}`}
      tools={<button className="np-chipbtn" onClick={() => go("paper-trades")}>Details</button>}>
      <div className="np-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }}>
        <div><div className="lbl">Marked net P&L</div><div className="n" style={{ fontSize: 20, fontWeight: 650, marginTop: 3 }}><PnL value={m?.markedNet ?? null} /></div><div className="np-card-s">{m?.priced ? "close-now · after ₹" + p.roundTripCost + " est. costs" : m ? m.reason : "—"}</div></div>
        <div><div className="lbl">Entry credit</div><div className="n" style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{num(p.creditPts, 2)} pts</div><div className="np-card-s">{inr(p.grossCredit)} gross</div></div>
        <div><div className="lbl">Closing debit</div><div className="n" style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{m?.closingDebitPts != null ? `${num(m.closingDebitPts, 2)} pts` : "—"}</div><div className="np-card-s">short ask − long bid</div></div>
        <div><div className="lbl">Target · Stop</div><div className="n" style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}><span className="np-gain">+{Math.round(p.targetPnl)}</span> · <span className="np-loss">{Math.round(p.stopPnl)}</span></div><div className="np-card-s">₹ marked net</div></div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="flex justify-between text-[11px] np-muted" style={{ marginBottom: 5 }}><span>Held {held}s</span><span>Time exit at {s.config.maxHoldSec}s</span></div>
        <Meter value={held} max={s.config.maxHoldSec} tone={progress > 0.8 ? "warn" : undefined} />
      </div>
    </Card>
  );
}

export default function CommandCenter({ go }) {
  const s = usePulse((x) => x);
  const [tf, setTf] = useState("1s");
  const [showMA, setShowMA] = useState(true);
  const [showSig, setShowSig] = useState(true);
  const samples = pulse.engine.samples;
  const sig = s.signal;
  const cfg = s.config;
  const lossPct = cfg.maxDailyLoss ? s.lossUsed / cfg.maxDailyLoss : 0;
  const spark = lastPrices(samples, 180);
  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Command Center</div>
          <div className="np-ws-desc">Strategy A · NIFTY 1-second momentum credit spread · {cfg.name}{cfg.immutable ? " (immutable preset)" : ` v${cfg.version}`}</div>
        </div>
      </div>
      <StatusStrip s={s} />
      <div className="np-grid np-kpis" style={{ marginBottom: 12 }}>
        <Kpi label="NIFTY · SIM" value={s.price != null ? num(s.price, 2) : "WAITING"} sub={s.changePct != null ? <span className={s.changePct >= 0 ? "np-gain" : "np-loss"}>{s.changePct >= 0 ? "▲" : "▼"} {pct(s.changePct, 2)} today</span> : "no data"}
          spark={<Spark values={spark} color="var(--c-accent)" />} />
        <Kpi label="Strategy signal" value={<DirBadge dir={sig?.direction ?? "NEUTRAL"} lg />} sub={s.episode && s.episode.direction !== "NEUTRAL" ? `since ${istTime(s.episode.startedAt)}` : "no active signal"} />
        <Kpi label="Rule agreement" value={s.indicators?.ready ? `${sig.agreement.count}/4` : "—"} sub={sig?.agreement?.side ? `${sig.agreement.side.toLowerCase()} rules · not a probability` : "waiting for data"}>
          <div className="np-segs" style={{ marginTop: "auto" }}>{[0, 1, 2, 3].map((i) => <span key={i} style={{ background: i < (sig?.agreement?.count ?? 0) ? (sig.agreement.side === "BEARISH" ? "var(--c-loss)" : "var(--c-gain)") : undefined }} />)}</div>
        </Kpi>
        <Kpi label="Open positions" value={`${s.position ? 1 : 0} / ${cfg.maxConcurrentPositions}`} sub={s.position ? `${KIND_LABEL[s.position.kind]} ${s.position.short.strike}/${s.position.long.strike}` : s.cooldownLeft ? `cooldown ${s.cooldownLeft}s` : "flat"} />
        <Kpi label="Realized P&L" value={<PnL value={s.realized} />} sub={`${s.tradesCount} closed · paper`} />
        <Kpi label="Unrealized P&L" value={<PnL value={s.unrealized} />} sub={s.position ? (s.position.mark?.priced ? "marked at close-now prices" : "cannot mark — quotes stale") : "no open position"} />
        <Kpi label="Daily risk used" value={`${Math.round(lossPct * 100)}%`} sub={`${inr(s.lossUsed)} of ${inr(cfg.maxDailyLoss)} loss limit`} tone={lossPct >= 1 ? "loss" : lossPct >= 0.7 ? "warn" : undefined}>
          <div style={{ marginTop: "auto" }}><Meter value={s.lossUsed} max={cfg.maxDailyLoss} /></div>
        </Kpi>
        <Kpi label="Trades today" value={`${s.tradesToday} / ${cfg.maxTradesPerDay}`} sub={`${s.stats.episodes} signals · ${s.stats.entries} entered`}>
          <div style={{ marginTop: "auto" }}><Meter value={s.tradesToday} max={cfg.maxTradesPerDay} tone={s.tradesToday >= cfg.maxTradesPerDay ? "warn" : undefined} /></div>
        </Kpi>
      </div>

      <div className="np-grid np-cc-main" style={{ marginBottom: 12 }}>
        <Card title="NIFTY 50 · real-time" sub="Synthetic replay · 1-second samples · IST"
          tools={<>
            <div className="np-seg" role="group" aria-label="Timeframe">
              {[["1s", "1s"], ["5s", "5s"], ["15s", "15s"], ["1m", "1m"]].map(([k, l]) => <button key={k} data-on={tf === k} onClick={() => setTf(k)}>{l}</button>)}
            </div>
            <button className="np-chipbtn" data-on={showMA} onClick={() => setShowMA(!showMA)}>MA60</button>
            <button className="np-chipbtn" data-on={showSig} onClick={() => setShowSig(!showSig)}>Signals</button>
          </>} bodyClass="">
          <PulseChart height={452} timeframe={tf} showMA={showMA} showSignals={showSig} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] np-muted" style={{ padding: "8px 14px", borderTop: "1px solid var(--c-line)" }}>
            <span><i style={{ display: "inline-block", width: 10, height: 2, background: "var(--c-accent)", verticalAlign: "middle", marginRight: 5 }} />tick received that second</span>
            <span><i style={{ display: "inline-block", width: 10, height: 2, background: "var(--c-accent)", opacity: .38, verticalAlign: "middle", marginRight: 5 }} />no tick — last price held (sampled)</span>
            <span><i style={{ display: "inline-block", width: 10, height: 6, background: "var(--c-loss)", opacity: .75, verticalAlign: "middle", marginRight: 5 }} />stale second — gap, not traded on</span>
            <span><i style={{ display: "inline-block", width: 10, height: 2, background: "var(--c-warn)", verticalAlign: "middle", marginRight: 5 }} />60-second MA</span>
            <span>Bars: ticks per second · ▲▼ paper entries · ■ exits</span>
          </div>
        </Card>
        <SignalPanel s={s} />
      </div>

      <div className="np-grid np-two">
        <PositionCard s={s} go={go} />
        <Card title="Signal timeline" sub="Why each signal was taken, rejected or expired" tools={<button className="np-chipbtn" onClick={() => go("live-market")}>Full timeline</button>}>
          <div style={{ maxHeight: 292, overflowY: "auto" }}>
            <Timeline events={pulse.engine.timeline} limit={14} />
          </div>
        </Card>
      </div>
    </>
  );
}
