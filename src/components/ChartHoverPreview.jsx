import { useState, useRef, useCallback, useEffect } from "react";

const HOVER_DELAY_MS = 300;
const WIDTH = 400;
const HEIGHT = 340;

/**
 * Wraps a symbol so hovering it (after a short delay, to avoid flickering
 * while the pointer just passes over a row) pops up a real TradingView
 * daily chart with MACD + RSI — the same thing the "Open in TradingView"
 * button opens in a new tab, but inline so a dozen stocks can be eyeballed
 * without leaving the table. Uses TradingView's own public embed widget
 * (no API key), reinitialized per-hover via their documented
 * replace-the-script-tag pattern — there's no supported way to just swap
 * the symbol on a live widget instance for this embed type.
 */
export default function ChartHoverPreview({ symbol, children }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState(null);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const widgetContainerRef = useRef(null);

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
    if (!show || !widgetContainerRef.current) return;
    const container = widgetContainerRef.current;
    container.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol: `NSE:${symbol}`,
      interval: "D",
      timezone: "Asia/Kolkata",
      theme: "light",
      style: "1",
      locale: "en",
      studies: ["MACD@tv-basicstudies", "RSI@tv-basicstudies"],
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(script);
  }, [show, symbol]);

  return (
    <span ref={wrapRef} onMouseEnter={onEnter} onMouseLeave={onLeave} className="relative inline-block">
      {children}
      {show && pos && (
        <div
          className="fixed z-[9999] rounded-[10px] overflow-hidden shadow-xl"
          style={{ left: pos.left, top: pos.top, width: WIDTH, height: HEIGHT, border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
          onMouseEnter={cancel}
          onMouseLeave={onLeave}
        >
          <div ref={widgetContainerRef} className="tradingview-widget-container" style={{ width: "100%", height: "100%" }} />
        </div>
      )}
    </span>
  );
}
