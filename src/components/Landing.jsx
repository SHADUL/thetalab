import { motion } from "framer-motion";
import { UploadSimple, Sparkle } from "@phosphor-icons/react";

export default function Landing({ onFile, onDemo, loading }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-14">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }} className="w-full max-w-[440px]">
        <div className="flex items-baseline gap-2 mb-8">
          <span className="text-[15px] font-bold tracking-[-0.02em]">theta<span className="text-accent">lab</span></span>
          <span className="lbl">Options strategy desk</span>
        </div>

        <h1 className="text-[30px] leading-[1.1] font-semibold tracking-[-0.03em] mb-3">
          Construct, price and<br />walk forward.
        </h1>
        <p className="text-ink2 leading-relaxed mb-8 text-[14.5px]">
          Build a position on any past expiry, step through it one session at a time, and watch
          the payoff, Greeks and P&amp;L move with the market.
        </p>

        <label className="panel-e block p-5 cursor-pointer group transition-shadow hover:shadow-[var(--e-3)]">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-[10px] bg-surface3 flex items-center justify-center shrink-0">
              <UploadSimple size={17} weight="regular" className="text-ink2" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-[14.5px] mb-0.5">Load chain bundle</div>
              <div className="text-[12.5px] text-muted leading-relaxed">
                The <span className="n">chain_bundle.json</span> built by the downloader.
              </div>
            </div>
          </div>
          <input type="file" accept=".json" onChange={onFile} className="hidden" />
        </label>

        <button onClick={onDemo} className="btn w-full mt-2.5 !py-3">
          <Sparkle size={15} weight="regular" className="text-warn" />
          Explore with sample data
        </button>

        <p className="text-[12px] text-muted mt-4 leading-relaxed">
          Sample premiums are generated from a pricing model, not from NSE. They demonstrate the
          interface only.
        </p>
        {loading && <p className="text-[12px] text-accent mt-3">Loading bundle…</p>}
      </motion.div>
    </div>
  );
}
