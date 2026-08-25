import { useEffect, useRef, useState } from "react";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Ticks a displayed number smoothly toward `target` instead of snapping to
 * it — the day-stepper used to swap P&L/margin/etc. straight to the new
 * session's value, which read as a flicker rather than a market move.
 *
 * Re-targets mid-flight rather than queuing: a rapid run of Next Day clicks
 * cancels whatever frame is in progress and starts the next tween from
 * wherever the number currently is, so it always glides toward the latest
 * value instead of stacking up conflicting animations.
 */
export function useAnimatedNumber(target, duration = 550) {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef(null);
  const displayRef = useRef(target);
  const prevTargetRef = useRef(target);

  useEffect(() => {
    if (!isNum(target) || !isNum(prevTargetRef.current) || target === prevTargetRef.current) {
      cancelAnimationFrame(rafRef.current);
      displayRef.current = target;
      setDisplay(target);
      prevTargetRef.current = target;
      return undefined;
    }

    cancelAnimationFrame(rafRef.current);
    const from = isNum(displayRef.current) ? displayRef.current : target;
    const to = target;
    const start = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const v = from + (to - from) * easeOut(t);
      displayRef.current = v;
      setDisplay(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    prevTargetRef.current = target;

    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}
