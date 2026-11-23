/** Option Position — the active (or last) paper position in detail. */
import { useAscent, view } from "./store.js";
import { Card, Badge, WsHead, KV, Reason, PnL, Empty, SideBadge } from "./ui.jsx";
import AscentChart from "./AscentChart.jsx";
import { premiumNow } from "./derive.js";
import { num, hm, istTime, dur, BOT_LABEL, EXIT_LABEL } from "./format.js";
import { buyFees, sellFees } from "../../nifty-ascent/core/costs.ts";
import { barStart } from "../../nifty-ascent/core/rules.ts";

function Ladder({ entry, now, fixed, act, hi, trail }) {
  const vals = [entry, now, fixed, act, hi, trail].filter((v) => v != null);
  let lo = Math.min(...vals), top = Math.max(...vals);
  const pad = (top - lo) * 0.12 || 5; lo -= pad; top += pad;
  const y = (v) => `${((top - v) / (top - lo)) * 100}%`;
  const rung = (k, v, label, tone) => v == null ? null : (
    <div className="na-rung" data-k={k} style={{ top: y(v) }} key={k}>
      <b className={tone ? `na-${tone}` : ""}>₹{num(v, 2)}</b><span className="na-muted">{label}</span>
    </div>
  );
  return (
    <div className="na-ladder" role="img" aria-label="Premium stop ladder">
      {rung("act", act, "trail arms above (105%)", "gain")}
      {rung("hi", hi, "highest close")}
      {rung("entry", entry, "entry fill")}
      {rung("trail", trail, "trailing stop (80% of high)", "warn")}
      {rung("fixed", fixed, "fixed stop (70%)", "loss")}
      {rung("now", now, "now (LTP)")}
    </div>
  );
}

