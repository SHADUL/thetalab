import { useState, useRef } from "react";
import { motion, useMotionValue, useTransform, AnimatePresence } from "framer-motion";
import { LockKey, User, Eye, EyeSlash, ArrowRight, CircleNotch, WarningCircle, ShieldCheck } from "@phosphor-icons/react";

/**
 * Custom login screen — replaces the native, un-stylable HTTP Basic Auth
 * browser prompt. Deliberately its own fixed dark theme (independent of
 * the app's own light/dark toggle) — an auth surface earns the right to
 * make its own first impression, same convention premium SaaS login
 * pages (Linear/Vercel/Stripe) use.
 */

function AuroraBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "#05060a" }}>
      <motion.div
        className="absolute rounded-full"
        style={{ width: 900, height: 900, top: "-20%", left: "-10%", background: "radial-gradient(circle, rgba(99,102,241,0.35) 0%, rgba(99,102,241,0) 70%)" }}
        animate={{ x: [0, 60, 0], y: [0, 40, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{ width: 800, height: 800, bottom: "-25%", right: "-15%", background: "radial-gradient(circle, rgba(56,189,248,0.28) 0%, rgba(56,189,248,0) 70%)" }}
        animate={{ x: [0, -50, 0], y: [0, -30, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{ width: 600, height: 600, top: "30%", left: "40%", background: "radial-gradient(circle, rgba(168,85,247,0.18) 0%, rgba(168,85,247,0) 70%)" }}
        animate={{ x: [0, 40, 0], y: [0, -50, 0] }}
        transition={{ duration: 30, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Fine grid overlay for texture/depth */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      {/* Vignette to keep focus on the centered card */}
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 40%, #05060a 95%)" }} />
    </div>
  );
}

const cardVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1], staggerChildren: 0.06, delayChildren: 0.15 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
};

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [shake, setShake] = useState(0);

  const cardRef = useRef(null);
  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  const springRotateX = useTransform(rotateX, (v) => v);
  const springRotateY = useTransform(rotateY, (v) => v);

  const handlePointerMove = (e) => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    rotateY.set(px * 6); // subtle — a hint of depth, not a gimmick
    rotateX.set(py * -6);
  };
  const handlePointerLeave = () => { rotateX.set(0); rotateY.set(0); };

  const submit = (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    fetch("/api/auth?resource=login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok || !body?.ok) {
          setError("Incorrect username or password.");
          setShake((s) => s + 1);
          setSubmitting(false);
          return;
        }
        const params = new URLSearchParams(window.location.search);
        const next = params.get("next");
        window.location.href = next && next.startsWith("/") ? next : "/";
      })
      .catch(() => {
        setError("Couldn't reach the server — check your connection and try again.");
        setShake((s) => s + 1);
        setSubmitting(false);
      });
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center px-5 overflow-hidden" style={{ perspective: 1200 }}>
      <AuroraBackground />

      <motion.form
        ref={cardRef}
        onSubmit={submit}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        variants={cardVariants}
        initial="hidden"
        animate={shake ? { x: [0, -10, 10, -8, 8, -4, 4, 0] } : "visible"}
        transition={shake ? { duration: 0.45 } : undefined}
        key={shake}
        style={{
          rotateX: springRotateX, rotateY: springRotateY,
          transformStyle: "preserve-3d",
          background: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 24px 70px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03) inset",
        }}
        className="relative w-full max-w-[400px] rounded-[24px] p-9"
      >
        <motion.div variants={itemVariants} className="flex flex-col items-center mb-7" style={{ transform: "translateZ(30px)" }}>
          <div
            className="w-12 h-12 rounded-[14px] flex items-center justify-center mb-4"
            style={{ background: "linear-gradient(135deg, #6366f1, #38bdf8)", boxShadow: "0 8px 24px -6px rgba(99,102,241,0.6)" }}
          >
            <ShieldCheck size={22} weight="bold" color="white" />
          </div>
          <div className="text-[19px] font-bold tracking-[-0.02em] text-white">
            theta<span style={{ color: "#818cf8" }}>lab</span>
          </div>
          <div className="text-[12px] mt-1" style={{ color: "rgba(255,255,255,0.45)" }}>Sign in to continue</div>
        </motion.div>

        <motion.div variants={itemVariants} className="mb-3.5" style={{ transform: "translateZ(20px)" }}>
          <label className="flex items-center gap-2.5 px-3.5 py-3 rounded-[12px] transition-colors"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <User size={16} weight="regular" style={{ color: "rgba(255,255,255,0.4)" }} />
            <input
              type="text" autoComplete="username" placeholder="Username" value={username}
              onChange={(e) => setUsername(e.target.value)} required autoFocus
              className="flex-1 bg-transparent outline-none text-[14px] text-white placeholder:text-[rgba(255,255,255,0.3)]"
            />
          </label>
        </motion.div>

        <motion.div variants={itemVariants} className="mb-2" style={{ transform: "translateZ(20px)" }}>
          <label className="flex items-center gap-2.5 px-3.5 py-3 rounded-[12px]"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <LockKey size={16} weight="regular" style={{ color: "rgba(255,255,255,0.4)" }} />
            <input
              type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Password" value={password}
              onChange={(e) => setPassword(e.target.value)} required
              className="flex-1 bg-transparent outline-none text-[14px] text-white placeholder:text-[rgba(255,255,255,0.3)]"
            />
            <button type="button" onClick={() => setShowPassword((v) => !v)} style={{ color: "rgba(255,255,255,0.4)" }}>
              {showPassword ? <EyeSlash size={16} /> : <Eye size={16} />}
            </button>
          </label>
        </motion.div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1.5 mt-2.5 text-[12px]" style={{ color: "#f87171" }}
            >
              <WarningCircle size={13} weight="fill" />
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          variants={itemVariants}
          type="submit" disabled={submitting}
          whileHover={{ scale: submitting ? 1 : 1.015 }}
          whileTap={{ scale: submitting ? 1 : 0.985 }}
          style={{
            transform: "translateZ(20px)",
            background: "linear-gradient(135deg, #6366f1, #38bdf8)",
            boxShadow: "0 8px 24px -8px rgba(99,102,241,0.55)",
          }}
          className="w-full mt-6 flex items-center justify-center gap-2 py-3 rounded-[12px] text-[14px] font-semibold text-white"
        >
          {submitting ? (
            <motion.span animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}>
              <CircleNotch size={16} weight="bold" />
            </motion.span>
          ) : (
            <>Sign in <ArrowRight size={15} weight="bold" /></>
          )}
        </motion.button>

        <motion.p variants={itemVariants} className="text-[11px] text-center mt-5" style={{ color: "rgba(255,255,255,0.3)" }}>
          Private dashboard — access is restricted to authorized use only.
        </motion.p>
      </motion.form>
    </div>
  );
}
