import { motion } from "framer-motion";
import { inr, sgn, fm, fi, cx } from "../lib/format";
import { Ticker } from "./Motion";

/* An unavailable metric gets a reason, not a bare dash. */
const Empty = ({ note }) => (
  <span className="text-faint font-normal text-[13px]">{note}</span>
);

export default function RiskSummary({ pnl, hasPosition, maxProfit, maxLoss, netCredit,
  breakevens, rr, pop, margin }) {
  const pnlPct = margin ? (pnl / margin) * 100 : null;

  const secondary = [
    { k: "Max profit", v: maxProfit != null ? inr(Math.round(maxProfit)) : null, tone: "up" },
    { k: "Max loss", v: maxLoss != null ? inr(Math.round(maxLoss)) : null, tone: "down",
      sub: "in charted range" },
    { k: "Net credit", v: hasPosition ? inr(Math.round(netCredit)) : null,
      tone: netCredit >= 0 ? "up" : "down" },
  ];
  const supporting = [
    { k: "Breakevens", v: breakevens?.length ? breakevens.slice(0, 2).map(fi).join(" · ") : null },
    { k: "Risk : reward", v: rr ? `1 : ${fm(rr, 1)}` : null },
    { k: "Prob. of profit", v: pop != null ? fm(pop, 1) + "%" : null, sub: "model estimate" },
    { k: "Approx. margin", v: margin ? inr(Math.round(margin)) : null, sub: "not SPAN" },
  ];

  return (
    <section className="panel-e overflow-hidden">
      {/* primary */}
      <div className="px-4 sm:px-5 py-4 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="lbl">Open P&amp;L</div>
          <div className={cx("n n-lg text-[30px] sm:text-[34px] leading-none mt-1.5",
            pnl > 0 ? "text-gain" : pnl < 0 ? "text-loss" : "text-ink")}>
            {hasPosition ? <Ticker value={pnl} format={(v) => sgn(Math.round(v))} /> : "₹0"}
          </div>
          {hasPosition && pnlPct != null && (
            <div className={cx("n text-[12.5px] mt-1.5", pnl > 0 ? "text-gain" : pnl < 0 ? "text-loss" : "text-muted")}>
              {pnl > 0 ? "+" : ""}{fm(pnlPct, 2)}% on margin
            </div>
          )}
          {!hasPosition && <div className="text-[12.5px] text-muted mt-1.5">Awaiting a position</div>}
        </div>
      </div>

      {/* secondary */}
      <div className="grid grid-cols-3 border-t border-line">
        {secondary.map((m, i) => (
          <div key={m.k} className={cx("px-4 sm:px-5 py-3 min-w-0", i < 2 && "border-r border-line")}>
            <div className="lbl">{m.k}</div>
            <div className={cx("n text-[15px] mt-1 break-words",
              m.v == null ? "" : m.tone === "up" ? "text-gain" : m.tone === "down" ? "text-loss" : "text-ink")}>
              {m.v ?? <Empty note="—" />}
            </div>
            {m.sub && <div className="text-[10.5px] text-muted mt-0.5 leading-snug">{m.sub}</div>}
          </div>
        ))}
      </div>

      {/* supporting */}
      <div className="grid grid-cols-2 border-t border-line bg-surface2">
        {supporting.map((m, i) => (
          <div key={m.k} className={cx("px-4 sm:px-5 py-3 min-w-0 border-line",
            i % 2 === 0 && "border-r", i < 2 && "border-b")}>
            <div className="lbl whitespace-nowrap">{m.k}</div>
            <div className="n text-[13.5px] mt-1 text-ink2 break-words">
              {m.v ?? <Empty note={hasPosition ? "n/a" : "—"} />}
            </div>
            {m.sub && <div className="text-[10.5px] text-muted mt-0.5 leading-snug">{m.sub}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
