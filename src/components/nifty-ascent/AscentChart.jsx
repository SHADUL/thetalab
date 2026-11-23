/**
 * NIFTY ASCENT charts (lightweight-charts v5).
 *   kind="index"   — NIFTY 1-minute candles (confirmed bars + the forming bar)
 *                    with toggleable level overlays and decision markers.
 *   kind="premium" — the traded option's 1-minute LTP closes with entry,
 *                    fixed-stop, trail-activation, highest and trail lines.
 * Times on the axis are IST.
 */
import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers, CrosshairMode, LineStyle } from "lightweight-charts";
import { ascent, S } from "./store.js";
import { num, hm } from "./format.js";
import { barStart } from "../../nifty-ascent/core/rules.ts";

const IST = 5.5 * 3600;
const css = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
const alpha = (c, a) => { if (c.startsWith("#") && c.length === 7) { const n = parseInt(c.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; } return c; };
const tOf = (date, label) => Math.floor(barStart(date, label) / 1000) + IST;

function useThemeKey() {
  const [k, setK] = useState(() => document.documentElement.getAttribute("data-theme") ?? "light");
  useEffect(() => {
    const mo = new MutationObserver(() => setK(document.documentElement.getAttribute("data-theme") ?? "light"));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return k;
}

const OVERLAYS = [
  { k: "or", label: "OR high / low", style: {} },
  { k: "bands", label: "±10% bands", style: { dash: true } },
  { k: "prev", label: "Prev 15:15 close", style: { dot: true } },
  { k: "williams", label: "Williams CE / PE", style: { dash: true } },
  { k: "markers", label: "Signals & fills", style: {} },
];

export function OverlayToggles() {
  return (
    <div className="na-legend-toggles" role="group" aria-label="Chart overlays">
      {OVERLAYS.map((o) => (
        <button key={o.k} data-on={S.overlays[o.k] ? "true" : "false"} aria-pressed={!!S.overlays[o.k]} onClick={() => ascent.setOverlay(o.k, !S.overlays[o.k])}>
          <i data-dash={o.style.dash ? "true" : undefined} data-dot={o.style.dot ? "true" : undefined}
            style={{ borderTopColor: o.k === "or" ? "var(--c-accent)" : o.k === "bands" ? "var(--c-accent)" : o.k === "prev" ? "var(--c-text-2)" : o.k === "williams" ? "var(--c-accent-2)" : "var(--c-gain)" }} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function AscentChart({ kind = "index", height = 420, compact = false }) {
  const wrap = useRef(null), legend = useRef(null);
  const theme = useThemeKey();
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const C = {
      text: css("--c-text-2", "#5A6478"), line: css("--c-line", "#E2E7EF"), grid: css("--c-grid", "#E7ECF3"), accent: css("--c-accent", "#4F46E5"),
      acc2: css("--c-accent-2", "#7C3AED"), gain: css("--c-gain", "#067A55"), loss: css("--c-loss", "#C8342B"), warn: css("--c-warn", "#9A6B12"),
      faint: css("--c-faint", "#AEB7C6"), ink: css("--c-text", "#111827"),
    };
    const chart = createChart(el, {
      width: el.clientWidth, height,
      layout: { background: { color: "transparent" }, textColor: C.text, fontSize: 11, fontFamily: "Inter Variable, system-ui, sans-serif", attributionLogo: false },
      grid: { vertLines: { color: alpha(C.grid, 0.55) }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: compact ? 3 : 5, minBarSpacing: 0.6 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.faint, style: LineStyle.Dashed, labelBackgroundColor: C.accent }, horzLine: { color: C.faint, style: LineStyle.Dashed, labelBackgroundColor: C.accent } },
    });
    const main = kind === "index"
      ? chart.addSeries(CandlestickSeries, { upColor: C.gain, downColor: C.loss, borderVisible: false, wickUpColor: C.gain, wickDownColor: C.loss, priceLineVisible: false })
      : chart.addSeries(LineSeries, { color: C.accent, lineWidth: 2, priceLineVisible: false, crosshairMarkerRadius: 3 });
    const markers = createSeriesMarkers(main, []);
    let lines = [], lineKey = "", markerKey = "", lastLen = -1, lastDate = "";

    const setLines = (defs) => {
      const key = JSON.stringify(defs.map((d) => [d.title, d.price && Math.round(d.price * 100)]));
      if (key === lineKey) return;
      lineKey = key;
      for (const l of lines) main.removePriceLine(l);
      lines = defs.filter((d) => d.price != null).map((d) => main.createPriceLine({ price: d.price, color: d.color, lineWidth: d.w ?? 1, lineStyle: d.style ?? LineStyle.Solid, axisLabelVisible: !compact, title: compact ? "" : d.title }));
    };

    function sync() {
      const e = S.replay.engine, date = e.date, ov = S.overlays;
      if (date !== lastDate) { lastDate = date; lastLen = -1; }
      if (kind === "index") {
        const bars = e.index.bars.filter((b) => b.close != null).map((b) => ({ time: tOf(date, b.label), open: b.open, high: b.high, low: b.low, close: b.close }));
        const f = e.index.formingBar();
        if (f?.close != null && (!bars.length || bars[bars.length - 1].time < tOf(date, f.label))) bars.push({ time: tOf(date, f.label), open: f.open, high: f.high, low: f.low, close: f.close, color: alpha(C.faint, 0.9), wickColor: C.faint });
        main.setData(bars);
        if (bars.length !== lastLen) { if (lastLen <= 0 && bars.length) chart.timeScale().fitContent(); lastLen = bars.length; }
        setEmpty(bars.length === 0);
        const L = [];
        if (ov.or && e.or) L.push({ price: e.or.high, color: C.accent, title: "OR high" }, { price: e.or.low, color: C.accent, title: "OR low" });
        if (ov.bands && e.or) L.push({ price: e.or.upsideBand, color: C.gain, style: LineStyle.Dashed, title: "Up band +10%" }, { price: e.or.downsideBand, color: C.loss, style: LineStyle.Dashed, title: "Down band −10%" });
        if (ov.prev && e.prevClose != null) L.push({ price: e.prevClose, color: C.text, style: LineStyle.Dotted, w: 2, title: "Prev 15:15" });
        if (ov.williams && e.williams) L.push({ price: e.williams.ceLevel, color: C.acc2, style: LineStyle.LargeDashed, title: "Williams CE" }, { price: e.williams.peLevel, color: C.acc2, style: LineStyle.LargeDashed, title: "Williams PE" });
        setLines(L);
        const M = [];
        if (ov.markers) {
          if (e.gapFill) M.push({ time: tOf(date, Math.floor((e.gapFill.exchTs - barStart(date, 0)) / 60000)), position: e.gap.direction === "UP" ? "belowBar" : "aboveBar", color: C.warn, shape: "circle", text: "", size: 0.8 });
          if (e.standDown && e.standDown.reason !== "no_break") M.push({ time: tOf(date, e.standDown.bar), position: "aboveBar", color: C.warn, shape: "square", text: compact ? "" : e.standDown.reason, size: 0.9 });
          if (e.handover) M.push({ time: tOf(date, e.handover.bar), position: "belowBar", color: C.acc2, shape: "circle", text: "", size: 0.9 });
          if (e.signal) M.push({ time: tOf(date, e.signal.bar), position: e.signal.right === "CE" ? "belowBar" : "aboveBar", color: e.signal.right === "CE" ? C.gain : C.loss, shape: e.signal.right === "CE" ? "arrowUp" : "arrowDown", text: compact ? "" : `${e.signal.bot === "WILLIAMS" ? "W" : "G&G"} ${e.signal.right} signal`, size: 1.2 });
          const fill = e.entryOrder?.fill;
          if (fill) M.push({ time: tOf(date, Math.floor((fill.quoteExchTs - barStart(date, 0)) / 60000)), position: "belowBar", color: C.ink, shape: "circle", text: "", size: 0.7 });
          const xf = e.exitOrder?.fill;
          if (xf) M.push({ time: tOf(date, Math.floor((xf.quoteExchTs - barStart(date, 0)) / 60000)), position: "aboveBar", color: C.ink, shape: "square", text: "", size: 0.7 });
        }
        const mk = JSON.stringify(M.map((m) => [m.time, m.text]));
        if (mk !== markerKey) { markerKey = mk; M.sort((a, b) => a.time - b.time); markers.setMarkers(M); }
      } else {
        const pb = e.premiumBars();
        const data = pb.map((b) => (b.close != null ? { time: tOf(date, b.label), value: b.close } : { time: tOf(date, b.label) }));
        main.setData(data);
        if (data.length !== lastLen) { if (lastLen <= 0 && data.length) chart.timeScale().fitContent(); lastLen = data.length; }
        setEmpty(data.length === 0);
        const p = e.position, t = e.trade;
        const entry = p?.entryPremium ?? t?.entryPremium;
        const L = [];
        if (entry != null) {
          L.push({ price: entry, color: C.ink, title: "Entry" }, { price: entry * 0.7, color: C.loss, style: LineStyle.Dashed, title: "Fixed stop −30%" }, { price: entry * 1.05, color: C.gain, style: LineStyle.Dotted, title: "Trail arms >105%" });
          const hi = p?.highest ?? t?.highest;
          if (hi != null) L.push({ price: hi, color: C.acc2, style: LineStyle.Dotted, title: "Highest close" });
          if (p?.trailActive) L.push({ price: p.trailStop, color: C.warn, w: 2, title: "Trail stop" });
          if (t && !p) L.push({ price: t.exitPremium, color: C.text, style: LineStyle.SparseDotted, title: "Exit fill" });
        }
        setLines(L);
        const M = [];
        const fill = e.entryOrder?.fill, xf = e.exitOrder?.fill;
        if (fill) M.push({ time: tOf(date, Math.floor((fill.quoteExchTs - barStart(date, 0)) / 60000)), position: "belowBar", color: C.gain, shape: "arrowUp", text: "", size: 1 });
        if (p?.exitSignal?.bar != null || t?.exitSignalBar != null) M.push({ time: tOf(date, p?.exitSignal?.bar ?? t.exitSignalBar), position: "aboveBar", color: C.warn, shape: "circle", text: "", size: 0.8 });
        if (xf) M.push({ time: tOf(date, Math.floor((xf.quoteExchTs - barStart(date, 0)) / 60000)), position: "aboveBar", color: C.loss, shape: "arrowDown", text: "", size: 1 });
        const mk = JSON.stringify(M.map((m) => [m.time, m.text]));
        if (mk !== markerKey) { markerKey = mk; M.sort((a, b) => a.time - b.time); markers.setMarkers(M); }
      }
    }
    sync();
    const off = ascent.subscribe(sync);

    chart.subscribeCrosshairMove((p) => {
      const lg = legend.current;
      if (!lg) return;
      const d = p?.time != null ? p.seriesData?.get(main) : null;
      if (!d) { lg.textContent = ""; return; }
      const label = Math.round((p.time - IST - barStart(S.replay.engine.date, 0) / 1000) / 60);
      lg.textContent = kind === "index"
        ? `${hm(label)} IST · O ${num(d.open, 2)} H ${num(d.high, 2)} L ${num(d.low, 2)} C ${num(d.close, 2)}`
        : `${hm(label)} IST · premium close ₹${num(d.value, 2)}`;
    });
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { off(); ro.disconnect(); chart.remove(); };
  }, [kind, height, theme, compact]);

  return (
    <div className="na-chart" style={{ height }}>
      <div className="na-chart-legend" ref={legend} />
      <div ref={wrap} style={{ width: "100%", height }} />
      {empty && <div className="na-chart-empty">{kind === "index" ? "WAITING — no NIFTY bars yet (press Play)" : "No option position yet — the premium chart follows the traded contract"}</div>}
    </div>
  );
}
