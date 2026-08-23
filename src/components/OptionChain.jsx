import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CaretUp, CaretDown } from "@phosphor-icons/react";
import { fm, cx } from "../lib/format";

function Pill({ kind, onClick, title }) {
  const buy = kind === "BUY";
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 480, damping: 26 }}
      whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.94 }}
      onClick={(e) => { e.stopPropagation(); onClick(); }} title={title}
      className={cx("w-[26px] h-[24px] rounded-lg text-[11.5px] font-bold border shrink-0",
        buy ? "text-gain bg-gain/10 border-gain/25 hover:bg-gain/20"
            : "text-loss bg-loss/10 border-loss/25 hover:bg-loss/20")}
    >{buy ? "B" : "S"}</motion.button>
  );
}

function Badge({ pos, title }) {
  const short = pos.lots < 0;
  return (
    <motion.span
      layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }} transition={{ type: "spring", stiffness: 420, damping: 28 }}
      title={title}
      className={cx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-bold border whitespace-nowrap",
        short ? "text-loss bg-loss/8 border-loss/25" : "text-gain bg-gain/8 border-gain/25")}
    >
      {short ? "S" : "B"}{Math.abs(pos.lots)}
      <span className="n font-medium opacity-70">@{fm(pos.avg, 1)}</span>
    </motion.span>
  );
}

export default function OptionChain({ strikes, chain, atm, held, onAdd, lots, netEntry, netNow }) {
  const [hover, setHover] = useState(null);
  const [open, setOpen] = useState(true);

  const Cell = ({ strike, right, align }) => {
    const row = chain[String(strike)] || {};
    const val = right === "CE" ? row.c : row.p;
    const key = `${strike}${right}`;
    const on = hover === key, has = val != null;
    const pos = held[key];
    const showBadge = pos && pos.lots !== 0;
    const rtl = align === "right";

    /* Every slot has a fixed width and is always rendered, so revealing the
       B/S pills fades them in without nudging the price a single pixel. */
    const badgeSlot = (
      <span className="w-[74px] shrink-0 flex" style={{ justifyContent: rtl ? "flex-end" : "flex-start" }}>
        <AnimatePresence>
          {showBadge && (
            <Badge pos={pos}
              title={`${pos.lots < 0 ? "Sold" : "Bought"} ${Math.abs(pos.lots)} lot(s) @ ${fm(pos.avg)}`} />
          )}
        </AnimatePresence>
      </span>
    );
    const pillSlot = (
      <span className="w-[60px] shrink-0 flex gap-1.5" style={{ justifyContent: rtl ? "flex-end" : "flex-start" }}>
        <AnimatePresence>
          {on && has && [
            <Pill key="b" kind="BUY" onClick={() => onAdd(strike, right, "BUY")}
              title={`Buy ${lots} lot(s) ${strike} ${right}`} />,
            <Pill key="s" kind="SELL" onClick={() => onAdd(strike, right, "SELL")}
              title={`Sell ${lots} lot(s) ${strike} ${right}`} />,
          ]}
        </AnimatePresence>
      </span>
    );
    const priceSlot = (
      <span className={cx("n text-[13px] w-[54px] shrink-0 transition-colors duration-150",
        on ? "text-muted" : "text-ink")} style={{ textAlign: rtl ? "right" : "left" }}>
        {has ? fm(val) : <span className="text-faint">—</span>}
      </span>
    );

    const order = rtl ? [badgeSlot, pillSlot, priceSlot] : [priceSlot, pillSlot, badgeSlot];

    return (
      <td
        onMouseEnter={() => has && setHover(key)}
        onMouseLeave={() => setHover((h) => (h === key ? null : h))}
        onClick={() => has && setHover(on ? null : key)}
        className={cx("h-[42px] px-2.5 border-b border-line transition-colors duration-200",
          has && "cursor-pointer",
          on ? "bg-accent/6" : showBadge ? (pos.lots < 0 ? "bg-loss/5" : "bg-gain/5")
             : strike === atm ? "bg-warn/8" : "hover:bg-surface3")}
      >
        <span className="flex items-center gap-1.5" style={{ justifyContent: rtl ? "flex-end" : "flex-start" }}>
          {order.map((el, i) => <span key={i} className="flex items-center">{el}</span>)}
        </span>
      </td>
    );
  };

  return (
    <section className="panel-e p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-[14.5px] font-semibold tracking-[-0.015em]">Option chain</h2>
          {netEntry != null && (
            <div className="n text-[12.5px] text-muted">
              net premium <b className={netEntry >= 0 ? "text-gain" : "text-loss"}>{fm(netEntry)}</b>
              <span className="mx-1.5 text-faint">·</span>now <b className="text-ink">{fm(netNow)}</b>
            </div>
          )}
        </div>
        <button onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-line2 text-[12.5px]
                     font-medium hover:border-faint transition-colors">
          {open ? <CaretUp size={14} weight="bold" /> : <CaretDown size={14} weight="bold" />}
          {open ? "Hide" : "Show"}
        </button>
      </div>
      <p className="text-[12px] text-muted mt-1 mb-2.5 leading-snug">
        Tap a premium, then <b className="text-gain">B</b> or <b className="text-loss">S</b>
        {" "}for {lots} lot{lots > 1 ? "s" : ""}.
      </p>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="chain-scroll">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    {["Call", "Strike", "Put"].map((h, i) => (
                      <th key={h} className="lbl sticky top-0 bg-surface z-10 py-2.5 px-2.5 border-b border-line"
                        style={{ textAlign: i === 0 ? "right" : i === 1 ? "center" : "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {strikes.map((s) => (
                    <tr key={s}>
                      <Cell strike={s} right="CE" align="right" />
                      <td className={cx("n text-center px-2.5 border-b border-line text-[13px]",
                        s === atm ? "bg-warn/8 text-warn font-bold" : "text-ink2 font-medium")}>{s}</td>
                      <Cell strike={s} right="PE" align="left" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
