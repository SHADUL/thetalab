import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Lightning, Minus, Plus, Info } from "@phosphor-icons/react";
import { buildEnrichedSlice } from "../lib/quantBridge";
import { buildIronCondor, isIronCondorFailure } from "../quant/strategies/ironCondor.ts";
import { inr, sgn, fm, fi, cx } from "../lib/format";

const Stepper = ({ value, onChange, step, min, max, fmtv, suffix }) => (
  <span className="stepper">
    <button onClick={() => onChange(Math.max(min, value - step))}><Minus size={10} weight="bold" /></button>
    <span className="n stepper-v" style={{ width: 44 }}>{fmtv ? fmtv(value) : value}{suffix}</span>
    <button onClick={() => onChange(Math.min(max, value + step))}><Plus size={10} weight="bold" /></button>
  </span>
);

/**
 * The thin end-to-end slice: real chain data through the Black-76 quant
 * engine, one Greek-selected Iron Condor out, loadable into the same
 * position mechanism every other strategy source in this app uses. Proof
 * that the wiring works before the rest of the strategy library, scoring
 * model or risk engine gets built on top of it.
 */
export default function QuantStrategyPanel({ chain, spot, expiry, today, lotQty, step = 50,
  symbol = "NIFTY", priceBasis = "open", onLoad }) {
  const [targetDelta, setTargetDelta] = useState(0.16);
  const [wingWidth, setWingWidth] = useState(step * 5);

  const bridged = useMemo(
    () => buildEnrichedSlice({ chain, spot, expiry, today, lotQty, step, symbol, priceBasis }),
    [chain, spot, expiry, today, lotQty, step, symbol, priceBasis],
  );

  const result = useMemo(() => {
    if (!bridged?.slice) return null;
    return buildIronCondor(bridged.slice, { targetShortDelta: targetDelta, wingWidth, lotSize: Number(lotQty) || 1 });
  }, [bridged, targetDelta, wingWidth, lotQty]);

  if (!bridged?.slice) {
    return (
      <div>
        <Header />
        <div className="mt-4 px-4 py-6 rounded-[12px] border border-line text-center text-[12.5px] text-muted">
          No usable chain for this session yet.
        </div>
      </div>
    );
  }

  const { slice } = bridged;
  const failed = result && isIronCondorFailure(result);

  return (
    <div>
      <Header />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 mb-4 px-3.5 py-3 rounded-[12px]"
        style={{ background: "var(--c-surface-2)" }}>
        <Field label="Forward">
          <span className="n text-[13.5px] font-semibold">{fi(slice.forward)}</span>
          <span className="text-[10px] text-faint ml-1">{slice.forwardSource}</span>
        </Field>
        <Field label="ATM IV">
          <span className="n text-[13.5px] font-semibold">
            {result && !failed && result.atmIv != null ? `${fm(result.atmIv * 100, 1)}%` : "—"}
          </span>
        </Field>
        <Field label="DTE">
          <span className="n text-[13.5px] font-semibold">{Math.round(slice.timeToExpiry * 365)}</span>
        </Field>
        <div className="ml-auto flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">Short Δ</span>
            <Stepper value={targetDelta} step={0.02} min={0.05} max={0.4}
              fmtv={(v) => v.toFixed(2)} onChange={setTargetDelta} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">Wing</span>
            <Stepper value={wingWidth} step={step} min={step} max={step * 20}
              onChange={setWingWidth} />
          </span>
        </div>
      </div>

      {!result || failed ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px] border border-warn/30"
          style={{ background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <div>
            <div className="text-[12.5px] font-semibold text-warn">NO TRADE</div>
            <p className="text-[12px] text-ink2 mt-0.5 leading-relaxed">
              {result ? result.reason : "Building candidate…"}
            </p>
          </div>
        </div>
      ) : (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <div className="rounded-[12px] border border-line overflow-hidden">
            <div className="px-4 py-3 border-b border-line flex items-center justify-between"
              style={{ background: "var(--c-surface-2)" }}>
              <span className="text-[13.5px] font-semibold">Iron Condor</span>
              <span className={cx("n text-[11px] font-semibold px-1.5 py-0.5 rounded",
                result.netCredit >= 0 ? "text-loss bg-loss/8" : "text-gain bg-gain/8")}>
                Credit {inr(result.netCredit * (Number(lotQty) || 1))}
              </span>
            </div>

            <div className="px-4 py-3 space-y-1 border-b border-line">
              {result.legs.map((l, i) => (
                <div key={i} className="n text-[12.5px] flex items-center gap-2.5">
                  <span className={cx("font-semibold w-10", l.side === "SELL" ? "text-loss" : "text-gain")}>
                    {l.side}
                  </span>
                  <span className="w-20">{l.strike} {l.right}</span>
                  <span className="text-muted">@ {fm(l.price)}</span>
                  <span className="text-faint ml-auto">
                    Δ {l.delta != null ? fm(l.delta, 2) : "—"} · IV {l.iv != null ? fm(l.iv * 100, 1) + "%" : "—"}
                  </span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-line">
              <Metric label="Max Profit" value={inr(result.maxProfit)} tone="gain" />
              <Metric label="Max Loss" value={inr(-result.maxLoss)} tone="loss" />
              <Metric label="Breakevens" value={`${fi(result.breakevens[0])} / ${fi(result.breakevens[1])}`} />
              <Metric label="POP" value={result.pop != null ? `${fm(result.pop * 100, 1)}%` : "—"} />
            </div>

            <div className="grid grid-cols-4 divide-x divide-line border-t border-line">
              <Metric small label="Net Δ" value={fm(result.netGreeks.delta, 3)} />
              <Metric small label="Net Γ" value={fm(result.netGreeks.gamma, 4)} />
              <Metric small label="Net Θ" value={sgn(result.netGreeks.theta)} />
              <Metric small label="Net Vega" value={fm(result.netGreeks.vega, 1)} />
            </div>

            <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted leading-relaxed max-w-[46ch]">
                POP is model-implied from a lognormal assumption — it understates tail risk the same
                way every number from this model does. Not a guarantee.
              </p>
              <button onClick={() => onLoad(result.legs.map((l) => ({
                side: l.side, right: l.right, strike: l.strike, lots: 1, price: l.price,
              })))} className="btn btn-primary shrink-0 !px-3.5 !py-2 !text-[12.5px]">
                Load into Positions
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}

const Header = () => (
  <div>
    <div className="flex items-center gap-2 mb-1.5">
      <Lightning size={14} weight="regular" className="text-accent" />
      <span className="lbl !text-accent">Quant engine · Iron Condor</span>
    </div>
    <h2 className="text-[16px] font-semibold tracking-[-0.02em] leading-tight">
      Short strikes chosen by delta, not by distance.
    </h2>
    <p className="text-[12.5px] text-ink2 mt-1 max-w-[60ch] leading-relaxed">
      Built on the Black-76 engine: every strike's IV is solved from its own settlement price, the
      forward comes from put-call parity (not spot), and a strategy this session can't actually
      support comes back as <b>NO TRADE</b> instead of a guess.
    </p>
  </div>
);

const Field = ({ label, children }) => (
  <span className="flex items-baseline gap-1.5">
    <span className="text-[11px] text-muted">{label}</span>
    {children}
  </span>
);

const Metric = ({ label, value, tone, small }) => (
  <div className={cx("px-3", small ? "py-2" : "py-3")}>
    <div className={cx("lbl", small ? "!text-[9px]" : "!text-[10px]")}>{label}</div>
    <div className={cx("n font-bold mt-1", small ? "text-[12px]" : "text-[15px]",
      tone === "gain" && "text-gain", tone === "loss" && "text-loss")}>
      {value}
    </div>
  </div>
);
