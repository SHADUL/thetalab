import { motion, AnimatePresence } from "framer-motion";
import { Minus, Plus, X, SignOut, Stack } from "@phosphor-icons/react";
import { fm, sgn, cx } from "../lib/format";

const Step = ({ icon, onClick, disabled }) => (
  <button onClick={onClick} disabled={disabled}
    className={cx("w-6 h-[26px] flex items-center justify-center bg-surface3 text-ink2 transition-colors",
      disabled ? "opacity-30" : "hover:bg-line active:bg-line2")}>{icon}</button>
);

export default function Positions({ legs, today, defaultLots, setDefaultLots, setLots, exit, remove, clear }) {
  return (
    <section className="panel-e p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-[14.5px] font-semibold tracking-[-0.015em]">Positions</h2>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">New leg</span>
          <input type="number" min="1" value={defaultLots}
            onChange={(e) => setDefaultLots(e.target.value)}
            className="n w-[54px] text-center py-1.5 rounded-xl border border-line2 bg-surface
                       text-[13px] font-semibold focus:border-accent focus:outline-none transition-colors" />
          <span className="text-[12px] text-muted">lots</span>
          {legs.length > 0 && (
            <button onClick={clear}
              className="px-3 py-1.5 rounded-xl border border-line2 text-[12.5px] font-medium
                         hover:border-muted transition-colors">Clear</button>
          )}
        </div>
      </div>

      {legs.length === 0 ? (
        <div className="py-12 text-center">
          <Stack size={28} weight="duotone" className="text-faint mx-auto mb-3" />
          <p className="text-[13.5px] text-muted max-w-[300px] mx-auto leading-relaxed">
            No legs yet. Set lots above, then pick B or S on any premium in the chain.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full border-collapse min-w-[640px]">
            <thead>
              <tr>
                {["", "Strike", "Lots", "Qty", "Entry", "LTP", "IV", "Delta", "P&L", ""].map((h, i) => (
                  <th key={i} className="lbl py-2.5 px-2.5 border-b border-line whitespace-nowrap"
                    style={{ textAlign: i <= 1 ? "left" : "right" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {legs.map((l) => {
                  const editable = !l.closed && l.entryDate <= today;
                  return (
                    <motion.tr key={l.id} layout
                      initial={{ opacity: 0, y: -8 }} animate={{ opacity: l.closed ? 0.55 : 1, y: 0 }}
                      exit={{ opacity: 0, x: 18 }}
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                      className="border-b border-line hover:bg-surface3/60 transition-colors">
                      <td className="px-2.5 py-2.5">
                        <span className={cx("inline-flex w-[22px] h-[22px] rounded-md items-center justify-center text-[11px] font-bold",
                          l.side === "SELL" ? "text-loss bg-loss/10" : "text-gain bg-gain/10")}>
                          {l.side[0]}
                        </span>
                      </td>
                      <td className="px-2.5 n text-[13px] font-semibold whitespace-nowrap">
                        {l.strike} {l.right}
                        {l.closed && <span className="text-muted font-normal text-[11px]"> · closed</span>}
                      </td>
                      <td className="px-2.5 py-1.5">
                        {editable ? (
                          <span className="inline-flex items-center rounded-lg border border-line2 overflow-hidden bg-surface">
                            <Step icon={<Minus size={12} weight="bold" />} disabled={l.lots <= 1}
                              onClick={() => setLots(l.id, l.lots - 1)} />
                            <input value={l.lots} inputMode="numeric"
                              onChange={(e) => setLots(l.id, parseInt(e.target.value.replace(/\D/g, ""), 10) || 1)}
                              className="n w-[34px] text-center text-[13px] font-semibold bg-transparent outline-none py-1" />
                            <Step icon={<Plus size={12} weight="bold" />} onClick={() => setLots(l.id, l.lots + 1)} />
                          </span>
                        ) : <span className="n text-muted text-[13px]">{l.lots}</span>}
                      </td>
                      <td className="px-2.5 n text-[13px] text-muted text-right">{l.q}</td>
                      <td className="px-2.5 n text-[13px] text-right">{fm(l.entryPrice)}</td>
                      <td className="px-2.5 n text-[13px] text-right">{fm(l.cur)}</td>
                      <td className="px-2.5 n text-[13px] text-muted text-right">{l.iv ? fm(l.iv * 100, 1) : "—"}</td>
                      <td className="px-2.5 n text-[13px] text-muted text-right">
                        {l.active ? fm(l.dir * l.g.delta * l.q, 1) : "—"}</td>
                      <td className={cx("px-2.5 n text-[13px] font-semibold text-right",
                        l.pnl > 0 ? "text-gain" : l.pnl < 0 ? "text-loss" : "text-ink")}>{sgn(l.pnl)}</td>
                      <td className="px-2.5 text-right whitespace-nowrap">
                        {l.active && (
                          <button onClick={() => exit(l.id)} title="Close at today's price"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-line2
                                       text-[11.5px] mr-1 hover:border-muted transition-colors">
                            <SignOut size={12} weight="bold" />Exit
                          </button>
                        )}
                        <button onClick={() => remove(l.id)} title="Remove leg"
                          className="inline-flex w-[26px] h-[26px] rounded-lg border border-line items-center
                                     justify-center text-muted hover:text-loss hover:border-loss/40 transition-colors">
                          <X size={12} weight="bold" />
                        </button>
                      </td>
                    </motion.tr>);
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
