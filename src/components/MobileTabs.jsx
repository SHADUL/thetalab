import { ListBullets, ChartLineUp, Stack } from "@phosphor-icons/react";
import { cx } from "../lib/format";

const TABS = [
  ["chain", "Chain", ListBullets],
  ["analysis", "Analysis", ChartLineUp],
  ["positions", "Positions", Stack],
];

/**
 * Phone-only bottom navigation.
 *
 * On a desk-width screen the chain, analysis and positions sit side by side
 * and a hairline in each panel is enough to tell them apart. On a phone they
 * have to share the same column, and stacking all three made "where am I"
 * the first question every scroll asked. This turns the stack into three
 * screens switched by a fixed bar, the way a phone app organises unrelated
 * views — one thing on screen at a time, always reachable in one tap.
 *
 * Hidden above the phone breakpoint entirely by CSS (see .mobile-tabbar in
 * index.css), so it costs nothing on desktop and needs no viewport check here.
 */
export default function MobileTabs({ active, onChange, legCount, pnl }) {
  return (
    <nav className="mobile-tabbar" aria-label="Desk section">
      {TABS.map(([id, label, Icon]) => (
        <button key={id} className={cx("mtab", active === id && "is-on")}
          onClick={() => onChange(id)} aria-current={active === id ? "page" : undefined}>
          <span className="mtab-icon">
            <Icon size={19} weight={active === id ? "fill" : "regular"} />
            {id === "positions" && legCount > 0 && (
              <span className="mtab-badge">{legCount}</span>
            )}
            {id === "analysis" && legCount > 0 && pnl != null && (
              <span className={cx("mtab-dot", pnl >= 0 ? "is-up" : "is-down")} />
            )}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}
