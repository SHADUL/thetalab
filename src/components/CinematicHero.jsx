import { useRef, useState, useEffect } from "react";
import { motion, useScroll, useTransform, useMotionValue, useSpring } from "framer-motion";
import { ChartLineUp, Broadcast, TrendUp, ShieldCheck } from "@phosphor-icons/react";

/**
 * Cinematic scroll-triggered opening for Options Auto-Trader — the one
 * place in this dashboard where parallax/3D staging genuinely earns its
 * keep (see the conversation this shipped from: a live data tool you
 * check dozens of times a day shouldn't stage its NUMBERS behind scroll
 * reveals, but a one-time cinematic opener above the real dashboard is a
 * different thing entirely). Scrolling past it reaches the actual,
 * unchanged, fully-functional dashboard below.
 */

const WORDS = ["Options", "Auto-Trader"];

const wordVariants = {
  hidden: { opacity: 0, y: 40, rotateX: -40 },
  visible: (i) => ({
    opacity: 1, y: 0, rotateX: 0,
    transition: { duration: 0.8, delay: 0.15 + i * 0.12, ease: [0.16, 1, 0.3, 1] },
  }),
};

/** Decorative-only ticking number for the hero's product-demo card — explicitly labeled "Simulated preview", never mistakable for real data (the real dashboard below has its own real, live-labeled figures). */
function DemoTicker() {
  const [value, setValue] = useState(23841.6);
  useEffect(() => {
    const id = setInterval(() => {
      setValue((v) => Math.max(0, v + (Math.random() - 0.42) * 180));
    }, 1400);
    return () => clearInterval(id);
  }, []);
  const positive = value >= 23841.6;
  return (
    <motion.span
      key={Math.round(value / 10)}
      initial={{ opacity: 0.4, y: positive ? 6 : -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
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

export default function CinematicHero() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });

  const heroOpacity = useTransform(scrollYProgress, [0, 0.85, 1], [1, 1, 0]);
  const bgY = useTransform(scrollYProgress, [0, 1], ["0%", "30%"]);
  const midY = useTransform(scrollYProgress, [0, 1], ["0%", "18%"]);
  const cardRotateX = useTransform(scrollYProgress, [0, 0.6], [22, 0]);
  const cardY = useTransform(scrollYProgress, [0, 1], ["0%", "-8%"]);
  const cardScale = useTransform(scrollYProgress, [0, 0.6], [0.92, 1]);
  const scrollCueOpacity = useTransform(scrollYProgress, [0, 0.12], [1, 0]);

  // Subtle pointer-driven tilt on the product-demo card, layered on top of
  // the scroll-driven rotation above — same restrained mouse-tilt
  // treatment as the login card, not a gimmick.
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
    <div ref={ref} className="relative" style={{ height: "115vh" }}>
      <motion.div
        style={{ opacity: heroOpacity, position: "sticky", top: 0 }}
        className="h-screen w-full flex items-center justify-center overflow-hidden"
      >
        {/* Layer 1 — slow parallax aurora background */}
        <motion.div style={{ y: bgY }} className="absolute inset-0" >
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
        </motion.div>

        {/* Layer 2 — mid-depth content: eyebrow + headline + sub */}
        <motion.div style={{ y: midY }} className="relative z-10 flex flex-col items-center text-center px-6 max-w-[720px]" >
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

          <h1 className="font-display text-[15vw] sm:text-[64px] leading-[0.98] font-bold tracking-[-0.03em] mb-5" style={{ perspective: 800 }}>
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
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="text-[15px] sm:text-[17px] leading-relaxed mb-10" style={{ color: "rgba(255,255,255,0.55)" }}
          >
            Defined-risk options selling, decided from a live chain and executed with real broker
            order sequencing — skew-aware, quality-gated, and monitored every minute.
          </motion.p>
        </motion.div>

        {/* Layer 3 — the floating, 3D-tilted product-demo card (scroll + pointer driven) */}
        <motion.div
          onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}
          initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.75, ease: [0.16, 1, 0.3, 1] }}
          style={{
            y: cardY, scale: cardScale, rotateX: cardRotateX, perspective: 1000,
            position: "absolute", bottom: "6%", zIndex: 5,
          }}
          className="w-[min(90vw,460px)]"
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

        {/* Scroll cue */}
        <motion.div
          style={{ opacity: scrollCueOpacity }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-10"
        >
          <span className="text-[10.5px] tracking-wide" style={{ color: "rgba(255,255,255,0.4)" }}>SCROLL TO VIEW DASHBOARD</span>
          <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
            <ChartLineUp size={16} weight="bold" style={{ color: "rgba(255,255,255,0.4)", transform: "rotate(90deg)" }} />
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  );
}
