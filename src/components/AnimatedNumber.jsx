import { useAnimatedNumber } from "../lib/useAnimatedNumber";

/**
 * Renders `format(value)`, but ticks the underlying number smoothly on
 * change instead of snapping — sign and currency formatting stay correct
 * throughout because `format` re-runs on every interpolated frame rather
 * than the string itself being tweened.
 */
export default function AnimatedNumber({ value, format, duration = 550 }) {
  const display = useAnimatedNumber(typeof value === "number" ? value : NaN, duration);
  return format(Number.isFinite(display) ? display : value);
}
