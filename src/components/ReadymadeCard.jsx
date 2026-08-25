import { motion } from "framer-motion";
import { SHAPES } from "../lib/readymade";
import { cx } from "../lib/format";

/* A stylised two-tone payoff shape: green where the polyline is above the
   zero line, red below, split at each crossing so the colour change lands
   exactly on the axis rather than at a data point near it. */
function ShapeIcon({ shape, gain, loss }) {
  const pts = SHAPES[shape] ?? SHAPES.bull;
  const X = (x) => 4 + x * 56;
  const Y = (y) => 24 - y * 19;

  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    if ((y1 >= 0) === (y2 >= 0)) {
      segs.push({ a: [x1, y1], b: [x2, y2], up: y1 >= 0 });
    } else {
      const t = Math.abs(y1) / (Math.abs(y1) + Math.abs(y2) || 1);
      const xm = x1 + (x2 - x1) * t;
      segs.push({ a: [x1, y1], b: [xm, 0], up: y1 >= 0 });
      segs.push({ a: [xm, 0], b: [x2, y2], up: y2 >= 0 });
    }
  }

  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden>
      <line x1="4" y1="24" x2="60" y2="24" stroke="var(--c-line-2)" strokeWidth="1" strokeDasharray="2 2" />
      {segs.map((s, i) => (
        <line key={i} x1={X(s.a[0])} y1={Y(s.a[1])} x2={X(s.b[0])} y2={Y(s.b[1])}
          stroke={s.up ? gain : loss} strokeWidth="2" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/**
 * One ready-made strategy: shape icon, name, tap to build and load it from
 * the current chain. Disabled — not hidden — when a wing has no traded price
 * this session, so the grid stays the same shape every time you open it.
 */
export default function ReadymadeCard({ strat, disabled, onPick, gain, loss }) {
  return (
    <motion.button
      whileTap={disabled ? undefined : { scale: 0.96 }}
      onClick={() => !disabled && onPick(strat)}
      disabled={disabled}
      title={disabled ? "Not priceable on this session's chain" : `Load ${strat.name}`}
      className={cx("rm-card", disabled && "is-off")}>
      <ShapeIcon shape={strat.shape} gain={gain} loss={loss} />
      <span className="rm-name">{strat.name}</span>
    </motion.button>
  );
}
