import { useState } from "react";
import App from "./App.jsx";
import SwingScanner from "./components/SwingScanner.jsx";
import IntradayTrader from "./components/IntradayTrader.jsx";

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

export default function Root() {
  const [section, setSectionState] = useState(() => localStorage.getItem(SECTION_KEY) ?? "options");
  const setSection = (s) => {
    setSectionState(s);
    try { localStorage.setItem(SECTION_KEY, s); } catch { /* private browsing, etc. — just won't persist */ }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
        <span className="text-[12px] font-bold tracking-[-0.02em]">
          theta<span className="text-accent">lab</span>
        </span>
        <div className="seg-track" role="tablist" aria-label="Section">
          <button role="tab" aria-selected={section === "options"} data-on={section === "options"}
            onClick={() => setSection("options")} className="seg">Options Desk</button>
          <button role="tab" aria-selected={section === "swing"} data-on={section === "swing"}
            onClick={() => setSection("swing")} className="seg">Swing Scanner</button>
          <button role="tab" aria-selected={section === "intraday"} data-on={section === "intraday"}
            onClick={() => setSection("intraday")} className="seg">Intraday Trader</button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {section === "options" ? <App /> : section === "swing" ? <SwingScanner /> : <IntradayTrader />}
      </div>
    </div>
  );
}
