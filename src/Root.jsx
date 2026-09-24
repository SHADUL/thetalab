import { useState } from "react";
import App from "./App.jsx";
import SwingScanner from "./components/SwingScanner.jsx";
import IntradayTrader from "./components/IntradayTrader.jsx";
import OptionsAutoTrader from "./components/OptionsAutoTrader.jsx";
import VwapScalper from "./components/VwapScalper.jsx";
import Login from "./components/Login.jsx";

/**
 * Options Desk and Swing Scanner are two genuinely separate products that
 * happen to share this codebase and design system — not two views of the
 * same data. A plain state switch is enough for that; there's nothing to
 * route to yet that a URL needs to address (no per-stock deep links, no
 * shareable scanner filters), so introducing a router now would be
 * structure ahead of an actual need for it.
 *
 * Persisted to localStorage (not just useState) because Kite's login flow
 * is a full-page redirect away and back — without this, connecting Kite
 * from the Swing Scanner would always land back on Options Desk.
 */
const SECTION_KEY = "thetalabSection";

const SECTIONS = [
  { value: "options", label: "Options Desk" },
  { value: "swing", label: "Swing Scanner" },
  { value: "intraday", label: "Intraday Trader" },
  { value: "options-auto", label: "Options Auto-Trader" },
  { value: "vwap-scalper", label: "VWAP Scalper" },
];

export default function Root() {
  const [section, setSectionState] = useState(() => localStorage.getItem(SECTION_KEY) ?? "options");
  const setSection = (s) => {
    setSectionState(s);
    try { localStorage.setItem(SECTION_KEY, s); } catch { /* private browsing, etc. — just won't persist */ }
  };

  // middleware.ts redirects any unauthenticated request straight to
  // /login server-side, before the SPA even loads — this client-side
  // check only decides which component THIS page load renders once
  // we're already here (either freshly redirected while unauthenticated,
  // or navigating to /login directly). It is not itself the security
  // boundary; the middleware/session-cookie check is. Kept below every
  // hook call so Root's hook order never depends on which path this is.
  if (typeof window !== "undefined" && window.location.pathname === "/login") {
    return <Login />;
  }

  return (
    <div className="flex flex-col min-h-screen">
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <span className="text-[12px] font-bold tracking-[-0.02em]">
          theta<span className="text-accent">lab</span>
        </span>
        <select className="inst-sel n sm:hidden" aria-label="Section" value={section}
          onChange={(e) => setSection(e.target.value)}>
          {SECTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        {/* Wrapped in a plain div rather than putting "hidden sm:flex" directly
            on .seg-track — that class sets its own unconditional `display:
            flex` in index.css at equal specificity to Tailwind's `.hidden`,
            so whichever rule loads later in the stylesheet wins regardless
            of breakpoint. A wrapper with no competing custom class sidesteps
            the fight entirely. */}
        <div className="hidden sm:block">
          <div className="seg-track" role="tablist" aria-label="Section">
            {SECTIONS.map((s) => (
              <button key={s.value} role="tab" aria-selected={section === s.value} data-on={section === s.value}
                onClick={() => setSection(s.value)} className="seg">{s.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {section === "options" ? <App />
          : section === "swing" ? <SwingScanner />
          : section === "intraday" ? <IntradayTrader />
          : section === "options-auto" ? <OptionsAutoTrader />
          : <VwapScalper />}
      </div>
    </div>
  );
}
