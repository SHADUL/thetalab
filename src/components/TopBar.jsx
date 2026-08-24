import { useEffect } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Play, Pause, Sun, Moon,
         SkipBack, SkipForward } from "@phosphor-icons/react";
import { cx } from "../lib/format";

/* The reference desk this is modelled on steps in minutes as well as days
   (-2h, -15m, 1m+, SOD, EOD). Those are deliberately absent here: this project
   is built on NSE's end-of-day bhavcopy, so a session is the smallest unit that
   exists in the data. Rendering an intraday control that silently reused the
   closing price would be a lie about the resolution of the underlying source. */

export default function TopBar({
  symbol, dates, dayIdx, setDayIdx, autoRun, setAutoRun, theme, toggleTheme,
}) {
  const last = dates.length - 1;
  const cur = dates[dayIdx];
  const fmtLong = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-IN",
    { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  /* Auto-run walks the session tape and parks itself on expiry. */
  useEffect(() => {
    if (!autoRun) return;
    if (dayIdx >= last) { setAutoRun(false); return; }
    const t = setTimeout(() => setDayIdx(dayIdx + 1), 900);
    return () => clearTimeout(t);
  }, [autoRun, dayIdx, last, setDayIdx, setAutoRun]);

  const Step = ({ onClick, disabled, children, title }) => (
    <button onClick={onClick} disabled={disabled} title={title}
      className={cx("topstep", disabled && "is-off")}>{children}</button>
  );

  return (
    <div className="topbar">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-[13px] font-bold tracking-[-0.02em] shrink-0">
          theta<span className="text-accent">lab</span>
        </span>
        <span className="inst n">{symbol}</span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Step onClick={() => setDayIdx(0)} disabled={dayIdx === 0} title="First session in the run-up">
          <SkipBack size={11} weight="fill" />
        </Step>
        <Step onClick={() => setDayIdx(Math.max(0, dayIdx - 1))} disabled={dayIdx === 0}
          title="Previous session">
          <CaretDoubleLeft size={11} weight="bold" />Day
        </Step>

        <select value={cur} onChange={(e) => setDayIdx(dates.indexOf(e.target.value))}
          className="datesel n" aria-label="Session">
          {dates.map((d, i) => (
            <option key={d} value={d}>{fmtLong(d)}{i === last ? " · expiry" : ""}</option>
          ))}
        </select>

        <Step onClick={() => setDayIdx(Math.min(last, dayIdx + 1))} disabled={dayIdx >= last}
          title="Next session">
          Day<CaretDoubleRight size={11} weight="bold" />
        </Step>
        <Step onClick={() => setDayIdx(last)} disabled={dayIdx >= last} title="Jump to expiry">
          <SkipForward size={11} weight="fill" />
        </Step>

        <button onClick={() => setAutoRun((v) => !v)} disabled={dayIdx >= last && !autoRun}
          className={cx("autorun", autoRun && "is-on", dayIdx >= last && !autoRun && "is-off")}
          title="Play the sessions through to expiry">
          {autoRun ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />}
          Auto Run
        </button>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="lbl hidden lg:block">
          {dayIdx >= last ? "Expiry" : `${last - dayIdx} session${last - dayIdx > 1 ? "s" : ""} left`}
        </span>
        <button onClick={toggleTheme} className="topstep" aria-label="Toggle colour theme">
          {theme === "dark" ? <Sun size={12} weight="bold" /> : <Moon size={12} weight="bold" />}
        </button>
      </div>
    </div>
  );
}
