import { useMemo, useState } from "react";
import { Card, Badge, Check, PnL } from "./ui.jsx";
import { usePulse, pulse } from "./store.js";
import { buildCandidates, priceSpread, expiryPayoff } from "../../nifty-pulse/core/spreads.ts";
import { approveCandidate } from "../../nifty-pulse/core/risk.ts";
import { istTime, num, inr, secs, KIND_LABEL } from "./format.js";

function Payoff({ cand, spot }) {
  const W = 640, H = 260, P = { l: 56, r: 16, t: 16, b: 30 };
  const k1 = cand.short.strike, k2 = cand.long.strike;
  const lo = Math.min(k1, k2, spot) - Math.max(150, cand.widthPts * 2.5);
  const hi = Math.max(k1, k2, spot) + Math.max(150, cand.widthPts * 2.5);
  const xs = [lo, Math.min(k1, k2), Math.max(k1, k2), hi];
  const pts = xs.map((x) => [x, expiryPayoff(cand, x)]);
  const ys = pts.map((p) => p[1]);
  const yMax = Math.max(...ys, 0), yMin = Math.min(...ys, 0);
  const pad = (yMax - yMin) * 0.12 || 100;
  const Y0 = yMin - pad, Y1 = yMax + pad;
  const X = (x) => P.l + ((x - lo) / (hi - lo)) * (W - P.l - P.r);
  const Yp = (y) => P.t + (1 - (y - Y0) / (Y1 - Y0)) * (H - P.t - P.b);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Yp(y).toFixed(1)}`).join("");
  const area = `${d}L${X(hi)},${Yp(0)}L${X(lo)},${Yp(0)}Z`;
  const be = cand.breakeven;
  const ticks = [Y0 + pad, 0, Y1 - pad].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Expiry payoff diagram">
      <defs>
        <clipPath id="np-above"><rect x="0" y="0" width={W} height={Yp(0)} /></clipPath>
        <clipPath id="np-below"><rect x="0" y={Yp(0)} width={W} height={H} /></clipPath>
      </defs>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={P.l} x2={W - P.r} y1={Yp(v)} y2={Yp(v)} stroke={v === 0 ? "var(--c-line-2)" : "var(--c-grid)"} strokeDasharray={v === 0 ? "" : "3 4"} />
          <text x={P.l - 8} y={Yp(v) + 4} textAnchor="end" fontSize="10.5" fill="var(--c-muted)">{inr(v)}</text>
        </g>
      ))}
      <path d={area} fill="var(--c-gain)" opacity=".12" clipPath="url(#np-above)" />
      <path d={area} fill="var(--c-loss)" opacity=".12" clipPath="url(#np-below)" />
      <path d={d} fill="none" stroke="var(--c-accent)" strokeWidth="2.2" strokeLinejoin="round" />
      {[[k1, "short"], [k2, "long"]].map(([k, l]) => (
        <g key={l}>
          <line x1={X(k)} x2={X(k)} y1={P.t} y2={H - P.b} stroke="var(--c-line-2)" strokeDasharray="2 3" />
          <text x={X(k)} y={H - 12} textAnchor="middle" fontSize="10.5" fill="var(--c-text-2)">{k} {l}</text>
        </g>
      ))}
      {be != null && (
        <g>
          <circle cx={X(be)} cy={Yp(0)} r="3.5" fill="var(--c-surface)" stroke="var(--c-text)" strokeWidth="1.5" />
          <text x={X(be)} y={Yp(0) - 8} textAnchor="middle" fontSize="10.5" fill="var(--c-text)">BE {num(be, 1)}</text>
        </g>
      )}
      <line x1={X(spot)} x2={X(spot)} y1={P.t} y2={H - P.b} stroke="var(--c-warn)" strokeWidth="1.5" />
      <text x={X(spot) + 4} y={P.t + 10} fontSize="10.5" fill="var(--c-warn)">spot {num(spot, 1)}</text>
      <text x={X(lo) + 2} y={H - 2} fontSize="10" fill="var(--c-faint)">{Math.round(lo)}</text>
      <text x={X(hi) - 2} y={H - 2} textAnchor="end" fontSize="10" fill="var(--c-faint)">{Math.round(hi)}</text>
    </svg>
  );
}

function LegRow({ leg, side, entry, qty }) {
  return (
    <tr>
      <td><Badge tone={side === "SELL" ? "loss" : "gain"}>{side}</Badge></td>
      <td className="n">{leg.tradingsymbol}</td>
      <td className="r n">{qty}</td>
      <td className="r n">{leg.bid != null ? num(leg.bid, 2) : "—"}<div className="np-faint" style={{ fontSize: 10 }}>{leg.bidQty}</div></td>
      <td className="r n">{leg.ask != null ? num(leg.ask, 2) : "—"}<div className="np-faint" style={{ fontSize: 10 }}>{leg.askQty}</div></td>
      <td className="r n">{leg.spreadPts != null ? leg.spreadPts.toFixed(2) : "—"}</td>
      <td className="r n">{secs(leg.ageMs)}</td>
      <td className="r n" style={{ fontWeight: 650 }}>{entry != null ? num(entry, 2) : "—"}<div className="np-faint" style={{ fontSize: 10 }}>{side === "SELL" ? "bid − slip" : "ask + slip"}</div></td>
    </tr>
  );
}

export default function SpreadBuilder() {
  const mode = usePulse((x) => x.mode);
  usePulse((x) => x.v);
  if (!pulse.chain()) {
    return (
      <>
        <div className="np-ws-head"><div><div className="np-ws-title">Spread Builder</div><div className="np-ws-desc">Paper analysis of bull put and bear call spreads</div></div></div>
        <div className="np-card" style={{ padding: 28, textAlign: "center" }}>
          <div style={{ fontWeight: 650, marginBottom: 6 }}>Waiting for the {mode === "LIVE" ? "live" : ""} option chain</div>
          <div className="np-note">Strikes and quotes appear once NIFTY is trading and the instrument master is loaded (trading days, 09:10–15:30 IST). Switch to Simulation to explore with replay data.</div>
        </div>
      </>
    );
  }
  return <SpreadBuilderInner />;
}

function SpreadBuilderInner() {
  const s = usePulse((x) => x);
  const [dir, setDir] = useState(() => (s.signal?.agreement?.side === "BEARISH" ? "BEARISH" : "BULLISH"));
  const [sel, setSel] = useState(null); // { short, width }
  const [lots, setLots] = useState(1);
  const [frozen, setFrozen] = useState(null); // chain snapshot when frozen
  const live = pulse.chain();
  const chain = frozen ?? live;
  const cfg = useMemo(() => ({ ...s.config, lots }), [s.config, lots]);
  const cands = useMemo(() => buildCandidates(chain, dir, cfg), [chain, dir, cfg]);
  const riskState = pulse.engine.riskState(chain.at, true);
  const atm = Math.round(chain.spot / chain.strikeStep) * chain.strikeStep;
  const pick = sel ?? { short: cands[0]?.short.strike ?? atm, width: Math.round((cands[0]?.widthPts ?? 50) / chain.strikeStep) };
  const cand = priceSpread(chain, dir === "BULLISH" ? "BULL_PUT" : "BEAR_CALL", pick.short, pick.width, cfg);
  const risk = approveCandidate(cand, riskState, cfg);
  const shortChoices = Array.from({ length: 9 }, (_, i) => (dir === "BULLISH" ? atm - (i - 2) * chain.strikeStep : atm + (i - 2) * chain.strikeStep));

  return (
    <>
      <div className="np-ws-head">
        <div>
          <div className="np-ws-title">Spread Builder</div>
          <div className="np-ws-desc">Explore vertical credit spreads at executable bid/ask · analysis only — nothing here can place an order</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap" style={{ marginLeft: "auto" }}>
          <div className="np-seg" role="group" aria-label="Direction">
            <button data-on={dir === "BULLISH"} onClick={() => { setDir("BULLISH"); setSel(null); }}>▲ Bull put</button>
            <button data-on={dir === "BEARISH"} onClick={() => { setDir("BEARISH"); setSel(null); }}>▼ Bear call</button>
          </div>
          <select className="np-chipbtn" value={pick.short} onChange={(e) => setSel({ ...pick, short: Number(e.target.value) })} aria-label="Short strike">
            {shortChoices.map((k) => <option key={k} value={k}>Short {k}{k === atm ? " (ATM)" : ""}</option>)}
          </select>
          <div className="np-seg" role="group" aria-label="Width">
            {[1, 2, 3, 4].map((w) => <button key={w} data-on={pick.width === w} onClick={() => setSel({ ...pick, width: w })}>{w * chain.strikeStep}</button>)}
          </div>
          <div className="np-seg" role="group" aria-label="Lots">
            {[1, 2, 3].map((l) => <button key={l} data-on={lots === l} onClick={() => setLots(l)}>{l} lot{l > 1 ? "s" : ""}</button>)}
          </div>
          <button className="np-chipbtn" data-on={!!frozen} onClick={() => setFrozen(frozen ? null : live)}>{frozen ? `Frozen ${istTime(frozen.at)}` : "Freeze quotes"}</button>
        </div>
      </div>

      <div className="np-banner" data-tone="accent" style={{ marginBottom: 12 }}>
        <b>Paper analysis.</b> Prices are {s.mode === "LIVE" ? "real live quotes" : "SIMULATION quotes"}. Credit uses the short leg's bid and the long leg's ask, less slippage; closing uses the opposite sides. Margin is a paper estimate, not broker-confirmed.
      </div>

      <div className="np-grid np-split-l" style={{ marginBottom: 12 }}>
        <Card glow title={<span className="flex items-center gap-2">{KIND_LABEL[cand.kind]} {cand.short.strike}/{cand.long.strike} <Badge tone={risk.approved ? "gain" : "loss"}>{risk.approved ? "Risk approved" : "Risk rejected"}</Badge></span>}
          sub={`NIFTY · expiry ${cand.expiry} · ${cand.qty} qty (${lots} × ${cand.lotSize}) · width ${cand.widthPts} pts · ${s.config.name}`} bodyClass="">
          <div className="np-tablewrap">
            <table className="np-table">
              <thead><tr><th>Side</th><th>Contract</th><th className="r">Qty</th><th className="r">Bid · qty</th><th className="r">Ask · qty</th><th className="r">Spread</th><th className="r">Age</th><th className="r">Paper price</th></tr></thead>
              <tbody>
                <LegRow leg={cand.short} side="SELL" entry={cand.shortEntry} qty={cand.qty} />
                <LegRow leg={cand.long} side="BUY" entry={cand.longEntry} qty={cand.qty} />
              </tbody>
            </table>
          </div>
          <div className="np-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 0, borderTop: "1px solid var(--c-line)" }}>
            {[
              ["Gross credit", cand.grossCredit != null ? inr(cand.grossCredit) : "—", cand.creditPts != null ? `${num(cand.creditPts, 2)} pts × ${cand.qty}` : "no credit"],
              ["Est. costs (round trip)", cand.roundTripCost != null ? inr(cand.roundTripCost) : "—", cand.costsDetailed ? `${cand.costModelUsed} · detailed model ${inr(cand.costsDetailed.total)}` : ""],
              ["Net credit = max gain", <PnL key="g" value={cand.maxGain} />, "if both legs expire worthless"],
              ["Max loss", cand.maxLoss != null ? <span key="l" className="np-loss">▼ {inr(cand.maxLoss)}</span> : "—", cand.grossMaxLoss != null ? `(${cand.widthPts} − ${num(cand.creditPts, 2)}) × ${cand.qty} + costs` : ""],
              ["Breakeven at expiry", cand.breakeven != null ? num(cand.breakeven, 2) : "—", `spot ${num(chain.spot, 2)}`],
              ["Risk / reward", cand.maxLoss != null && cand.maxGain > 0 ? `${(cand.maxLoss / cand.maxGain).toFixed(2)} : 1` : "—", "max loss ÷ max gain"],
              ["Est. margin", cand.estMargin != null ? inr(cand.estMargin) : "—", "paper estimate — not broker-confirmed"],
              ["Risk limit", inr(cfg.maxLossPerTrade), cand.maxLoss != null ? (cand.maxLoss <= cfg.maxLossPerTrade ? "within limit" : `exceeds by ${inr(cand.maxLoss - cfg.maxLossPerTrade)}`) : ""],
            ].map(([k, v, sub], i) => (
              <div key={k} style={{ padding: "11px 14px", borderLeft: i % 4 ? "1px solid var(--c-line)" : 0, borderTop: i >= 4 ? "1px solid var(--c-line)" : 0 }}>
                <div className="lbl">{k}</div>
                <div className="n" style={{ fontSize: 16, fontWeight: 650, marginTop: 3 }}>{v}</div>
                <div className="np-card-s" style={{ marginTop: 1 }}>{sub}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Payoff at expiry" sub="Expiry payoff, after estimated costs">
          <Payoff cand={cand} spot={chain.spot} />
          <div className="np-note" style={{ marginTop: 6 }}>
            This is the payoff <b>at expiry</b>. Strategy A holds for at most {cfg.maxHoldSec}s, so its result is the <b>marked P&L</b> from closing both legs at bid/ask long before expiry — a different, much smaller number driven by spread movement and costs.
          </div>
        </Card>
      </div>

      <div className="np-grid np-split-l" style={{ marginBottom: 12 }}>
        <Card title="Liquidity & pricing checks" sub={`Quote freshness ≤ ${secs(cfg.quoteFreshnessMs)} · bid/ask ≤ ${cfg.maxBidAskPts} pts and ${cfg.maxBidAskPct}% · depth ≥ ${cfg.minDepthMultiple}× qty`}>
          {cand.checks.map((k) => (
            <div key={k.key} className="np-rule"><Check ok={k.pass} /><span>{k.label}</span><span className="np-card-s n" style={{ textAlign: "right" }}>{k.detail}</span></div>
          ))}
        </Card>
        <Card title="Risk engine approval" sub="Same independent checks the engine applies to every candidate">
          {risk.checks.map((k) => (
            <div key={k.key} className="np-rule"><Check ok={k.pass} /><span>{k.label}</span><span className="np-card-s n" style={{ textAlign: "right", whiteSpace: "normal" }}>{k.detail}</span></div>
          ))}
        </Card>
      </div>

      <Card title="All candidates" sub={`${cands.length} ${dir === "BULLISH" ? "bull put" : "bear call"} spreads from the strategy's search grid · ${cands.filter((c) => c.eligible).length} pass liquidity & pricing · click to inspect`} bodyClass="">
        <div className="np-tablewrap">
          <table className="np-table">
            <thead><tr><th>Short</th><th>Long</th><th className="r">Width</th><th className="r">Credit (pts)</th><th className="r">Gross credit</th><th className="r">Max loss</th><th className="r">Max gain</th><th className="r">Breakeven</th><th>Liquidity</th><th>Risk</th><th>Reason</th></tr></thead>
            <tbody>
              {cands.map((c) => {
                const r = approveCandidate(c, riskState, cfg);
                const on = c.short.strike === cand.short.strike && c.long.strike === cand.long.strike;
                return (
                  <tr key={c.id} data-click="true" data-sel={on} onClick={() => setSel({ short: c.short.strike, width: Math.round(c.widthPts / chain.strikeStep) })}>
                    <td className="n">{c.short.strike} {c.short.right}</td>
                    <td className="n">{c.long.strike} {c.long.right}</td>
                    <td className="r n">{c.widthPts}</td>
                    <td className="r n">{c.creditPts != null ? num(c.creditPts, 2) : "—"}</td>
                    <td className="r n">{c.grossCredit != null ? inr(c.grossCredit) : "—"}</td>
                    <td className={`r n ${c.maxLoss != null && c.maxLoss > cfg.maxLossPerTrade ? "np-loss" : ""}`}>{c.maxLoss != null ? inr(c.maxLoss) : "—"}</td>
                    <td className="r n">{c.maxGain != null ? inr(c.maxGain) : "—"}</td>
                    <td className="r n">{c.breakeven != null ? num(c.breakeven, 1) : "—"}</td>
                    <td><Badge tone={c.eligible ? "gain" : "loss"}>{c.eligible ? "Pass" : "Fail"}</Badge></td>
                    <td><Badge tone={r.approved ? "gain" : "loss"}>{r.approved ? "Approve" : "Reject"}</Badge></td>
                    <td className="np-muted" style={{ whiteSpace: "normal", minWidth: 220, fontSize: 11 }}>{r.reason ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
