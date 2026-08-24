import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Minus, Plus, X, SignOut, ArrowsDownUp, FloppyDisk, ShareNetwork,
         Stack, Check } from "@phosphor-icons/react";
import { fm, sgn, inr, cx } from "../lib/format";

const TABS = [["positions", "Positions"], ["greeks", "Greeks"], ["target", "Target P&L"]];

const Step = ({ icon, onClick, disabled }) => (
  <button onClick={onClick} disabled={disabled}
    className={cx("lot-step", disabled && "is-off")}>{icon}</button>
);

export default function PositionsPanel({
  legs, today, lotQty, defaultLots, setDefaultLots, setLots, exitLeg, removeLeg,
  toggleLeg, clear, exitAll, multiplier, setMultiplier, onSave, onShare,
  targetPnlByLeg, targetDate, totals,
}) {
  const [tab, setTab] = useState("positions");
  const [sortDesc, setSortDesc] = useState(false);

  const sorted = [...legs].sort((a, b) =>
    sortDesc ? b.strike - a.strike : a.strike - b.strike);

  const expShort = (d) => new Date(d + "T00:00:00")
    .toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })
    .replace(/(\d{2})$/, "'$1");

  if (!legs.length) {
    return (
      <section className="panel-e deskpanel">
        <div className="panel-head is-tabs">
          <div className="tabrail">
            {TABS.map(([k, label]) => (
              <button key={k} className={cx("tab", k === "positions" && "is-on")}>{label}</button>
            ))}
          </div>
        </div>
        <div className="py-10 text-center">
          <Stack size={26} weight="duotone" className="text-faint mx-auto mb-3" />
          <p className="text-[13px] text-muted max-w-[320px] mx-auto leading-relaxed">
            No legs yet. Set the lot count below, then pick <b className="text-gain">B</b> or{" "}
            <b className="text-loss">S</b> on any premium in the chain.
          </p>
          <div className="posfoot justify-center mt-5">
            <span className="ctrl">
              <span className="ctrl-k">New leg lots:</span>
              <span className="stepper">
                <button onClick={() => setDefaultLots(Math.max(1, Number(defaultLots) - 1))}>
                  <Minus size={10} weight="bold" /></button>
                <span className="n stepper-v" style={{ width: 34 }}>{defaultLots}</span>
                <button onClick={() => setDefaultLots(Number(defaultLots) + 1)}>
                  <Plus size={10} weight="bold" /></button>
              </span>
            </span>
            <span className="ctrl"><span className="ctrl-k">Lot Size:</span>
              <span className="n ctrl-v">{lotQty}</span></span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel-e deskpanel">
      <div className="panel-head is-tabs">
        <div className="tabrail">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={cx("tab", tab === k && "is-on")}>
              {label}{k === "target" && <span className="tab-hint">blue line</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button className="chip" onClick={onSave}><FloppyDisk size={11} weight="bold" />Save</button>
          <button className="chip" onClick={onShare}><ShareNetwork size={11} weight="bold" />Share</button>
        </div>
      </div>

      <div className="postable-wrap">
        <table className="postable">
          <thead>
            <tr>
              <th className="w-[34px]" />
              <th className="w-[34px]" />
              <th>Lots</th>
              <th>Qty</th>
              <th>
                <button className="sorth" onClick={() => setSortDesc((v) => !v)}>
                  Strike <ArrowsDownUp size={9} weight="bold" />
                </button>
              </th>
              <th>Expiry</th>
              <th className="text-right">Entry</th>
              <th className="text-right">LTP</th>
              {tab === "greeks" ? (
                <>
                  <th className="text-right">Delta</th><th className="text-right">Gamma</th>
                  <th className="text-right">Theta</th><th className="text-right">Vega</th>
                </>
              ) : tab === "target" ? (
                <>
                  <th className="text-right">Delta</th>
                  <th className="text-right">P&amp;L now</th>
                  <th className="text-right">P&amp;L @ target</th>
                </>
              ) : (
                <><th className="text-right">Delta</th><th className="text-right">P&amp;L</th></>
              )}
              <th className="text-right">Exit</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {sorted.map((l) => {
                const editable = !l.closed && l.entryDate <= today;
                const tp = targetPnlByLeg?.[l.id];
                return (
                  <motion.tr key={l.id} layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: l.closed ? 0.5 : l.off ? 0.45 : 1, y: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    className={cx(l.off && "is-off")}>
                    <td>
                      <button className={cx("tickbox-btn", !l.off && "is-on")}
                        onClick={() => toggleLeg(l.id)}
                        title={l.off ? "Include in payoff" : "Exclude from payoff"}>
                        {!l.off && <Check size={9} weight="bold" />}
                      </button>
                    </td>
                    <td>
                      <span className={cx("side-badge", l.side === "SELL" ? "is-sell" : "is-buy")}>
                        {l.side[0]}
                      </span>
                    </td>
                    <td>
                      {editable ? (
                        <span className="lot-box">
                          <Step icon={<Minus size={10} weight="bold" />} disabled={l.lots <= 1}
                            onClick={() => setLots(l.id, l.lots - 1)} />
                          <input value={l.lots} inputMode="numeric"
                            onChange={(e) => setLots(l.id, parseInt(e.target.value.replace(/\D/g, ""), 10) || 1)}
                            className="n lot-input" />
                          <Step icon={<Plus size={10} weight="bold" />}
                            onClick={() => setLots(l.id, l.lots + 1)} />
                        </span>
                      ) : <span className="n text-muted">{l.lots}</span>}
                    </td>
                    <td className="n text-muted">{l.q}</td>
                    <td className="n font-semibold whitespace-nowrap">
                      {l.strike} <span className="text-ink2">{l.right}</span>
                      {l.closed && <span className="text-muted font-normal text-[10.5px]"> · closed</span>}
                    </td>
                    <td className="n text-muted whitespace-nowrap">
                      {expShort(l.expiry)}
                      {l.noQuote && (
                        <span className="noquote"
                          title="This expiry has no chain on the session in view, so the leg cannot be marked here">
                          no quote
                        </span>
                      )}
                    </td>
                    <td className="n text-right">{fm(l.entryPrice)}</td>
                    <td className="n text-right">{fm(l.cur)}</td>

                    {tab === "greeks" ? (
                      <>
                        <td className="n text-right">{l.active ? fm(l.dir * l.g.delta * l.q, 1) : "—"}</td>
                        <td className="n text-right text-muted">{l.active ? fm(l.dir * l.g.gamma * l.q, 4) : "—"}</td>
                        <td className={cx("n text-right", l.active && l.dir * l.g.theta > 0 ? "text-gain" : "text-loss")}>
                          {l.active ? inr(l.dir * l.g.theta * l.q) : "—"}</td>
                        <td className="n text-right text-muted">{l.active ? inr(l.dir * l.g.vega * l.q) : "—"}</td>
                      </>
                    ) : tab === "target" ? (
                      <>
                        <td className="n text-right text-muted">{l.active ? fm(l.dir * l.g.delta * l.q, 1) : "—"}</td>
                        <td className={cx("n text-right", l.pnl > 0 ? "text-gain" : l.pnl < 0 ? "text-loss" : "")}>
                          {sgn(l.pnl)}</td>
                        <td className={cx("n text-right font-semibold", tp > 0 ? "text-gain" : tp < 0 ? "text-loss" : "")}>
                          {tp != null ? sgn(tp) : "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="n text-right text-muted">{l.active ? fm(l.dir * l.g.delta * l.q, 1) : "—"}</td>
                        <td className={cx("n text-right font-semibold",
                          l.pnl > 0 ? "text-gain" : l.pnl < 0 ? "text-loss" : "")}>{sgn(l.pnl)}</td>
                      </>
                    )}

                    <td className="text-right whitespace-nowrap">
                      {l.active && (
                        <button onClick={() => exitLeg(l.id)} title="Close at this session's price"
                          className="mini-btn"><SignOut size={11} weight="bold" /></button>
                      )}
                      <button onClick={() => removeLeg(l.id)} title="Remove leg"
                        className="mini-btn is-danger"><X size={11} weight="bold" /></button>
                    </td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={8} className="n text-right text-muted">Net</td>
              {tab === "greeks" ? (
                <>
                  <td className="n text-right font-semibold">{fm(totals.delta, 1)}</td>
                  <td className="n text-right font-semibold">{fm(totals.gamma, 4)}</td>
                  <td className={cx("n text-right font-semibold", totals.theta > 0 ? "text-gain" : "text-loss")}>
                    {inr(totals.theta)}</td>
                  <td className="n text-right font-semibold">{inr(totals.vega)}</td>
                </>
              ) : tab === "target" ? (
                <>
                  <td className="n text-right">{fm(totals.delta, 1)}</td>
                  <td className={cx("n text-right font-semibold", totals.pnl > 0 ? "text-gain" : totals.pnl < 0 ? "text-loss" : "")}>
                    {sgn(totals.pnl)}</td>
                  <td className={cx("n text-right font-semibold", totals.target > 0 ? "text-gain" : totals.target < 0 ? "text-loss" : "")}>
                    {totals.target != null ? sgn(totals.target) : "—"}</td>
                </>
              ) : (
                <>
                  <td className="n text-right">{fm(totals.delta, 1)}</td>
                  <td className={cx("n text-right font-semibold", totals.pnl > 0 ? "text-gain" : totals.pnl < 0 ? "text-loss" : "")}>
                    {sgn(totals.pnl)}</td>
                </>
              )}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {tab === "target" && (
        <p className="tabnote">
          Target column prices every leg on{" "}
          <b>{new Date(targetDate + "T00:00:00").toLocaleDateString("en-IN",
            { weekday: "long", day: "2-digit", month: "short", year: "numeric" })}</b>{" "}
          at the spot and IV set in Payoff Settings — the blue dashed line on the chart.
        </p>
      )}

      <div className="posfoot">
        <span className="ctrl">
          <span className="ctrl-k">Multiplier:</span>
          <span className="stepper">
            <button onClick={() => setMultiplier(Math.max(1, multiplier - 1))}>
              <Minus size={10} weight="bold" /></button>
            <span className="n stepper-v" style={{ width: 30 }}>{multiplier}</span>
            <button onClick={() => setMultiplier(multiplier + 1)}>
              <Plus size={10} weight="bold" /></button>
          </span>
        </span>
        <span className="ctrl">
          <span className="ctrl-k">New leg lots:</span>
          <span className="stepper">
            <button onClick={() => setDefaultLots(Math.max(1, Number(defaultLots) - 1))}>
              <Minus size={10} weight="bold" /></button>
            <span className="n stepper-v" style={{ width: 30 }}>{defaultLots}</span>
            <button onClick={() => setDefaultLots(Number(defaultLots) + 1)}>
              <Plus size={10} weight="bold" /></button>
          </span>
        </span>
        <span className="ctrl"><span className="ctrl-k">Lot Size:</span>
          <span className="n ctrl-v">{lotQty}</span></span>
        <span className="flex-1" />
        <button className="chip" onClick={exitAll}>Exit all</button>
        <button className="chip is-danger" onClick={clear}>Clear</button>
      </div>
    </section>
  );
}
