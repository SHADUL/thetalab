/**
 * Real-time NIFTY chart (lightweight-charts v5).
 *
 * Updates incrementally from the store — new seconds are appended with
 * series.update(), never a full re-render — so it stays smooth at 1 Hz and
 * at high replay speeds.
 *
 * 1s view distinguishes data quality per point:
 *   FRESH  — at least one real tick that second   (accent line, tick bar)
 *   HELD   — no tick; last price carried forward   (muted line, no tick bar)
 *   STALE  — beyond freshness: gap in the line + red marker bar
 */
import { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, CandlestickSeries, HistogramSeries, createSeriesMarkers, CrosshairMode, LineStyle } from "lightweight-charts";
import { pulse } from "./store.js";
import { istTime, num } from "./format.js";

const IST = 5.5 * 3600;
const TF_SEC = { "1s": 1, "5s": 5, "15s": 15, "1m": 60 };

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function withAlpha(color, a) {
  if (color.startsWith("#") && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}
const toTime = (ms) => Math.floor(ms / 1000) + IST;

function useThemeKey() {
  const [k, setK] = useState(() => document.documentElement.getAttribute("data-theme") ?? "light");
  useEffect(() => {
    const mo = new MutationObserver(() => setK(document.documentElement.getAttribute("data-theme") ?? "light"));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return k;
}

/** Bucket valid samples into OHLC candles of `n` seconds. */
function candleAt(samples, from, to) {
  let o = null, h = -Infinity, l = Infinity, c = null;
  for (let i = from; i < to; i++) {
    const s = samples[i];
    if (!s.valid || s.price == null) continue;
    if (o == null) o = s.price;
    h = Math.max(h, s.price); l = Math.min(l, s.price); c = s.price;
  }
  return o == null ? null : { open: o, high: h, low: l, close: c };
}

export default function PulseChart({ height = 420, timeframe = "1s", showMA = true, showSignals = true, showTicks = true, compact = false }) {
  const wrapRef = useRef(null);
  const legendRef = useRef(null);
  const theme = useThemeKey();
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const C = {
      text: cssVar("--c-text-2", "#5A6478"), line: cssVar("--c-line", "#E2E7EF"), grid: cssVar("--c-grid", "#E7ECF3"),
      accent: cssVar("--c-accent", "#4F46E5"), muted: cssVar("--c-faint", "#AEB7C6"), gain: cssVar("--c-gain", "#067A55"),
      loss: cssVar("--c-loss", "#C8342B"), warn: cssVar("--c-warn", "#9A6B12"), ma: cssVar("--c-warn", "#9A6B12"),
    };
    const chart = createChart(el, {
      width: el.clientWidth, height,
      layout: { background: { color: "transparent" }, textColor: C.text, fontSize: 11, fontFamily: "Inter Variable, system-ui, sans-serif", attributionLogo: false },
      grid: { vertLines: { color: withAlpha(C.grid, 0.6) }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.08, bottom: showTicks ? 0.2 : 0.06 } },
      timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: TF_SEC[timeframe] < 60, rightOffset: 6, barSpacing: timeframe === "1s" ? 3 : 7, minBarSpacing: 0.5 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.muted, style: LineStyle.Dashed, labelBackgroundColor: C.accent }, horzLine: { color: C.muted, style: LineStyle.Dashed, labelBackgroundColor: C.accent } },
      handleScroll: true, handleScale: true,
    });
    const n = TF_SEC[timeframe];
    const main = n === 1
      ? chart.addSeries(LineSeries, { color: C.accent, lineWidth: 2, priceLineVisible: true, priceLineColor: C.accent, lastValueVisible: true, crosshairMarkerRadius: 3 })
      : chart.addSeries(CandlestickSeries, { upColor: C.gain, downColor: C.loss, borderVisible: false, wickUpColor: C.gain, wickDownColor: C.loss });
    const ma = showMA ? chart.addSeries(LineSeries, { color: C.ma, lineWidth: 1.5, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) : null;
    const ticks = showTicks ? chart.addSeries(HistogramSeries, { priceScaleId: "ticks", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false }) : null;
    if (ticks) chart.priceScale("ticks").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    const markers = createSeriesMarkers(main, []);

    let rendered = 0;          // samples consumed
    let maSum = 0, maRun = [];  // rolling MA60 over consecutive valid samples
    let markerKey = "";
    const freshColor = C.accent, heldColor = withAlpha(C.accent, 0.38);

    const pushMA = (s) => {
      if (!ma) return;
      if (!s.valid) { maRun = []; maSum = 0; if (n === 1) ma.update({ time: toTime(s.t) }); return; }
      maRun.push(s.price); maSum += s.price;
      if (maRun.length > 60) maSum -= maRun.shift();
      if (maRun.length === 60) {
        const t = n === 1 ? toTime(s.t) : Math.floor(toTime(s.t) / n) * n;
        ma.update({ time: t, value: maSum / 60 });
      }
    };

    const tickBar = (s) => ({
      time: toTime(s.t),
      value: s.status === "STALE" || s.status === "NO_DATA" ? 0.6 : s.ticks,
      color: s.status === "STALE" || s.status === "NO_DATA" ? withAlpha(C.loss, 0.75) : withAlpha(C.accent, 0.35),
    });

    const point = (s) => (s.valid ? { time: toTime(s.t), value: s.price, color: s.status === "HELD" ? heldColor : freshColor } : { time: toTime(s.t) });

    function full() {
      const samples = pulse.engine.samples;
      rendered = samples.length;
      maRun = []; maSum = 0;
      if (n === 1) {
        main.setData(samples.map(point));
      } else {
        const data = [];
        let i = 0;
        while (i < samples.length) {
          const b = Math.floor(toTime(samples[i].t) / n) * n;
          let j = i;
          while (j < samples.length && Math.floor(toTime(samples[j].t) / n) * n === b) j++;
          const c = candleAt(samples, i, j);
          data.push(c ? { time: b, ...c } : { time: b });
          i = j;
        }
        main.setData(data);
      }
      if (ma) {
        const md = [];
        for (const s of samples) {
          if (!s.valid) { maRun = []; maSum = 0; if (n === 1) md.push({ time: toTime(s.t) }); continue; }
          maRun.push(s.price); maSum += s.price;
          if (maRun.length > 60) maSum -= maRun.shift();
          if (maRun.length === 60) {
            const t = n === 1 ? toTime(s.t) : Math.floor(toTime(s.t) / n) * n;
            if (md.length && md[md.length - 1].time === t) md[md.length - 1].value = maSum / 60; else md.push({ time: t, value: maSum / 60 });
          }
        }
        ma.setData(md);
      }
      if (ticks) ticks.setData(samples.map(tickBar));
      setEmpty(samples.length === 0);
      syncMarkers(true);
    }

    function incremental() {
      const samples = pulse.engine.samples;
      if (samples.length < rendered) { full(); return; }
      for (let k = rendered; k < samples.length; k++) {
        const s = samples[k];
        if (n === 1) main.update(point(s));
        else {
          const b = Math.floor(toTime(s.t) / n) * n;
          let i = k;
          while (i > 0 && Math.floor(toTime(samples[i - 1].t) / n) * n === b) i--;
          const c = candleAt(samples, i, k + 1);
          main.update(c ? { time: b, ...c } : { time: b });
        }
        pushMA(s);
        if (ticks) ticks.update(tickBar(s));
      }
      rendered = samples.length;
      syncMarkers(false);
    }

    function syncMarkers(force) {
      const e = pulse.engine;
      const key = `${e.trades.length}:${e.position?.id ?? ""}:${showSignals ? e.timeline.length : 0}`;
      if (!force && key === markerKey) return;
      markerKey = key;
      const ms = [];
      const tq = (ms_) => (n === 1 ? toTime(ms_) : Math.floor(toTime(ms_) / n) * n);
      if (showSignals) {
        let count = 0;
        for (let i = e.timeline.length - 1; i >= 0 && count < 240; i--) {
          const ev = e.timeline[i];
          if (ev.kind !== "SIGNAL") continue;
          count++;
          ms.push({ time: tq(ev.at), position: ev.direction === "BULLISH" ? "belowBar" : "aboveBar", color: withAlpha(ev.direction === "BULLISH" ? C.gain : C.loss, 0.55), shape: "circle", size: 0.35 });
        }
      }
      for (const t of [...e.trades, ...(e.position ? [e.position] : [])]) {
        const bull = t.direction === "BULLISH";
        ms.push({ time: tq(t.entryAt), position: bull ? "belowBar" : "aboveBar", color: bull ? C.gain : C.loss, shape: bull ? "arrowUp" : "arrowDown", text: compact ? "" : `${bull ? "Bull put" : "Bear call"} ${t.short.strike}`, size: 1.1 });
        if (t.exitAt) {
          const win = (t.realizedNet ?? 0) > 0;
          ms.push({ time: tq(t.exitAt), position: bull ? "aboveBar" : "belowBar", color: C.text, shape: "square", text: compact ? "" : `Exit ${win ? "+" : "−"}₹${Math.abs(Math.round(t.realizedNet ?? 0))}`, size: 0.8 });
        }
      }
      ms.sort((a, b) => a.time - b.time);
      markers.setMarkers(ms);
    }

    full();
    chart.timeScale().scrollToRealTime();
    const unsub = pulse.subscribe(incremental);

    // Crosshair readout (direct DOM, no React state per mouse move).
    chart.subscribeCrosshairMove((p) => {
      const lg = legendRef.current;
      if (!lg) return;
      const samples = pulse.engine.samples;
      const last = samples[samples.length - 1];
      let t, price, maV, tk;
      if (p?.time != null && p.seriesData) {
        const md = p.seriesData.get(main);
        t = (p.time - IST) * 1000;
        price = md ? (md.value ?? md.close) : null;
        maV = ma ? p.seriesData.get(ma)?.value : null;
        tk = ticks ? p.seriesData.get(ticks)?.value : null;
      } else if (last) {
        t = last.t; price = last.price; maV = null; tk = last.ticks;
      }
      lg.innerHTML = t == null ? "" :
        `<span>${istTime(t)} IST</span><span><i style="background:${C.accent}"></i>${price != null ? num(price, 2) : "—"}</span>` +
        (ma ? `<span><i style="background:${C.ma}"></i>MA60 ${maV != null ? num(maV, 2) : "—"}</span>` : "") +
        (ticks && n === 1 ? `<span>${tk === 0.6 ? "stale" : `${tk ?? 0} tick${tk === 1 ? "" : "s"}`}</span>` : "");
    });

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { unsub(); ro.disconnect(); chart.remove(); };
  }, [timeframe, showMA, showSignals, showTicks, height, theme, compact]);

  return (
    <div className="np-chart" style={{ height }}>
      <div className="np-chart-legend" ref={legendRef} />
      <div ref={wrapRef} style={{ width: "100%", height }} />
      {empty && <div className="np-chart-empty">WAITING — no market data yet</div>}
    </div>
  );
}
