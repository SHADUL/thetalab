import { useEffect } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Play, Pause, Sun, Moon,
         SkipBack, SkipForward, Broadcast, Info, Clock } from "@phosphor-icons/react";
import { cx } from "../lib/format";
import DatePicker from "./DatePicker";

/* The day-stepper walks NSE's end-of-day bhavcopy, one session per day — it
   has no finer resolution to offer, and never pretends to. "Today (Live)" is
   a genuinely separate source (real Kite quotes, not bhavcopy replayed
   faster), which is exactly why it swaps this whole control out for a
   minute-stepper rather than adding an extra notch to the day one: the
   minute-stepper's timeline comes from each held leg's own Kite minute
   candles, not from a data source that was never sampled that finely. */

function MinuteStepper({ minuteIdx, setMinuteIdx, minuteSeries, minuteLoading, minuteError }) {
  const times = minuteSeries?.timestamps ?? [];
  const lastIdx = times.length - 1;
  const cur = minuteIdx ?? lastIdx;
  const atStart = !minuteSeries || cur <= 0;
  const atNow = !minuteSeries || minuteIdx == null;

  const label = minuteLoading ? "Loading…"
    : minuteError ? "No minute data"
    : !minuteSeries ? "No position"
    : minuteIdx == null ? "LIVE"
    : new Date(times[minuteIdx]).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <button className={cx("topstep", atStart && "is-off")} disabled={atStart}
        onClick={() => setMinuteIdx(0)} title="Start of today's session">
        <SkipBack size={11} weight="fill" />
      </button>
      <button className={cx("topstep", atStart && "is-off")} disabled={atStart}
        onClick={() => setMinuteIdx(Math.max(0, cur - 1))} title="Previous minute">
        <CaretDoubleLeft size={11} weight="bold" />Min
      </button>

      <span className="datefield n" title={minuteError || "Steps through today's own minute candles"}>
        {label}
        <Clock size={12} weight="regular" />
      </span>

      <button className={cx("topstep", atNow && "is-off")} disabled={atNow}
        onClick={() => setMinuteIdx(cur >= lastIdx ? null : cur + 1)} title="Next minute">
        Min<CaretDoubleRight size={11} weight="bold" />
      </button>
      <button className={cx("topstep", atNow && "is-off")} disabled={atNow}
        onClick={() => setMinuteIdx(null)} title="Jump to now">
        <SkipForward size={11} weight="fill" />
      </button>
    </>
  );
}

export default function TopBar({
  symbol, instruments = [], onPickSymbol, switching,
  dates, dayIdx, setDayIdx, expirySet, autoRun, setAutoRun, theme, toggleTheme,
  live, liveLoading, liveError, onToggleLive,
  minuteIdx, setMinuteIdx, minuteSeries, minuteLoading, minuteError,
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
        {live ? (
          <MinuteStepper minuteIdx={minuteIdx} setMinuteIdx={setMinuteIdx} minuteSeries={minuteSeries}
            minuteLoading={minuteLoading} minuteError={minuteError} />
        ) : (
          <>
            <Step onClick={() => setDayIdx(0)} disabled={dayIdx === 0} title="First session in the run-up">
              <SkipBack size={11} weight="fill" />
            </Step>
            <Step onClick={() => setDayIdx(Math.max(0, dayIdx - 1))} disabled={dayIdx === 0}
              title="Previous session">
              <CaretDoubleLeft size={11} weight="bold" />Day
            </Step>

            <DatePicker value={cur} dates={dates} expirySet={expirySet}
              onPick={(d) => setDayIdx(dates.indexOf(d))} />

            <Step onClick={() => setDayIdx(Math.min(last, dayIdx + 1))} disabled={dayIdx >= last}
              title="Next session">
              Day<CaretDoubleRight size={11} weight="bold" />
            </Step>
            <Step onClick={() => setDayIdx(last)} disabled={dayIdx >= last} title="Jump to expiry">
              <SkipForward size={11} weight="fill" />
            </Step>
          </>
        )}

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
