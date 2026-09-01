import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Lightning, Minus, Plus, Info, Plugs, ArrowsClockwise } from "@phosphor-icons/react";
import { buildEnrichedSlice, entryPriceOf } from "../lib/quantBridge";
import { selectStrategy, isRegimeFailure } from "../quant/strategies/regimeSelect.ts";
import { atmIvOf } from "../quant/analytics/atmIv.ts";
import { expectedMove } from "../quant/analytics/expectedMove.ts";
import { computeSkew } from "../quant/analytics/skew.ts";
import { ivRankAndPercentile } from "../quant/analytics/ivRank.ts";
import { kiteLoginUrl, consumeKiteRedirectResult, assumedKiteConnected, fetchLiveQuotes } from "../lib/kiteClient";
import { kiteInstrument } from "../lib/kiteSymbol";
import { inr, sgn, fm, fi, cnt, cx } from "../lib/format";

/* One fetch per symbol per page load, not per render — the history file is
   ~100-140KB and never changes within a session. The cache itself lives
   outside React state so a cache hit can be read straight from it during
   render; the effect only fires (and only ever calls setState) for the one
   real async event, an actual fetch completing. */
const ivHistoryCache = new Map();
function useIvHistory(symbol) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (ivHistoryCache.has(symbol)) return;
    let cancelled = false;
    fetch(`/atm_iv_${symbol.toLowerCase()}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        ivHistoryCache.set(symbol, data?.points ?? null);
        if (!cancelled) bump((n) => n + 1);
      })
      .catch(() => {
        ivHistoryCache.set(symbol, null);
        if (!cancelled) bump((n) => n + 1);
      });
    return () => { cancelled = true; };
  }, [symbol]);
  return ivHistoryCache.get(symbol) ?? null;
}

const Stepper = ({ value, onChange, step, min, max, fmtv, suffix }) => (
  <span className="stepper">
    <button onClick={() => onChange(Math.max(min, value - step))}><Minus size={10} weight="bold" /></button>
    <span className="n stepper-v" style={{ width: 44 }}>{fmtv ? fmtv(value) : value}{suffix}</span>
    <button onClick={() => onChange(Math.min(max, value + step))}><Plus size={10} weight="bold" /></button>
  </span>
);

/**
 * The thin end-to-end slice: real chain data through the Black-76 quant
 * engine, one Greek-selected Iron Condor out, loadable into the same
 * position mechanism every other strategy source in this app uses. Proof
 * that the wiring works before the rest of the strategy library, scoring
 * model or risk engine gets built on top of it.
 */
export default function QuantStrategyPanel({ chain, spot, expiry, today, lotQty, step = 50,
  symbol = "NIFTY", priceBasis = "open", onLoad }) {
  const [targetDelta, setTargetDelta] = useState(0.16);
  const [wingWidth, setWingWidth] = useState(step * 5);

  const ivHistory = useIvHistory(symbol);

  const [kiteConnected, setKiteConnected] = useState(() => assumedKiteConnected());
  const [live, setLive] = useState({ quotes: null, asOf: null, error: null, loading: false });
  useEffect(() => {
    const r = consumeKiteRedirectResult();
    if (r) setKiteConnected(r.connected);
  }, []);

  const bridged = useMemo(
    () => buildEnrichedSlice({ chain, spot, expiry, today, lotQty, step, symbol }),
    [chain, spot, expiry, today, lotQty, step, symbol],
  );

  // Regime reads don't depend on whether a trade could be built — a NO TRADE
  // session is exactly when knowing IV/skew/expected move matters most.
  const atmIv = bridged?.slice ? atmIvOf(bridged.slice) : null;
  const move = bridged?.slice && atmIv != null
    ? expectedMove(bridged.slice.forward, atmIv, bridged.slice.timeToExpiry) : null;
  const skew = bridged?.slice ? computeSkew(bridged.slice, atmIv) : null;
  const rank = ivHistory && atmIv != null ? ivRankAndPercentile(ivHistory, atmIv) : null;

  // The skew reading decides the structure: a real call-side bid dispatches
  // to a Bull Put Spread, a put-skew beyond the ordinary index baseline
  // dispatches to a Bear Call Spread, and a flat reading falls back to the
  // neutral Iron Condor — see regimeSelect.ts for the actual threshold.
  const outcome = useMemo(() => {
    if (!bridged?.slice) return null;
    return selectStrategy(bridged.slice, skew, {
      targetShortDelta: targetDelta, wingWidth, lotSize: Number(lotQty) || 1,
      entryPriceOverride: entryPriceOf(chain, priceBasis),
    });
  }, [bridged, skew, targetDelta, wingWidth, lotQty, chain, priceBasis]);

  if (!bridged?.slice) {
    return (
      <div>
        <Header />
        <div className="mt-4 px-4 py-6 rounded-[12px] border border-line text-center text-[12.5px] text-muted">
          No usable chain for this session yet.
        </div>
      </div>
    );
  }

  const { slice } = bridged;
  const failed = outcome && isRegimeFailure(outcome);
  const result = outcome?.result;
  const isCondor = outcome?.strategyLabel === "Iron Condor";
  const breakevens = !failed && result
    ? (isCondor ? result.breakevens : [result.breakeven]) : null;

  async function refreshLive() {
    if (!result || failed) return;
    setLive((s) => ({ ...s, loading: true, error: null }));
    try {
      const instruments = result.legs.map((l) => kiteInstrument(symbol, expiry, l.strike, l.right));
      const { quotes, asOf } = await fetchLiveQuotes(instruments);
      setLive({ quotes, asOf, error: null, loading: false });
    } catch (e) {
      setKiteConnected(assumedKiteConnected());
      setLive((s) => ({ ...s, loading: false, error: e.message }));
    }
  }

  return (
    <div>
      <Header strategyLabel={outcome?.strategyLabel} />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 mb-4 px-3.5 py-3 rounded-[12px]"
        style={{ background: "var(--c-surface-2)" }}>
        <Field label="Forward">
          <span className="n text-[13.5px] font-semibold">{fi(slice.forward)}</span>
          <span className="text-[10px] text-faint ml-1">{slice.forwardSource}</span>
        </Field>
        <Field label="ATM IV">
          <span className="n text-[13.5px] font-semibold">
            {atmIv != null ? `${fm(atmIv * 100, 1)}%` : "—"}
          </span>
        </Field>
        <Field label="DTE">
          <span className="n text-[13.5px] font-semibold">{Math.round(slice.timeToExpiry * 365)}</span>
        </Field>
        <div className="ml-auto flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">Short Δ</span>
            <Stepper value={targetDelta} step={0.02} min={0.05} max={0.4}
              fmtv={(v) => v.toFixed(2)} onChange={setTargetDelta} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">Wing</span>
            <Stepper value={wingWidth} step={step} min={step} max={step * 20}
              onChange={setWingWidth} />
          </span>
        </div>
      </div>

      <MarketRegime move={move} skew={skew} rank={rank} symbol={symbol} />

      {outcome && (
        <div className="flex gap-2 px-3.5 py-2.5 mb-4 rounded-[12px]" style={{ background: "var(--c-surface-2)" }}>
          <span className={cx("lbl !text-[9px] px-1.5 py-0.5 rounded shrink-0 h-fit",
            outcome.bias === "bullish" ? "!text-gain bg-gain/8"
              : outcome.bias === "bearish" ? "!text-loss bg-loss/8" : "bg-surface")}>
            {outcome.bias.toUpperCase()}
          </span>
          <p className="text-[11.5px] text-ink2 leading-relaxed">{outcome.biasReason}</p>
        </div>
      )}

      {!result || failed ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px] border border-warn/30"
          style={{ background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <div>
            <div className="text-[12.5px] font-semibold text-warn">NO TRADE</div>
            <p className="text-[12px] text-ink2 mt-0.5 leading-relaxed">
              {result ? result.reason : "Building candidate…"}
            </p>
          </div>
        </div>
      ) : (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <div className="rounded-[12px] border border-line overflow-hidden">
            <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3"
              style={{ background: "var(--c-surface-2)" }}>
              <span className="text-[13.5px] font-semibold">{outcome.strategyLabel}</span>
              <div className="flex items-center gap-2">
                {kiteConnected ? (
                  <button onClick={refreshLive} disabled={live.loading}
                    className="n flex items-center gap-1.5 text-[11px] font-medium text-accent disabled:opacity-50">
                    <ArrowsClockwise size={12} weight="bold" className={live.loading ? "animate-spin" : ""} />
                    {live.loading ? "Fetching…" : "Refresh live quote"}
                  </button>
                ) : (
                  <a href={kiteLoginUrl()}
                    className="n flex items-center gap-1.5 text-[11px] font-medium text-accent">
                    <Plugs size={12} weight="bold" />Connect Kite
                  </a>
                )}
                <span className={cx("n text-[11px] font-semibold px-1.5 py-0.5 rounded",
                  result.netCredit >= 0 ? "text-loss bg-loss/8" : "text-gain bg-gain/8")}>
                  Credit {inr(result.netCredit * (Number(lotQty) || 1))}
                </span>
              </div>
            </div>

            {live.error && (
              <div className="px-4 py-2 border-b border-line text-[11px] text-warn">{live.error}</div>
            )}
            {live.quotes && !live.error && (
              <div className="px-4 py-1.5 border-b border-line text-[10px] text-faint">
                Live as of {new Date(live.asOf).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            )}

            <div className="px-4 py-3 space-y-1 border-b border-line">
              {result.legs.map((l, i) => {
                const key = kiteInstrument(symbol, expiry, l.strike, l.right);
                const lq = live.quotes?.[key];
                return (
                <div key={i} className="n text-[12.5px] flex items-center gap-2.5">
                  <span className={cx("font-semibold w-10", l.side === "SELL" ? "text-loss" : "text-gain")}>
                    {l.side}
                  </span>
                  <span className="w-20">{l.strike} {l.right}</span>
                  <span className="text-muted">@ {fm(l.price)}</span>
                  {lq && (
                    <span className="text-accent font-semibold">
                      live {lq.lastPrice != null ? fm(lq.lastPrice) : "—"}
                      {lq.oi != null && <span className="text-faint font-normal"> · OI {cnt(lq.oi)}</span>}
                    </span>
                  )}
                  <span className="text-faint ml-auto">
                    Δ {l.delta != null ? fm(l.delta, 2) : "—"} · IV {l.iv != null ? fm(l.iv * 100, 1) + "%" : "—"}
                  </span>
                </div>
                );
              })}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-line">
              <Metric label="Max Profit" value={inr(result.maxProfit)} tone="gain" />
              <Metric label="Max Loss" value={inr(-result.maxLoss)} tone="loss" />
              <Metric label="Breakevens" value={breakevens.map(fi).join(" / ")} />
              <Metric label="POP" value={result.pop != null ? `${fm(result.pop * 100, 1)}%` : "—"} />
            </div>

            <div className="grid grid-cols-4 divide-x divide-line border-t border-line">
              <Metric small label="Net Δ" value={fm(result.netGreeks.delta, 3)} />
              <Metric small label="Net Γ" value={fm(result.netGreeks.gamma, 4)} />
              <Metric small label="Net Θ" value={sgn(result.netGreeks.theta)} />
              <Metric small label="Net Vega" value={fm(result.netGreeks.vega, 1)} />
            </div>

            <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted leading-relaxed max-w-[46ch]">
                POP is model-implied from a lognormal assumption — it understates tail risk the same
                way every number from this model does. Not a guarantee.
              </p>
              <button onClick={() => onLoad(result.legs.map((l) => ({
                side: l.side, right: l.right, strike: l.strike, lots: 1, price: l.price,
              })))} className="btn btn-primary shrink-0 !px-3.5 !py-2 !text-[12.5px]">
                Load into Positions
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}

const Header = ({ strategyLabel }) => (
  <div>
    <div className="flex items-center gap-2 mb-1.5">
      <Lightning size={14} weight="regular" className="text-accent" />
      <span className="lbl !text-accent">Quant engine{strategyLabel ? ` · ${strategyLabel}` : ""}</span>
    </div>
    <h2 className="text-[16px] font-semibold tracking-[-0.02em] leading-tight">
      Strikes chosen by delta; the structure chosen by skew.
    </h2>
    <p className="text-[12.5px] text-ink2 mt-1 max-w-[60ch] leading-relaxed">
      Built on the Black-76 engine: every strike's IV is solved from its own settlement price, the
      forward comes from put-call parity (not spot). A real call-side or put-side skew dispatches
      to a Bull Put or Bear Call Spread; a flat reading falls back to a neutral Iron Condor. A
      strategy this session can't actually support comes back as <b>NO TRADE</b> instead of a guess.
    </p>
  </div>
);

/**
 * IV level and skew read as plain classifications, not just raw numbers —
 * closer to how a desk actually talks about the environment. Thresholds are
 * simple and stated here rather than buried: rank/percentile above 70 reads
 * HIGH, below 30 reads LOW; risk reversal beyond ±0.015 (1.5 vol points)
 * reads as a real skew rather than the ordinary put-heavy baseline every
 * index option chain carries.
 */
const MarketRegime = ({ move, skew, rank, symbol }) => {
  const ivLabel = rank == null ? null
    : rank.percentile >= 70 ? "HIGH" : rank.percentile <= 30 ? "LOW" : "NORMAL";
  const ivTone = ivLabel === "HIGH" ? "loss" : ivLabel === "LOW" ? "gain" : null;

  const skewLabel = skew == null ? null
    : skew.riskReversal < -0.015 ? "PUT-HEAVY" : skew.riskReversal > 0.015 ? "CALL-HEAVY" : "NORMAL";

  return (
    <div className="mb-4 rounded-[12px] border border-line overflow-hidden">
      <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5">
        <span className="lbl !text-[10px]">Market Regime</span>
        <div className="flex items-center gap-1.5">
          {ivLabel && (
            <span className={cx("lbl !text-[9px] px-1.5 py-0.5 rounded",
              ivTone === "loss" ? "!text-loss bg-loss/8" : ivTone === "gain" ? "!text-gain bg-gain/8" : "bg-surface2")}>
              IV {ivLabel}
            </span>
          )}
          {skewLabel && (
            <span className="lbl !text-[9px] px-1.5 py-0.5 rounded bg-surface2">SKEW {skewLabel}</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 border-t border-line divide-x divide-line">
        <Metric small label="Expected move (1σ)"
          value={move ? `±${fi(move.points)} (${fm(move.pct * 100, 1)}%)` : "—"} />
        <Metric small label="1σ range"
          value={move ? `${fi(move.oneSigma.lower)}–${fi(move.oneSigma.upper)}` : "—"} />
        <Metric small label={`IV rank / pctile${rank ? ` (${rank.windowDays}d)` : ""}`}
          value={rank ? `${fm(rank.rank, 0)} / ${fm(rank.percentile, 0)}` : "—"} />
        <Metric small label="Risk reversal (25Δ)"
          value={skew ? `${skew.riskReversal >= 0 ? "+" : ""}${fm(skew.riskReversal * 100, 2)}%` : "—"} />
      </div>
      {!rank && (
        <p className="text-[10.5px] text-faint px-3.5 py-2 border-t border-line">
          IV rank/percentile needs {symbol} history — unavailable for this session or too little history to be meaningful.
        </p>
      )}
    </div>
  );
};

const Field = ({ label, children }) => (
  <span className="flex items-baseline gap-1.5">
    <span className="text-[11px] text-muted">{label}</span>
    {children}
  </span>
);

const Metric = ({ label, value, tone, small }) => (
  <div className={cx("px-3", small ? "py-2" : "py-3")}>
    <div className={cx("lbl", small ? "!text-[9px]" : "!text-[10px]")}>{label}</div>
    <div className={cx("n font-bold mt-1", small ? "text-[12px]" : "text-[15px]",
      tone === "gain" && "text-gain", tone === "loss" && "text-loss")}>
      {value}
    </div>
  </div>
);
