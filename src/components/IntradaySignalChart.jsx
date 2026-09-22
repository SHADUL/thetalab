import { useState, useRef, useCallback, useEffect } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { inr } from "./swingFormat.js";

const HOVER_DELAY_MS = 250;
const WIDTH = 640;
const HEIGHT = 440;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Module-scoped like ChartHoverPreview's own candleCache — survives across
// every instance and every hover, so re-hovering a symbol you already
// looked at is instant, and the fetch starts right away rather than
// waiting for the show-delay to elapse first.
const chartCache = new Map(); // symbol -> Promise<ChartData>

function fetchChartCached(symbol) {
  let pending = chartCache.get(symbol);
  if (!pending) {
    pending = fetch(`/api/intraday?resource=chart&symbol=${encodeURIComponent(symbol)}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.message || body.error);
        return body;
      });
    pending.catch(() => { chartCache.delete(symbol); }); // don't cache failures — allow a retry on the next hover
    chartCache.set(symbol, pending);
  }
  return pending;
}

/**
 * Same hover-to-preview pattern as ChartHoverPreview.jsx (Swing Scanner's
 * daily chart) — wraps a symbol so hovering it (after a short delay)
 * shows today's 5-min candles with VWAP/EMA9/EMA20 overlaid and entry/
 * stop/target/opening-range as price lines. No modal/backdrop, same as
 * the Swing version.
 */
export default function IntradaySignalChart({ symbol, candidate, children, className }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  const onEnter = useCallback(() => {
    fetchChartCached(symbol);
    timerRef.current = setTimeout(() => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      let left = rect.right + 8;
      if (left + WIDTH > window.innerWidth) left = Math.max(8, rect.left - WIDTH - 8);
      let top = Math.min(rect.top, window.innerHeight - HEIGHT - 8);
      top = Math.max(8, top);
      setPos({ left, top });
      setShow(true);
    }, HOVER_DELAY_MS);
  }, [symbol]);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onLeave = useCallback(() => {
    cancel();
    setShow(false);
  }, [cancel]);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    setChartData(null);
    setError(null);
    fetchChartCached(symbol)
      .then((body) => { if (!cancelled) setChartData(body); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [show, symbol]);

  useEffect(() => {
    if (!show || !chartData || !containerRef.current) return;
    const container = containerRef.current;
    const gain = cssVar("--c-gain") || "#067A55";
    const loss = cssVar("--c-loss") || "#C8342B";
    const text = cssVar("--c-text-2") || "#5A6478";
    const line = cssVar("--c-line") || "#E2E7EF";
    const faint = cssVar("--c-faint") || "#9AA3B2";

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: "transparent" }, textColor: text, fontSize: 11 },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss,
    });
    // lightweight-charts displays a UTCTimestamp's raw UTC clock reading
    // directly — it does NOT convert to the viewer's own system timezone
    // (verified on VwapScalperChart.jsx's identical chart: a real trade at
    // 15:14 IST was rendering as "09:44", the exact UTC time, regardless
    // of the viewer's own locale). Since every bar's t here is a true UTC
    // epoch, shifting it by the fixed +5:30 IST offset before handing it
    // to the chart makes the displayed clock numbers read as IST — the
    // only timezone that makes sense for an NSE chart — for every viewer.
    const IST_OFFSET_SECONDS = 5.5 * 3600;
    const toTime = (ms) => Math.floor(ms / 1000) + IST_OFFSET_SECONDS;
    candleSeries.setData(chartData.bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));

    const vwapSeries = chart.addSeries(LineSeries, { color: "#d97706", lineWidth: 2, title: "VWAP" });
    vwapSeries.setData(chartData.bars.map((b, i) => ({ time: toTime(b.t), value: chartData.vwap[i] })));

    const ema9Series = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 1, title: "EMA9" });
    ema9Series.setData(
      chartData.bars.map((b, i) => ({ time: toTime(b.t), value: chartData.ema9[i] })).filter((p) => p.value != null),
    );

    const ema20Series = chart.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 1, title: "EMA20" });
    ema20Series.setData(
      chartData.bars.map((b, i) => ({ time: toTime(b.t), value: chartData.ema20[i] })).filter((p) => p.value != null),
    );

    if (chartData.openingRange) {
      candleSeries.createPriceLine({ price: chartData.openingRange.high, color: faint, lineWidth: 1, lineStyle: 3, title: "OR High" });
      candleSeries.createPriceLine({ price: chartData.openingRange.low, color: faint, lineWidth: 1, lineStyle: 3, title: "OR Low" });
    }
    if (candidate?.signal?.entry != null) {
      candleSeries.createPriceLine({ price: candidate.signal.entry, color: text, lineWidth: 1, lineStyle: 2, title: "Entry" });
    }
    if (candidate?.signal?.stop != null) {
      candleSeries.createPriceLine({ price: candidate.signal.stop, color: loss, lineWidth: 2, lineStyle: 0, title: "Stop" });
    }
    if (candidate?.signal?.target1 != null) {
      candleSeries.createPriceLine({ price: candidate.signal.target1, color: gain, lineWidth: 1, lineStyle: 2, title: "T1" });
    }
    if (candidate?.signal?.target2 != null) {
      candleSeries.createPriceLine({ price: candidate.signal.target2, color: gain, lineWidth: 2, lineStyle: 0, title: "T2" });
    }

    chart.timeScale().fitContent();

    return () => { chart.remove(); chartRef.current = null; };
  }, [show, chartData, candidate]);

  return (
    <div ref={wrapRef} onMouseEnter={onEnter} onMouseLeave={onLeave} className={className ?? "relative inline-block"}>
      {children}
      {show && pos && (
        <div
          className="fixed z-[9999] rounded-[10px] overflow-hidden shadow-xl flex flex-col"
          style={{ left: pos.left, top: pos.top, width: WIDTH, height: HEIGHT, border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
          onMouseEnter={cancel}
          onMouseLeave={onLeave}
        >
          <div className="px-3 py-2 text-[12px] font-semibold text-ink shrink-0" style={{ borderBottom: "1px solid var(--c-line)" }}>
            {symbol} <span className="text-faint font-normal">· 5-min · VWAP · EMA9/20{candidate?.signal ? " · Entry/Stop/Targets" : ""}</span>
          </div>
          <div className="flex-1 min-h-0 relative">
            {error ? (
              <p className="text-[11px] text-loss p-3">{error}</p>
            ) : !chartData ? (
              <p className="text-[11px] text-muted p-3">Loading chart…</p>
            ) : (
              <div ref={containerRef} className="w-full h-full" />
            )}
          </div>
          {candidate?.signal && (
            <div className="px-3 py-2 text-[10.5px] text-faint flex flex-wrap gap-x-3 gap-y-0.5 shrink-0" style={{ borderTop: "1px solid var(--c-line)" }}>
              <span>Entry <b className="text-ink2 n">{inr(candidate.signal.entry)}</b></span>
              <span>Stop <b className="text-loss n">{inr(candidate.signal.stop)}</b></span>
              {candidate.signal.target1 != null && <span>T1 <b className="text-gain n">{inr(candidate.signal.target1)}</b></span>}
              {candidate.signal.target2 != null && <span>T2 <b className="text-gain n">{inr(candidate.signal.target2)}</b></span>}
              {candidate.signal.riskReward != null && <span>R:R <b className="n">{candidate.signal.riskReward.toFixed(1)}</b></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
