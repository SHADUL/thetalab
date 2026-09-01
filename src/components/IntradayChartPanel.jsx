import { useEffect, useMemo, useRef, useState } from "react";
import { Plugs, Info } from "@phosphor-icons/react";
import CandleChart from "./CandleChart";
import { CANDLE_INTERVALS, fetchLiveCandles, resolveIndexToken, kiteLoginUrl } from "../lib/kiteClient";
import { cx } from "../lib/format";

/**
 * "Day" is free — built straight from the bundle's own daily OHLC, no Kite
 * needed, always available. Every other timeframe needs the index's own
 * instrument_token (resolved once per symbol and cached in a ref, not
 * re-fetched on every interval switch) and a live Kite session.
 */
export default function IntradayChartPanel({ symbol, dailyOhlc, dates, kiteConnected, colors }) {
  const [interval, setInterval_] = useState("day");
  const [candles, setCandles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const tokenRef = useRef({ symbol: null, token: null });

  const dayCandles = useMemo(() => {
    if (!dailyOhlc || !dates?.length) return [];
    return dates
      .map((d) => {
        const o = dailyOhlc[d];
        if (!o) return null;
        return { t: d, o: o[0], h: o[1], l: o[2], c: o[3] };
      })
      .filter(Boolean);
  }, [dailyOhlc, dates]);

  useEffect(() => {
    if (interval === "day") { setCandles(dayCandles); setError(null); return; }
    if (!kiteConnected) { setCandles(null); return; }

    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let token = tokenRef.current.symbol === symbol ? tokenRef.current.token : null;
        if (!token) {
          token = await resolveIndexToken(symbol);
          tokenRef.current = { symbol, token };
        }
        if (!token) throw new Error(`Could not resolve ${symbol}'s instrument token.`);
        const { candles: c } = await fetchLiveCandles(token, interval);
        if (!cancelled) setCandles(c);
      } catch (e) {
        if (!cancelled) { setError(e.message); setCandles(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [interval, symbol, kiteConnected, dayCandles]);

  const formatTime = (t, full) => {
    if (interval === "day") {
      return new Date(t + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    }
    const d = new Date(t);
    return full
      ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="p-1">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="seg-track !max-w-[340px]" role="tablist" aria-label="Candle timeframe">
          {CANDLE_INTERVALS.map(({ id, label }) => (
            <button key={id} role="tab" aria-selected={interval === id} data-on={interval === id}
              onClick={() => setInterval_(id)} className="seg">{label}</button>
          ))}
        </div>
        {interval !== "day" && !kiteConnected && (
          <a href={kiteLoginUrl()} className="n flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <Plugs size={12} weight="bold" />Connect Kite
          </a>
        )}
      </div>

      {interval !== "day" && !kiteConnected ? (
        <div className="flex gap-2.5 px-4 py-6 rounded-[12px] border border-line text-center flex-col items-center">
          <Info size={18} weight="duotone" className="text-faint" />
          <p className="text-[12.5px] text-muted max-w-[42ch]">
            {CANDLE_INTERVALS.find((c) => c.id === interval)?.label} candles need a live Kite session — the
            daily view above doesn't.
          </p>
        </div>
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px] border border-warn/30"
          style={{ background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12px] text-ink2 leading-relaxed">{error}</p>
        </div>
      ) : loading || !candles ? (
        <div className={cx("flex items-center justify-center text-[12px] text-muted", "h-[320px]")}>
          {loading ? "Fetching candles…" : "No candles for this session yet."}
        </div>
      ) : (
        <CandleChart candles={candles} gain={colors.gain} loss={colors.loss}
          muted={colors.muted} grid={colors.grid} text={colors.ink} formatTime={formatTime} />
      )}
    </div>
  );
}
