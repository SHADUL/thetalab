import { useMemo, useState } from "react";
import { fi, fm, cx } from "../lib/format";

/**
 * A hand-rolled SVG candlestick chart, not a Recharts one — Recharts has no
 * native candlestick primitive, and forcing one out of its Bar/shape API
 * fights the library rather than using it. A fixed viewBox scales
 * responsively via CSS the same way ReadymadeCard's shape icons already do
 * elsewhere in this app, so this is consistent with an existing pattern,
 * not a new one.
 */
const W = 900;
const H = 320;
const PAD = { top: 10, right: 8, bottom: 22, left: 52 };

export default function CandleChart({ candles, gain, loss, muted, grid, text, formatTime }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const { plotW, plotH, x, y, ticksY, ticksX } = useMemo(() => {
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    if (!candles?.length) return { plotW, plotH, x: () => 0, y: () => 0, ticksY: [], ticksX: [] };

    const lo = Math.min(...candles.map((c) => c.l));
    const hi = Math.max(...candles.map((c) => c.h));
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.01 || 1;
    const yMin = lo - pad, yMax = hi + pad;

    const x = (i) => PAD.left + (candles.length <= 1 ? plotW / 2 : (i / (candles.length - 1)) * plotW);
    const y = (v) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    const ticksY = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
    const step = Math.max(1, Math.floor(candles.length / 6));
    const ticksX = candles.map((c, i) => ({ i, t: c.t })).filter((_, i) => i % step === 0);

    return { plotW, plotH, x, y, ticksY, ticksX };
  }, [candles]);

  if (!candles?.length) return null;

  const bodyW = Math.max(1.5, Math.min(10, (plotW / candles.length) * 0.6));
  const hovered = hoverIdx != null ? candles[hoverIdx] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ display: "block" }}
        onMouseLeave={() => setHoverIdx(null)}>
        {ticksY.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={grid} strokeOpacity={0.6} />
            <text x={PAD.left - 6} y={y(v)} textAnchor="end" dominantBaseline="middle"
              fontSize={10} fill={muted}>{fi(v)}</text>
          </g>
        ))}
        {ticksX.map(({ i, t }) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={9.5} fill={muted}>
            {formatTime(t)}
          </text>
        ))}

        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? gain : loss;
          const bt = Math.min(y(c.o), y(c.c));
          const bh = Math.max(1, Math.abs(y(c.c) - y(c.o)));
          return (
            <g key={i} onMouseEnter={() => setHoverIdx(i)} style={{ cursor: "crosshair" }}>
              <rect x={x(i) - bodyW * 1.4} y={PAD.top} width={bodyW * 2.8} height={plotH} fill="transparent" />
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1.1} />
              <rect x={x(i) - bodyW / 2} y={bt} width={bodyW} height={bh} fill={color} />
            </g>
          );
        })}

        {hoverIdx != null && (
          <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD.top} y2={H - PAD.bottom}
            stroke={text} strokeOpacity={0.25} strokeDasharray="3 3" />
        )}
      </svg>

      {hovered && (
        <div className="absolute top-1 left-1 n text-[11px] px-2 py-1 rounded-[6px] flex items-center gap-2"
          style={{ background: "var(--c-surface-2)", border: "1px solid var(--c-line)" }}>
          <span className="text-faint">{formatTime(hovered.t, true)}</span>
          <span>O <b className={cx(hovered.c >= hovered.o ? "text-gain" : "text-loss")}>{fm(hovered.o)}</b></span>
          <span>H <b>{fm(hovered.h)}</b></span>
          <span>L <b>{fm(hovered.l)}</b></span>
          <span>C <b className={cx(hovered.c >= hovered.o ? "text-gain" : "text-loss")}>{fm(hovered.c)}</b></span>
        </div>
      )}
    </div>
  );
}
