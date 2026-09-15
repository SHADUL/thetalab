import { useState, useEffect, useCallback, useRef } from "react";
import { Lightning, Info } from "@phosphor-icons/react";
import { inr, pctSigned, toneClass } from "./swingFormat.js";
import { ScoreBadge } from "./ScoreWidgets.jsx";
import { kiteLoginUrl, assumedKiteConnected, consumeKiteRedirectResult } from "../lib/kiteClient.js";

const POLL_MS = 20_000; // browser-driven "continuous" scan — see api/intraday.js's header comment on why

const REGIME_TONE = {
  STRONG_BULLISH: "gain", BULLISH: "gain", NEUTRAL: "muted", BEARISH: "loss", STRONG_BEARISH: "loss",
};
const REGIME_LABEL = {
  STRONG_BULLISH: "Strong Bullish", BULLISH: "Bullish", NEUTRAL: "Neutral", BEARISH: "Bearish", STRONG_BEARISH: "Strong Bearish",
};

/**
 * Intraday Trader — v1 vertical slice: Market Regime + Stock Ranking only.
 * Setup detection (ORB/VWAP Pullback/EMA Trend Continuation), the entry
 * checklist/signal engine, risk sizing, and paper execution are built
 * (src/intraday/*.ts, tested) but not yet wired into this live endpoint —
 * that needs today's 5-min candle history per candidate, a second pass on
 * top of this ranking. This view ranks candidates; it does not yet confirm
 * tradeable signals. Said directly in the UI, not left implicit.
 */
export default function IntradayTrader() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kiteConnected, setKiteConnected] = useState(() => assumedKiteConnected());
  const timerRef = useRef(null);

  useEffect(() => {
    const r = consumeKiteRedirectResult();
    if (r) setKiteConnected(r.connected);
  }, []);

  const load = useCallback(() => {
    fetch("/api/intraday?resource=scan")
      .then((r) => r.json())
      .then((body) => {
        if (body.error) { setError(body.message || body.error); setData(null); return; }
        setError(null);
        setData(body);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const regime = data?.regime;
  const candidates = data?.candidates ?? [];

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Lightning size={16} weight="bold" className="text-accent" />
          <h1 className="text-[16px] font-bold">Intraday Trader</h1>
          {data?.asOf && <span className="text-[11px] text-muted">as of {new Date(data.asOf).toLocaleTimeString("en-IN")}</span>}
        </div>
        {!kiteConnected && (
          <a href={kiteLoginUrl()} className="topstep">Connect Kite</a>
        )}
      </div>
      <p className="text-[11px] text-muted mb-4 max-w-[75ch]">
        v1 slice: live market regime + a liquid-universe ranking (relative strength, volume, VWAP position, sector, regime
        alignment) refreshed every 20s while this tab is open. Setup detection and confirmed entry signals are the next pass —
        this ranks candidates, it does not yet confirm a trade.
      </p>

      {loading ? (
        <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12.5px] text-ink2">{error}</p>
        </div>
      ) : (
        <>
          {regime && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-4">
              <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
                <div className="text-[11px] text-muted mb-0.5">Market Regime</div>
                <div className={`text-[14px] font-bold ${toneClass(REGIME_TONE[regime.regime])}`}>{REGIME_LABEL[regime.regime]}</div>
              </div>
              <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
                <div className="text-[11px] text-muted mb-0.5">NIFTY 50</div>
                <div className={`text-[14px] font-bold n ${regime.niftyReturnPct >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(regime.niftyReturnPct)}</div>
                <div className="text-[10.5px] text-faint">{regime.niftyAboveVwap ? "Above VWAP" : "Below VWAP"}</div>
              </div>
              <div className="p-3 rounded-[12px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
                <div className="text-[11px] text-muted mb-0.5">BANK NIFTY</div>
                <div className={`text-[14px] font-bold n ${regime.bankNiftyReturnPct >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(regime.bankNiftyReturnPct)}</div>
                <div className="text-[10.5px] text-faint">{regime.bankNiftyAboveVwap ? "Above VWAP" : "Below VWAP"}</div>
              </div>
            </div>
          )}

          <h2 className="text-[13px] font-bold mb-2">Top Intraday Candidates {data?.universeSize ? <span className="font-normal text-muted">({data.universeSize} liquid stocks scanned)</span> : null}</h2>
          {candidates.length === 0 ? (
            <p className="text-[12.5px] text-muted py-10 text-center">No candidates yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                    <th className="font-medium py-2 pl-3 pr-2">#</th>
                    <th className="font-medium py-2 pr-2">Stock</th>
                    <th className="font-medium py-2 pr-2">Score</th>
                    <th className="font-medium py-2 pr-2">Direction</th>
                    <th className="font-medium py-2 pr-2 text-right">Price</th>
                    <th className="font-medium py-2 pr-2 text-right">Change</th>
                    <th className="font-medium py-2 pr-2">VWAP</th>
                    <th className="font-medium py-2 pr-3 text-right">RVOL</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c, i) => (
                    <tr key={c.symbol} style={{ borderTop: "1px solid var(--c-line)" }}>
                      <td className="py-2 pl-3 pr-2 text-muted n">{i + 1}</td>
                      <td className="py-2 pr-2">
                        <div className="font-semibold">{c.symbol}</div>
                        <div className="text-[10.5px] text-faint">{c.sector ?? "—"}</div>
                      </td>
                      <td className="py-2 pr-2"><ScoreBadge score={c.score} /></td>
                      <td className={`py-2 pr-2 text-[11px] font-medium ${c.direction === "LONG" ? "text-gain" : "text-loss"}`}>{c.direction}</td>
                      <td className="py-2 pr-2 text-right n">{inr(c.price)}</td>
                      <td className={`py-2 pr-2 text-right n ${c.returnPct >= 0 ? "text-gain" : "text-loss"}`}>{pctSigned(c.returnPct)}</td>
                      <td className={`py-2 pr-2 text-[11px] ${c.aboveVwap ? "text-gain" : "text-loss"}`}>{c.aboveVwap ? "Above" : "Below"}</td>
                      <td className="py-2 pr-3 text-right n">{c.rvol != null ? `${c.rvol.toFixed(1)}×` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