export default function OptionPosition() {
  const S = useAscent();
  const { engine: e, now } = view(S);
  const p = e.position, t = e.trade;
  if (!p && !t) {
    return (
      <>
        <WsHead title="Option Position" desc="One paper position per day across both bots" />
        <Card><Empty>No position {e.outcome ? "was taken this session" : "yet"}. {e.outcome?.detail ?? (e.entryOrder?.status === "PENDING" ? "An entry order is waiting for the first fresh ask." : "")}</Empty></Card>
      </>
    );
  }
  const q = premiumNow(e);
  const inst = p?.instrument;
  const qty = p?.qty ?? t.qty;
  const entry = p?.entryPremium ?? t.entryPremium;
  const ltp = p ? q?.ltp : t.exitPremium;
  const gross = p ? (q?.bid != null ? (q.bid - entry) * qty : null) : t.gross;
  const estCosts = p ? (p.entryFees + (q?.bid != null ? sellFees(q.bid, qty) : 0)) : t.costs;
  const chips = [];
  if (p) {
    chips.push(p.exitSignal ? null : <Badge key="a" tone="gain">STOP NOT HIT</Badge>);
    chips.push(p.trailActive ? <Badge key="b" tone="warn">TRAIL ACTIVE</Badge> : <Badge key="b">TRAIL NOT ACTIVATED</Badge>);
    if (p.exitSignal) chips.push(<Badge key="c" tone="warn">EXIT SIGNALLED · {EXIT_LABEL[p.exitSignal.reason]}</Badge>);
    if (e.exitOrder?.status === "PENDING") chips.push(<Badge key="d" tone="loss">EXIT PENDING{e.exitOrder.late ? " · LATE" : ""}</Badge>);
  } else chips.push(<Badge key="e">POSITION CLOSED · {EXIT_LABEL[t.exitReason]}</Badge>);
  const held = Math.round(((t?.exitAt ?? now) - (p?.entryAt ?? t.entryAt)) / 1000);
  const toExit = barStart(e.date, 915) - now;
  const strike = inst?.strike ?? t.strike, right = p?.right ?? t.right;
  const sigClose = p?.signalClose ?? t.signalClose;
  return (
    <>
      <WsHead title="Option Position" desc="Stops are evaluated on confirmed 1-minute premium closes; fills happen at the next observed bid — a stop never guarantees its threshold price" />
      <div className="na-grid na-split-l" style={{ marginBottom: 12 }}>
        <Card title={inst?.tradingsymbol ?? t.tradingsymbol} sub={`${BOT_LABEL[p?.bot ?? t.bot]} · ${right} · paper position`} glow tools={<SideBadge right={right} />}>
          <div className="na-chips" style={{ marginBottom: 12 }}>{chips}</div>
          <div className="na-grid na-two" style={{ gap: 18 }}>
            <KV rows={[
              ["Source bot", BOT_LABEL[p?.bot ?? t.bot]],
              ["Strike · expiry", `${strike} ${right} · ${inst?.expiry ?? t.expiry}`],
              ["ITM distance", `${num(right === "CE" ? sigClose - strike : strike - sigClose, 2)} pts vs signal close ${num(sigClose, 2)}`],
              ["Lot size × lots = qty", `${inst?.lotSize ?? t.lotSize} × ${qty / (inst?.lotSize ?? t.lotSize)} = ${qty}`],
              ["Entry time", istTime(p?.entryAt ?? t.entryAt)],
              ["Entry premium (fill)", `₹${num(entry, 2)}`],
              [p ? "Current premium (LTP)" : "Exit premium (fill)", ltp != null ? `₹${num(ltp, 2)}` : "—"],
              ["Bid / ask", q ? `${num(q.bid, 2)} / ${num(q.ask, 2)}` : "—"],
            ]} />
            <KV rows={[
              ["Gross P&L", <PnL key="g" value={gross} />],
              ["Estimated costs", `₹${num(estCosts, 2)}`],
              ["Net P&L", <PnL key="n" value={gross != null ? gross - estCosts : null} />],
              ["Fixed stop (70%)", `₹${num(entry * 0.7, 2)}`, "loss"],
              ["Trail activation (>105%)", `₹${num(entry * 1.05, 2)}`, "gain"],
              ["Highest close", (p?.highest ?? t?.highest) != null ? `₹${num(p?.highest ?? t.highest, 2)}` : "—"],
              ["Trailing stop", p?.trailActive ? `₹${num(p.trailStop, 2)}` : t?.trailActivated ? "was active" : "not active", p?.trailActive ? "warn" : undefined],
              ["Held · to 15:15", `${dur(held)}${p && toExit > 0 ? ` · ${dur(Math.ceil(toExit / 1000))}` : ""}`],
            ]} />
          </div>
        </Card>
        <Card title="Stop ladder" sub="Premium levels to scale">
          <Ladder entry={entry} now={ltp} fixed={entry * 0.7} act={entry * 1.05} hi={p?.highest ?? t?.highest} trail={p?.trailActive ? p.trailStop : null} />
          {t && <div style={{ marginTop: 10 }}><Reason tone={t.net >= 0 ? "gain" : "loss"} tag="CLOSED">{EXIT_LABEL[t.exitReason]}{t.exitSignalBar != null ? ` — signal on the ${hm(t.exitSignalBar)} close` : ""}, filled at ₹{num(t.exitPremium, 2)} (bid − slippage). Net <PnL value={t.net} />.</Reason></div>}
        </Card>
      </div>
      <Card title="Premium trajectory" sub="1-minute LTP closes since entry" bodyClass="">
        <div style={{ padding: "6px 4px 2px" }}><AscentChart kind="premium" height={320} /></div>
      </Card>
      <div className="na-note" style={{ marginTop: 10 }}>Entry fees ₹{num(p?.entryFees ?? buyFees(entry, qty), 2)} are included in the ₹{num(e.exec.maxPremiumOutlay, 0)} premium-outlay check. A bought option can lose its entire premium.</div>
    </>
  );
}
