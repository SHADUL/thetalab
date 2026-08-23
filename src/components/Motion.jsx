import { motion, useSpring, useTransform } from "framer-motion";
import { useEffect } from "react";

export const ease = [0.16, 1, 0.3, 1];

/** Section entrance. Short and restrained — the product should feel fast. */
export const Reveal = ({ children, delay = 0, className = "" }) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.24, delay, ease: "easeOut" }}
    className={className}
  >{children}</motion.div>
);

/** Numbers settle into place rather than snapping. */
export const Ticker = ({ value, format, className = "" }) => {
  const spring = useSpring(value ?? 0, { stiffness: 210, damping: 30, mass: 0.5 });
  const text = useTransform(spring, (v) => format(v));
  useEffect(() => { spring.set(value ?? 0); }, [value, spring]);
  if (value == null || Number.isNaN(value)) return <span className={className}>—</span>;
  return <motion.span className={className}>{text}</motion.span>;
};
