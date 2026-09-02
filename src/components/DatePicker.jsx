import { useState, useRef, useEffect, useMemo } from "react";
import { CaretLeft, CaretRight, CaretDoubleLeft, CaretDoubleRight,
         CalendarBlank } from "@phosphor-icons/react";
import { cx } from "../lib/format";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthKey = (s) => s.slice(0, 7);

/**
 * Session picker.
 *
 * Only days the data actually holds a chain for are selectable — a calendar
 * that let you pick a Sunday, or a session this expiry was not quoted on,
 * would be offering something the bundle cannot answer. Expiry days are marked
 * because they are the ones worth stepping to; everything else in the month is
 * shown but dimmed, so the shape of the month still reads normally.
 */
export default function DatePicker({ value, dates, expirySet, onPick }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthKey(value || iso(new Date())));
  const ref = useRef(null);

  const selectable = useMemo(() => new Set(dates), [dates]);
  const first = dates[0], last = dates[dates.length - 1];

  useEffect(() => { if (value) setMonth(monthKey(value)); }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  /* Six weeks from the Sunday on or before the 1st — a fixed grid, so the
     calendar never changes height as you page through months. */
  const grid = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { key: iso(d), day: d.getDate(), inMonth: d.getMonth() === m - 1 };
    });
  }, [month]);

  const shift = (months) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + months, 1);
    setMonth(monthKey(iso(d)));
  };
  const canGoBack = first ? month > monthKey(first) : false;
  const canGoFwd = last ? month < monthKey(last) : false;

  const label = value
    ? new Date(value + "T00:00:00").toLocaleDateString("en-IN",
        { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : "—";
  const title = new Date(month + "-01T00:00:00")
    .toLocaleDateString("en-IN", { month: "short", year: "numeric" });

  return (
    <div className="relative" ref={ref}>
      <button className="datefield n" onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog" aria-expanded={open}>
        {label}
        <CalendarBlank size={12} weight="regular" />
      </button>

      {open && (
        /* Plain CSS entrance rather than a JS-driven one. A popover has to be
           legible the instant it opens; a requestAnimationFrame animation stalls
           whenever the tab is not compositing and can leave the panel stranded
           half-transparent over the page beneath it. */
        <div className="cal" role="dialog" aria-label="Choose session">
            <div className="cal-head">
              <button className="cal-nav" onClick={() => shift(-12)} disabled={!canGoBack}
                aria-label="Previous year"><CaretDoubleLeft size={11} weight="bold" /></button>
              <button className="cal-nav" onClick={() => shift(-1)} disabled={!canGoBack}
                aria-label="Previous month"><CaretLeft size={11} weight="bold" /></button>
              <span className="cal-title n">{title}</span>
              <button className="cal-nav" onClick={() => shift(1)} disabled={!canGoFwd}
                aria-label="Next month"><CaretRight size={11} weight="bold" /></button>
              <button className="cal-nav" onClick={() => shift(12)} disabled={!canGoFwd}
                aria-label="Next year"><CaretDoubleRight size={11} weight="bold" /></button>
            </div>

            <div className="cal-grid">
              {WEEKDAYS.map((w) => <span key={w} className="cal-wd">{w}</span>)}
              {grid.map((c) => {
                const ok = selectable.has(c.key);
                return (
                  <button key={c.key} disabled={!ok}
                    onClick={() => { onPick(c.key); setOpen(false); }}
                    className={cx("cal-day", !c.inMonth && "is-out", !ok && "is-off",
                      expirySet.has(c.key) && ok && "is-expiry", c.key === value && "is-on")}
                    title={expirySet.has(c.key) ? "Expiry day" : undefined}>
                    {c.day}
                  </button>
                );
              })}
            </div>

            <div className="cal-foot">
              <span className="cal-key"><i className="dot is-expiry" />Expiry day</span>
              <span className="cal-key"><i className="dot is-off" />No session</span>
              <button className="cal-ok" onClick={() => setOpen(false)}>OK</button>
            </div>
        </div>
      )}
    </div>
  );
}
