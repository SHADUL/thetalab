import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { X } from "@phosphor-icons/react";
import { inr } from "./swingFormat.js";

const WIDTH = 720;
const HEIGHT = 460;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * On-demand per-stock chart for one candidate — today's 5-min bars with
 * VWAP/EMA9/EMA20 overlaid as line series and entry/stop/target/opening-
 * range levels as horizontal price lines, via lightweight-charts (same
 * library ChartHoverPreview.jsx already uses for the Swing Scanner's
 * daily hover preview, just intraday bars + more overlays here). Fetches
 * `/api/intraday?resource=chart&symbol=X` only when opened — this data
 * isn't part of the regular 20s scan poll.
 */
export default function IntradaySignalChart({ symbol, candidate, onClose }) {
  const [chartData, setChartData] = useState(null);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setChartData(null);
    setError(null);
    fetch(`/api/intraday?resource=chart&symbol=${encodeURIComponent(symbol)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) { setError(body.message || body.error); return; }
        setChartData(body);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [symbol]);

  useEffect(() => {
    if (!chartData || !containerRef.current) return;
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
    const toTime = (ms) => Math.floor(ms / 1000);
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
  }, [chartData, candidate]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }} onClick={onClose}>
      <div
        className="rounded-[14px] flex flex-col"
        style={{ width: WIDTH, maxWidth: "100%", border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--c-line)" }}>
          <div>
            <span className="text-[14px] font-bold">{symbol}</span>
            <span className="text-[11px] text-faint ml-2">5-min · VWAP · EMA9/20{candidate?.signal ? " · Entry/Stop/Targets" : ""}</span>
          </div>
          <button onClick={onClose} className="text-muted"><X size={16} weight="bold" /></button>
        </div>
        <div style={{ height: HEIGHT }} className="relative">
          {error ? (
            <p className="text-[12px] text-loss p-4">{error}</p>
          ) : !chartData ? (
            <p className="text-[12px] text-muted p-4">Loading chart…</p>
          ) : (
            <div ref={containerRef} className="w-full h-full" />
          )}
        </div>
        {candidate?.signal && (
          <div className="px-4 py-2.5 text-[11px] text-faint flex flex-wrap gap-x-4 gap-y-1" style={{ borderTop: "1px solid var(--c-line)" }}>
            <span>Entry <b className="text-ink2 n">{inr(candidate.signal.entry)}</b></span>
            <span>Stop <b className="text-loss n">{inr(candidate.signal.stop)}</b></span>
            {candidate.signal.target1 != null && <span>T1 <b className="text-gain n">{inr(candidate.signal.target1)}</b></span>}
            {candidate.signal.target2 != null && <span>T2 <b className="text-gain n">{inr(candidate.signal.target2)}</b></span>}
            {candidate.signal.riskReward != null && <span>R:R <b className="n">{candidate.signal.riskReward.toFixed(1)}</b></span>}
          </div>
        )}
      </div>
    </div>
  );
}
