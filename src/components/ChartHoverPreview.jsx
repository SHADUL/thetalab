import { useState, useRef, useCallback, useEffect } from "react";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";

const HOVER_DELAY_MS = 300;
const WIDTH = 380;
const HEIGHT = 300;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Wraps a symbol so hovering it (after a short delay, to avoid popping up
 * on every pointer pass over a row) shows a real daily candlestick +
 * volume chart — no need to click into TradingView separately just to
 * eyeball one. Rendered from our own daily_ohlcv via lightweight-charts
 * (a self-contained, open-source charting library), not TradingView's
 * embeddable widget — that widget turned out not to resolve NSE symbols
 * at all (confirmed against several, including well-known ones), so
 * anything reliable for this app has to be built from data we hold
 * ourselves.
 */
export default function ChartHoverPreview({ symbol, children }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState(null);
  const [candles, setCandles] = useState(null);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);

  const onEnter = useCallback(() => {
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
  }, []);

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
    setCandles(null);
    setError(null);
    fetch(`/api/swing-scanner?candles=${encodeURIComponent(symbol)}&limit=150`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) throw new Error(body.message || body.error);
        setCandles(body.bars ?? []);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [show, symbol]);

  useEffect(() => {
    if (!show || !candles || !chartContainerRef.current) return;
    const container = chartContainerRef.current;
    const gain = cssVar("--c-gain") || "#067A55";
    const loss = cssVar("--c-loss") || "#C8342B";
    const text = cssVar("--c-text-2") || "#5A6478";
    const line = cssVar("--c-line") || "#E2E7EF";

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: "transparent" }, textColor: text, fontSize: 10 },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss,
    });
    candleSeries.setData(candles.map((b) => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close })));

    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeSeries.setData(candles.map((b) => ({ time: b.date, value: b.volume, color: b.close >= b.open ? `${gain}66` : `${loss}66` })));

    chart.timeScale().fitContent();

    return () => { chart.remove(); chartRef.current = null; };
  }, [show, candles]);

  return (
    <span ref={wrapRef} onMouseEnter={onEnter} onMouseLeave={onLeave} className="relative inline-block">
      {children}
      {show && pos && (
        <div
          className="fixed z-[9999] rounded-[10px] overflow-hidden shadow-xl flex flex-col"
          style={{ left: pos.left, top: pos.top, width: WIDTH, height: HEIGHT, border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
          onMouseEnter={cancel}
          onMouseLeave={onLeave}
        >
          <div className="px-2.5 py-1.5 text-[11px] font-semibold text-ink shrink-0" style={{ borderBottom: "1px solid var(--c-line)" }}>
            {symbol} <span className="text-faint font-normal">· Daily</span>
          </div>
          <div className="flex-1 min-h-0 relative">
            {error ? (
              <p className="text-[11px] text-loss p-3">{error}</p>
            ) : !candles ? (
              <p className="text-[11px] text-muted p-3">Loading chart…</p>
            ) : (
              <div ref={chartContainerRef} className="w-full h-full" />
            )}
          </div>
        </div>
      )}
    </span>
  );
}
