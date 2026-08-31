import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MagicWand, ArrowsHorizontal, TrendUp, TrendDown, CaretDown, Plus, Info } from "@phosphor-icons/react";
import { ivSurface, generate, rank, defaultBounds } from "../lib/strategies";
import { GROUPS, readymadeFor, buildReadymade } from "../lib/readymade";
import ReadymadeCard from "./ReadymadeCard";
import QuantStrategyPanel from "./QuantStrategyPanel";
import { inr, sgn, fm, fi, cx } from "../lib/format";

const VIEWS = [
  { id: "between", label: "Stays between", icon: ArrowsHorizontal },
  { id: "above", label: "Goes above", icon: TrendUp },
  { id: "below", label: "Goes below", icon: TrendDown },
];
const SORTS = [
  { id: "profit", label: "Profit" },
  { id: "ret", label: "Return %" },
  { id: "risk", label: "Smallest risk" },
  { id: "capital", label: "Least capital" },
];

/* Chart colours resolve from the same tokens as the rest of the app, so the
   shape icons repaint with a theme switch instead of carrying a fixed pair. */
const tok = (n, f) => (typeof window === "undefined" ? f
  : getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);

export default function StrategyWizard({ chain, strikes, spot, sigma, tYears, dates, dayIdx,
  expiry, lotQty, defaultLots, step = 50, symbol = "NIFTY", onLoad }) {
  const [mode, setMode] = useState("readymade");
  const [group, setGroup] = useState("bullish");
  const init = defaultBounds(spot, sigma, step);
  const [view, setView] = useState("between");
  const [lower, setLower] = useState(init.lower);
  const [upper, setUpper] = useState(init.upper);
  const [targetIdx, setTargetIdx] = useState(dates.length - 1);
  const [sortBy, setSortBy] = useState("profit");
  const [rows, setRows] = useState(8);
  const [open, setOpen] = useState(null);
  const [ran, setRan] = useState(false);

  const today = dates[dayIdx] ?? null;
  const targetDate = dates[Math.min(targetIdx, dates.length - 1)];
  const targetT = useMemo(() => {
    if (!targetDate) return 0;
    const d = (new Date(expiry) - new Date(targetDate)) / 86400000;
    return d <= 0.5 ? 0 : d / 365;
  }, [targetDate, expiry]);

  const lo = view === "below" ? spot - spot * 0.12 : Number(lower);
  const hi = view === "above" ? spot + spot * 0.12 : Number(upper);

  /* Shared by every ready-made card, solved once per session rather than
     once per card tap. */
  const atm = useMemo(
    () => strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), strikes[0] ?? spot),
    [strikes, spot]);
  const readySurf = useMemo(
    () => ivSurface(chain, strikes, spot, tYears), [chain, strikes, spot, tYears]);
  const readyCtx = { surf: readySurf, atm, step, lots: Number(defaultLots) || 1 };
  const readyList = useMemo(() => readymadeFor(group), [group]);
  const gainC = tok("--c-gain", "#067A55"), lossC = tok("--c-loss", "#C8342B");

  const results = useMemo(() => {
    if (!ran || !spot) return [];
    const surf = ivSurface(chain, strikes, spot, tYears);
    const cands = generate({ surf, strikes, spot, view, step,
      lower: Math.min(lo, hi), upper: Math.max(lo, hi), lots: Number(defaultLots) || 1 });
    const out = rank(cands, { spot, targetT, lotQty, lower: Math.min(lo, hi), upper: Math.max(lo, hi) }, sortBy);
    out.dropped = rank.dropped || [];
    return out;
  }, [ran, chain, strikes, spot, tYears, view, lo, hi, targetT, lotQty, sortBy, defaultLots, step]);

  const Field = ({ label, children, hint }) => (
    <div className="min-w-0">
      <div className="lbl mb-1.5">{label}</div>{children}
      {hint && <div className="text-[10.5px] text-muted mt-1">{hint}</div>}
    </div>
  );
  const inputCls = "ctl n w-full !text-[15px] font-medium";

  return (
    /* Rendered inside the analysis panel's Strategy tab, so this carries its
       own padding but not a second card surface. */
    <div className="p-4">
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <MagicWand size={14} weight="regular" className="text-accent" />
            <span className="lbl !text-accent">Strategy finder</span>
          </div>
          <h2 className="text-[16px] font-semibold tracking-[-0.02em] leading-tight">
            {mode === "readymade" ? "Pick a ready-made strategy."
              : mode === "quant" ? "Let the Greeks pick the strikes."
              : "Tell us your market view."}
          </h2>
          <p className="text-[12.5px] text-ink2 mt-1 max-w-[52ch] leading-relaxed">
            Every structure is constructed and priced off this session's chain, with each leg's
            volatility solved from its own traded premium.
          </p>
        </div>
        <div className="seg-track !max-w-[320px] shrink-0" role="tablist" aria-label="Finder mode">
          {[["readymade", "Ready-made"], ["quant", "Quant Engine"], ["custom", "Custom"]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={mode === id} data-on={mode === id}
              onClick={() => setMode(id)} className="seg">{label}</button>
          ))}
        </div>
      </div>

      {mode === "readymade" && (
        <div>
          <div className="rm-grouprow" role="tablist" aria-label="Strategy family">
            {GROUPS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={group === id}
                onClick={() => setGroup(id)}
                className={cx("rm-group", group === id && "is-on")}>{label}</button>
            ))}
          </div>
          <motion.div key={group} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22 }} className="rm-grid">
            {readyList.map((strat) => {
              const legs = spot ? buildReadymade(strat, readyCtx) : null;
              return (
                <ReadymadeCard key={strat.id} strat={strat} disabled={!legs}
                  gain={gainC} loss={lossC}
                  onPick={() => onLoad(legs)} />
              );
            })}
          </motion.div>
        </div>
      )}

      {mode === "quant" && (
        <QuantStrategyPanel chain={chain} spot={spot} expiry={expiry} today={today}
          lotQty={lotQty} step={step} symbol={symbol} onLoad={onLoad} />
      )}

      {mode === "custom" && (
      <>
      <div className="grid gap-3 sm:gap-4">
        <Field label={`My view is ${symbol}`}>
          <div className="seg-track max-w-[360px]" role="tablist" aria-label="Market view">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} data-on={view === v.id}
                onClick={() => { setView(v.id); setRan(false); }} title={v.label} className="seg">
                <v.icon size={13} weight="regular" />
                {v.id === "between" ? "Range" : v.id === "above" ? "Bullish" : "Bearish"}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-3 items-end"
          style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
          {view !== "below" && (
            <Field label={view === "above" ? "Above" : "Lower bound"}>
              <input className={inputCls} value={lower} inputMode="numeric" aria-label="Lower bound"
                onChange={(e) => { setLower(e.target.value.replace(/\D/g, "")); setRan(false); }} />
            </Field>
          )}
          {view !== "above" && (
            <Field label={view === "below" ? "Below" : "Upper bound"}>
              <input className={inputCls} value={view === "below" ? lower : upper} inputMode="numeric"
                aria-label="Upper bound"
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "");
                  view === "below" ? setLower(v) : setUpper(v); setRan(false);
                }} />
            </Field>
          )}

          <Field label="Target date">
            <select value={targetIdx} onChange={(e) => { setTargetIdx(+e.target.value); setRan(false); }}
              className={inputCls} aria-label="Target date">
              {dates.map((d, i) => i >= dayIdx && (
                <option key={d} value={i}>
                  {new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })}
                  {i === dates.length - 1 ? " · expiry" : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Rank by">
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={inputCls}
              aria-label="Rank strategies by">
              {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>

          <div className="sm:col-span-1">
            <button onClick={() => setRan(true)} className="btn btn-primary w-full !py-[11px]">
              Construct strategies
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {ran && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }} className="mt-5">
            <p className="text-[13px] text-ink2 mb-3">
              <b>{results.length}</b> structures for {symbol}{" "}
              {view === "between" ? <>between <b className="n">{fi(lo)}</b>–<b className="n">{fi(hi)}</b></>
                : view === "above" ? <>above <b className="n">{fi(lower)}</b></>
                : <>below <b className="n">{fi(lower)}</b></>}{" "}
              on <b>{new Date(targetDate).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</b>
              {targetT === 0 && " (expiry)"}
            </p>

            {results.dropped?.length > 0 && (
              <div className="flex gap-2 mb-3 px-3 py-2.5 rounded-[10px] border border-warn/30" style={{ background: "var(--c-warn-soft)" }}>
                <Info size={15} weight="duotone" className="shrink-0 mt-px text-warn" />
                <p className="text-[11.5px] text-warn leading-relaxed">
                  <b>{results.dropped.length}</b> structure{results.dropped.length > 1 ? "s" : ""} discarded for
                  breaking no-arbitrage bounds — a spread worth more than its width, or one that profits at every
                  price. That is a stale premium in the source data, not an opportunity. Rebuild the bundle if
                  this count is large.
                </p>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse min-w-[720px]">
                <thead>
                  <tr>
                    {["Structure", "Profit if right", "Max profit", "Max loss", "Breakevens", "Approx capital", "Return", ""]
                      .map((h, i) => (
                      <th key={h} className="lbl py-2.5 px-3 border-b border-line whitespace-nowrap"
                        style={{ textAlign: i === 0 ? "left" : i === 7 ? "right" : "right" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.slice(0, rows).map((r, i) => (
                    <motion.tr key={r.name + i} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.03, 0.3) }}
                      className="border-b border-line hover:bg-surface2 transition-colors duration-150">
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          <span className={cx("lbl !text-[9px] px-1.5 py-0.5 rounded",
                            r.net >= 0 ? "!text-loss bg-loss/8" : "!text-gain bg-gain/8")}>
                            {r.net >= 0 ? "Credit" : "Debit"}
                          </span>
                          <span className="text-[13.5px] font-semibold">{r.kind}</span>
                        </div>
                        <button onClick={() => setOpen(open === i ? null : i)}
                          className="n text-[11.5px] link-quiet mt-0.5 flex items-center gap-1">
                          {r.legs.map((l) => `${l.side[0]}${l.strike}${l.right === "CE" ? "c" : "p"}`).join(" · ")}
                          <CaretDown size={10} weight="bold" className={cx("transition-transform", open === i && "rotate-180")} />
                        </button>
                        <AnimatePresence>
                          {open === i && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                              <div className="mt-2 pt-2 border-t border-line space-y-1">
                                {r.legs.map((l, j) => (
                                  <div key={j} className="n text-[11.5px] flex gap-2">
                                    <span className={l.side === "SELL" ? "text-loss font-semibold" : "text-gain font-semibold"}>
                                      {l.side}</span>
                                    <span>{l.lots}× {l.strike} {l.right}</span>
                                    <span className="text-muted">@ {fm(l.price)}</span>
                                    <span className="text-faint">IV {l.iv ? fm(l.iv * 100, 1) + "%" : "—"}</span>
                                  </div>
                                ))}
                                <div className="n text-[11.5px] text-muted pt-1">
                                  net {r.net >= 0 ? "credit" : "debit"} {inr(Math.abs(r.net))}
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </td>
                      <td className={cx("n px-3 text-right text-[16px] font-bold leading-tight",
                        r.minInView > 0 ? "text-gain" : "text-loss")}>
                        {sgn(Math.round(r.minInView))}
                        <div className="text-[10.5px] font-medium opacity-70 mt-0.5">
                          {r.capital ? `${r.minInView >= 0 ? "+" : ""}${fm((r.minInView / r.capital) * 100, 1)}%` : "—"}
                        </div>
                      </td>
                      <td className="n px-3 text-right text-[14.5px] font-bold text-gain leading-tight">
                        {inr(Math.round(r.maxProfit))}
                        <div className="text-[10.5px] font-medium opacity-70 mt-0.5">
                          {r.capital ? `+${fm((r.maxProfit / r.capital) * 100, 1)}%` : "—"}
                        </div>
                      </td>
                      <td className="n px-3 text-right text-[14.5px] font-bold text-loss leading-tight">
                        {inr(Math.round(r.maxLoss))}
                        <div className="text-[10.5px] font-medium opacity-70 mt-0.5">
                          {r.capital ? `${fm((r.maxLoss / r.capital) * 100, 1)}%` : "—"}
                        </div>
                      </td>
                      <td className="n px-3 text-right text-[12.5px] text-ink2 whitespace-nowrap">
                        {r.breakevens.length ? r.breakevens.slice(0, 2).map(fi).join(", ") : "—"}</td>
                      <td className="n px-3 text-right text-[13px]">{inr(Math.round(r.capital))}</td>
                      <td className={cx("n px-3 text-right text-[13px] font-semibold",
                        r.returnPct > 0 ? "text-gain" : "text-loss")}>{fm(r.returnPct, 1)}%</td>
                      <td className="px-3 text-right">
                        <motion.button whileTap={{ scale: 0.94 }} onClick={() => onLoad(r.legs)}
                          title="Load these legs into the simulator"
                          className="btn !px-2.5 !py-1.5 !text-[12px] hover:!border-accent hover:!text-accent">
                          <Plus size={12} weight="bold" />Load
                        </motion.button>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>

            {results.length > rows && (
              <button onClick={() => setRows((r) => r + 12)}
                className="btn w-full mt-3 !py-2.5">
                Show more ({results.length - rows} remaining)
              </button>
            )}

            <div className="flex gap-2 mt-4 text-[11.5px] text-muted leading-relaxed">
              <Info size={15} weight="duotone" className="shrink-0 mt-px text-faint" />
              <p>
                <b>Profit if right</b> is the worst outcome inside your predicted range, not the best —
                so a structure ranked highly pays at least that much anywhere your view holds. Max loss is
                measured across the charted range; a naked short leg can lose more beyond it. Capital is the
                defined risk for hedged structures and a rough 12% margin proxy for naked ones, not SPAN.
                All legs are priced at this session's close.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </>
      )}
    </div>
  );
}
