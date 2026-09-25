import { useState, useEffect } from "react";
import { motion, useMotionValue, useTransform, useSpring } from "framer-motion";
import { Broadcast, TrendUp, ShieldCheck } from "@phosphor-icons/react";

/**
 * Full-screen cinematic splash shown right after a successful login, before
 * landing on the dashboard — moved here from being a permanent scroll
 * section atop Options Auto-Trader itself (a live data tool you check
 * dozens of times a day shouldn't stage its real numbers behind a scroll
 * reveal every single visit; a ONE-TIME splash on login is a different
 * thing entirely, and is where this cinematic treatment now lives).
 *
 * Auto-plays its entrance, holds briefly, then calls onDone — the parent
 * (Login.jsx) does the actual navigation once this fires, not a scroll
 * gesture.
 */

const WORDS = ["Options", "Auto-Trader"];
const DISPLAY_MS = 2600;

const wordVariants = {
  hidden: { opacity: 0, y: 40, rotateX: -40 },
  visible: (i) => ({
    opacity: 1, y: 0, rotateX: 0,
    transition: { duration: 0.8, delay: 0.15 + i * 0.12, ease: [0.16, 1, 0.3, 1] },
  }),
};

/** Decorative-only ticking number — explicitly labeled "Simulated preview", never mistakable for the real dashboard's own live-labeled figures. */
function DemoTicker() {
  const [value, setValue] = useState(23841.6);
  useEffect(() => {
    const id = setInterval(() => setValue((v) => Math.max(0, v + (Math.random() - 0.42) * 180)), 700);
    return () => clearInterval(id);
  }, []);
  const positive = value >= 23841.6;
  return (
    <motion.span
      key={Math.round(value / 10)}
      initial={{ opacity: 0.4, y: positive ? 6 : -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`n font-bold ${positive ? "text-gain" : "text-loss"}`}
    >
      ₹{value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
    </motion.span>
  );
}

function DemoBars() {
  const [heights] = useState(() => Array.from({ length: 14 }, () => 20 + Math.random() * 70));
  return (
    <div className="flex items-end gap-[3px] h-14">
      {heights.map((h, i) => (
        <motion.div
          key={i}
          initial={{ height: 4 }}
          animate={{ height: h }}
          transition={{ duration: 0.6, delay: 0.6 + i * 0.04, ease: [0.16, 1, 0.3, 1] }}
          className="w-[5px] rounded-full"
          style={{ background: i % 3 === 0 ? "linear-gradient(180deg,#818cf8,#38bdf8)" : "rgba(255,255,255,0.15)" }}
        />
      ))}
    </div>
  );
}

export default function SplashScreen({ onDone }) {
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), DISPLAY_MS);
    return () => clearTimeout(t);
  }, [onDone]);

  // Subtle pointer-driven 3D tilt on the product-demo card — same
  // restrained treatment as the login card itself, not a gimmick.
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const tiltX = useSpring(useTransform(py, [-0.5, 0.5], [6, -6]), { stiffness: 150, damping: 20 });
  const tiltY = useSpring(useTransform(px, [-0.5, 0.5], [-6, 6]), { stiffness: 150, damping: 20 });
  const handlePointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - rect.left) / rect.width - 0.5);
    py.set((e.clientY - rect.top) / rect.height - 0.5);
  };
  const handlePointerLeave = () => { px.set(0); py.set(0); };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-0 flex items-center justify-center overflow-hidden"
      style={{ zIndex: 100 }}
    >
      {/* Aurora background */}
      <div className="absolute inset-0" style={{ background: "#05060a" }} />
      <motion.div
        className="absolute rounded-full"
        style={{ width: 1000, height: 1000, top: "-25%", left: "-15%", background: "radial-gradient(circle, rgba(99,102,241,0.32) 0%, rgba(99,102,241,0) 70%)" }}
        animate={{ x: [0, 70, 0], y: [0, 50, 0] }}
        transition={{ duration: 24, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{ width: 900, height: 900, bottom: "-30%", right: "-15%", background: "radial-gradient(circle, rgba(56,189,248,0.26) 0%, rgba(56,189,248,0) 70%)" }}
        animate={{ x: [0, -60, 0], y: [0, -40, 0] }}
        transition={{ duration: 28, repeat: Infinity, ease: "easeInOut" }}
      />
      <div
        className="absolute inset-0 opacity-[0.045]"
        style={{ backgroundImage: "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)", backgroundSize: "56px 56px" }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-[720px]">
        <motion.div
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-full mb-7"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", backdropFilter: "blur(12px)" }}
        >
          <Broadcast size={12} weight="bold" style={{ color: "#818cf8" }} />
          <span className="text-[11px] font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.75)" }}>
            AUTOMATED OPTIONS EXECUTION
          </span>
        </motion.div>

        <h1 className="font-display text-[13vw] sm:text-[56px] leading-[0.98] font-bold tracking-[-0.03em] mb-5" style={{ perspective: 800 }}>
          {WORDS.map((w, i) => (
            <motion.span
              key={w} custom={i} variants={wordVariants} initial="hidden" animate="visible"
              className="inline-block mr-4"
              style={{
                background: i === 1 ? "linear-gradient(135deg, #818cf8, #38bdf8)" : undefined,
                WebkitBackgroundClip: i === 1 ? "text" : undefined,
                backgroundClip: i === 1 ? "text" : undefined,
                color: i === 1 ? "transparent" : "white",
              }}
            >
              {w}
            </motion.span>
          ))}
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="text-[14px] sm:text-[16px] leading-relaxed mb-8" style={{ color: "rgba(255,255,255,0.55)" }}
        >
          Defined-risk options selling, decided from a live chain and executed with real broker
          order sequencing — skew-aware, quality-gated, and monitored every minute.
        </motion.p>

        <motion.div
          onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}
          initial={{ opacity: 0, y: 30, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.65, ease: [0.16, 1, 0.3, 1] }}
          style={{ perspective: 1000 }}
          className="w-[min(88vw,420px)]"
        >
          <motion.div
            style={{
              rotateX: tiltX, rotateY: tiltY, transformStyle: "preserve-3d",
              background: "linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02))",
              backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow: "0 30px 80px -24px rgba(0,0,0,0.65)",
            }}
            className="rounded-[20px] p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "#2DBE85" }} />
                  <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "#2DBE85" }} />
                </span>
                <span className="text-[10.5px] font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.55)" }}>SIMULATED PREVIEW</span>
              </div>
              <ShieldCheck size={16} weight="bold" style={{ color: "rgba(255,255,255,0.35)" }} />
            </div>
            <div className="flex items-center gap-2 mb-1">
              <TrendUp size={18} weight="bold" style={{ color: "#818cf8" }} />
              <span className="text-[11px]" style={{ color: "rgba(255,255,255,0.45)" }}>Today's P&L</span>
            </div>
            <div className="text-[26px] mb-4"><DemoTicker /></div>
            <DemoBars />
          </motion.div>
        </motion.div>

        {/* Loading indicator — replaces the old scroll cue; this splash
            auto-advances on a timer, there's nothing to scroll here. */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.4, duration: 0.4 }}
          className="flex flex-col items-center gap-2 mt-9"
        >
          <span className="text-[10.5px] tracking-wide" style={{ color: "rgba(255,255,255,0.4)" }}>PREPARING YOUR DASHBOARD</span>
          <div className="w-[140px] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.1)" }}>
            <motion.div
              initial={{ scaleX: 0 }} animate={{ scaleX: 1 }}
              transition={{ duration: (DISPLAY_MS - 1400) / 1000, ease: "linear" }}
              className="h-full w-full"
              style={{ background: "linear-gradient(90deg, #818cf8, #38bdf8)", originX: 0 }}
            />
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
