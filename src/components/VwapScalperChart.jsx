import { useState, useRef, useCallback, useEffect } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { NIFTY_50_UNIVERSE } from "../vwap-scalper/nifty50Universe.ts";

const HEIGHT = 420;
const REFRESH_MS = 30_000; // the underlying bars only update once a live 1-min candle closes — no point polling faster

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Embedded (not hover-preview, unlike IntradaySignalChart.jsx) chart for
 * the VWAP 3σ scalper — candles plus VWAP (middle) and all six bands
 * (1σ/2σ/3σ, both sides), colored to match the Pine reference script's
 * own scheme (silver 1σ, aqua 2σ, red upper-3σ / lime lower-3σ). Reads
 * the exact same computeVwapBands() series the live scan/monitor use via
 * the vwap-scalper-chart resource — this is a visualization of the real
 * signal engine, not a separate approximation.
 */
export default function VwapScalperChart({ activeSymbols }) {
  const [symbol, setSymbol] = useState(activeSymbols?.[0] ?? "RELIANCE");
  const [chartData, setChartData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    fetch(`/api/options-autotrade?resource=vwap-scalper-chart&symbol=${encodeURIComponent(symbol)}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) { setError(body.message || body.error); setChartData(null); return; }
        setError(null);
        setChartData(body);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol]);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    load();
    timerRef.current = setInterval(load, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [load, expanded]);

  useEffect(() => {
    if (!expanded || !chartData || !containerRef.current) return;
    const container = containerRef.current;
    const gain = cssVar("--c-gain") || "#067A55";
    const loss = cssVar("--c-loss") || "#C8342B";
    const text = cssVar("--c-text-2") || "#5A6478";
    const line = cssVar("--c-line") || "#E2E7EF";

    const chart = createChart(container, {
      width: container.clientWidth,
      height: HEIGHT,
      layout: { background: { color: "transparent" }, textColor: text, fontSize: 11 },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const toTime = (ms) => Math.floor(ms / 1000);
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss,
    });
    candleSeries.setData(chartData.bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));

    const seriesLine = (values, opts) => {
      const s = chart.addSeries(LineSeries, opts);
      s.setData(chartData.bars.map((b, i) => ({ time: toTime(b.t), value: values[i] })).filter((p) => p.value != null));
      return s;
    };
    seriesLine(chartData.vwap, { color: "#d97706", lineWidth: 2, title: "VWAP" });
    seriesLine(chartData.upper1, { color: "#94a3b8", lineWidth: 1, title: "+1σ" });
    seriesLine(chartData.lower1, { color: "#94a3b8", lineWidth: 1, title: "-1σ" });
    seriesLine(chartData.upper2, { color: "#06b6d4", lineWidth: 1, title: "+2σ" });
    seriesLine(chartData.lower2, { color: "#06b6d4", lineWidth: 1, title: "-2σ" });
    seriesLine(chartData.upper3, { color: loss, lineWidth: 2, title: "+3σ" });
    seriesLine(chartData.lower3, { color: gain, lineWidth: 2, title: "-3σ" });

    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [expanded, chartData]);

  return (
    <div className="rounded-[12px] mb-4" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-3 flex-wrap p-3 text-left">
        <span className="text-[11.5px] font-semibold">Chart</span>
        <select
          value={symbol}
          onChange={(e) => { e.stopPropagation(); setSymbol(e.target.value); }}
          onClick={(e) => e.stopPropagation()}
          className="px-1.5 py-0.5 rounded-[6px] text-[11px] n"
          style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
        >
          {NIFTY_50_UNIVERSE.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
        </select>
        <span className="text-[10.5px] text-faint flex-1">
          VWAP (orange) · 1σ (silver) · 2σ (aqua) · 3σ (red/lime) — touch/rejection entries fire at the 3σ bands, target is VWAP.
        </span>
        {expanded ? <CaretUp size={14} className="text-muted shrink-0" /> : <CaretDown size={14} className="text-muted shrink-0" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3" style={{ borderTop: "1px solid var(--c-line)" }}>
          {loading ? (
            <p className="text-[11px] text-muted py-8 text-center">Loading chart…</p>
          ) : error ? (
            <p className="text-[11px] text-loss py-8 text-center">{error}</p>
          ) : (
            <div ref={containerRef} className="w-full mt-2" style={{ height: HEIGHT }} />
          )}
        </div>
      )}
    </div>
  );
}
