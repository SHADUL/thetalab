import { motion, AnimatePresence } from "framer-motion";
import { CaretLeft, CaretRight, Sun, Moon } from "@phosphor-icons/react";
import { fi, fm, cx } from "../lib/format";

const Metric = ({ label, value, sub, tone }) => (
  <div className="min-w-0">
    <div className="lbl">{label}</div>
    <div className={cx("n text-[15px] mt-1 truncate",
      tone === "up" ? "text-gain" : tone === "down" ? "text-loss" : "text-ink")}>{value}</div>
    {sub && <div className="n text-[10.5px] text-muted truncate mt-0.5">{sub}</div>}
  </div>
);

export default function MarketHeader({ symbol = "NIFTY", expiries, expiry, setExpiry, dates,
  dayIdx, setDayIdx, spot, prevSpot, sessionsLeft, atmIV, sigma, lot, theme, toggleTheme }) {
  const chg = prevSpot != null ? spot - prevSpot : null;
  const chgPct = chg != null && prevSpot ? (chg / prevSpot) * 100 : null;
  const fmtDate = (s, o) => new Date(s).toLocaleDateString("en-IN", o);
  const SHORT = { weekday: "short", day: "2-digit", month: "short" };

  return (
    <header className="panel-e overflow-hidden">
      {/* wordmark row */}
      <div className="flex items-center justify-between px-4 sm:px-5 py-2.5 border-b border-line">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold tracking-[-0.02em]">theta<span className="text-accent">lab</span></span>
          <span className="lbl hidden sm:block">Options strategy desk</span>
        </div>
        <button onClick={toggleTheme} className="btn !px-2 !py-1.5" aria-label="Toggle colour theme">
          {theme === "dark" ? <Sun size={14} weight="bold" /> : <Moon size={14} weight="bold" />}
        </button>
      </div>

      {/* instrument + expiry */}
      <div className="px-4 sm:px-5 pt-4 pb-3 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="lbl">{symbol}</div>
          <div className="flex items-baseline gap-2.5 mt-1">
            <AnimatePresence mode="popLayout">
              <motion.span key={spot}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="n n-lg text-[30px] sm:text-[34px] leading-none">{fi(spot)}</motion.span>
            </AnimatePresence>
            {chg != null && (
              <span className={cx("n text-[13px]", chg > 0 ? "text-gain" : chg < 0 ? "text-loss" : "text-muted")}>
                {chg > 0 ? "+" : ""}{fm(chg, 1)}
                <span className="opacity-70"> ({chg > 0 ? "+" : ""}{fm(chgPct, 2)}%)</span>
              </span>
            )}
          </div>
        </div>

        <div className="sm:text-right">
          <div className="lbl">Expiry</div>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}
            className="ctl n mt-1 !py-1.5 !text-[13px] font-medium max-w-[190px]" aria-label="Expiry">
            {expiries.map((k) => (
              <option key={k} value={k}>{fmtDate(k, { day: "2-digit", month: "short", year: "numeric" })}</option>
            ))}
          </select>
        </div>
      </div>

      {/* session navigator — each step names the session it takes you to */}
      <div className="px-4 sm:px-5 pb-3.5">
        <div className="daynav">
          <button className="daynav-step" onClick={() => setDayIdx(Math.max(0, dayIdx - 1))}
            disabled={dayIdx === 0} aria-label="Previous session">
            <span className="cap"><CaretLeft size={9} weight="bold" />Prev</span>
            <span className="val">{dayIdx > 0 ? fmtDate(dates[dayIdx - 1], SHORT) : "—"}</span>
          </button>

          <div className="daynav-now">
            <AnimatePresence mode="popLayout">
              <motion.div key={dates[dayIdx]}
                initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.15, ease: "easeOut" }}>
                <div className="n text-[15px] font-medium leading-none">
                  {fmtDate(dates[dayIdx], { day: "2-digit", month: "short", year: "2-digit" })}
                </div>
                <div className="lbl mt-1">
                  {fmtDate(dates[dayIdx], { weekday: "long" })}
                  {sessionsLeft === 0 && <span className="text-warn"> · expiry</span>}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          <button className="daynav-step items-end text-right"
            onClick={() => setDayIdx(Math.min(dates.length - 1, dayIdx + 1))}
            disabled={dayIdx >= dates.length - 1} aria-label="Next session">
            <span className="cap">Next<CaretRight size={9} weight="bold" /></span>
            <span className="val">
              {dayIdx < dates.length - 1 ? fmtDate(dates[dayIdx + 1], SHORT) : "expiry"}
            </span>
          </button>
        </div>
      </div>

      {/* supporting metrics — on the surface, not in their own cards */}
      <div className="grid grid-cols-3 border-t border-line">
        <div className="px-4 sm:px-5 py-3 border-r border-line">
          <Metric label="Sessions left" value={sessionsLeft === 0 ? "Expiry" : sessionsLeft} />
        </div>
        <div className="px-4 sm:px-5 py-3 border-r border-line">
          <Metric label="ATM IV" value={atmIV ? fm(atmIV * 100, 1) + "%" : "—"}
            sub={sigma ? `1σ ${fi(sigma)} pt` : "unavailable"} />
        </div>
        <div className="px-4 sm:px-5 py-3">
          <Metric label="Lot size" value={lot} />
        </div>
      </div>
    </header>
  );
}
