import { useEffect } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Play, Pause, Sun, Moon,
         SkipBack, SkipForward, Broadcast, Info } from "@phosphor-icons/react";
import { cx } from "../lib/format";
import DatePicker from "./DatePicker";

/* The reference desk this is modelled on steps in minutes as well as days
   (-2h, -15m, 1m+, SOD, EOD). Those still don't exist here — this project is
   built on NSE's end-of-day bhavcopy, one session per day, and rendering an
   intraday control that silently reused the closing price would be a lie
   about the resolution of that data. "Today (Live)" isn't that: it's a
   genuinely separate source (a real Kite quote fetch, not bhavcopy replayed
   at finer resolution), which is exactly why it's its own toggle rather than
   an extra notch on the day-stepper. */

export default function TopBar({
  symbol, instruments = [], onPickSymbol, switching,
  dates, dayIdx, setDayIdx, expirySet, autoRun, setAutoRun, theme, toggleTheme,
  live, liveLoading, liveError, onToggleLive,
}) {
  const last = dates.length - 1;
  const cur = dates[dayIdx];

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
        {instruments.length > 1 ? (
          <select className="inst-sel n" value={symbol} aria-label="Instrument"
            onChange={(e) => onPickSymbol(e.target.value)}>
            {instruments.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        ) : <span className="inst n">{symbol}</span>}
        {switching && <span className="inst-load">loading…</span>}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Step onClick={() => setDayIdx(0)} disabled={live || dayIdx === 0} title="First session in the run-up">
          <SkipBack size={11} weight="fill" />
        </Step>
        <Step onClick={() => setDayIdx(Math.max(0, dayIdx - 1))} disabled={live || dayIdx === 0}
          title="Previous session">
          <CaretDoubleLeft size={11} weight="bold" />Day
        </Step>

        <DatePicker value={live ? null : cur} dates={dates} expirySet={expirySet}
          onPick={(d) => setDayIdx(dates.indexOf(d))} />

        <Step onClick={() => setDayIdx(Math.min(last, dayIdx + 1))} disabled={live || dayIdx >= last}
          title="Next session">
          Day<CaretDoubleRight size={11} weight="bold" />
        </Step>
        <Step onClick={() => setDayIdx(last)} disabled={live || dayIdx >= last} title="Jump to expiry">
          <SkipForward size={11} weight="fill" />
        </Step>

        <button onClick={() => setAutoRun((v) => !v)} disabled={live || (dayIdx >= last && !autoRun)}
          className={cx("autorun", autoRun && "is-on", (live || (dayIdx >= last && !autoRun)) && "is-off")}
          title="Play the sessions through to expiry">
          {autoRun ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />}
          Auto Run
        </button>

        {onToggleLive && (
          <span className="flex items-center gap-1.5">
            <button onClick={onToggleLive} disabled={liveLoading}
              className={cx("autorun", live && "is-on")}
              title={live ? "Back to end-of-day sessions" : "Fetch today's live chain from Kite"}>
              <Broadcast size={11} weight={live ? "fill" : "bold"} />
              {liveLoading ? "Connecting…" : live ? "Today (Live)" : "Go Live"}
            </button>
            {liveError && (
              <span className="flex items-center gap-1 text-[10.5px] text-warn" title={liveError}>
                <Info size={11} weight="bold" />{liveError}
              </span>
            )}
          </span>
        )}
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
