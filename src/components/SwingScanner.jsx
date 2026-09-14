import { useState, useEffect, useCallback } from "react";
import { MagnifyingGlass, Info, CaretDown, Wallet, ChartLineUp } from "@phosphor-icons/react";
import SwingPortfolio from "./SwingPortfolio.jsx";
import { FundSettingsModal, PositionSizeModal } from "./SwingModals.jsx";
import SwingAutoTrade from "./SwingAutoTrade.jsx";
import StructureScanner from "./StructureScanner.jsx";
import ChartHoverPreview from "./ChartHoverPreview.jsx";
import { toneClass, fm, inr, pctSigned, tradingViewUrl, PRESETS } from "./swingFormat.js";
import { ScoreBadge, FactorBar } from "./ScoreWidgets.jsx";

const ENTRY_STATUS_LABEL = {
  BUY_ZONE: "Buy Zone", NEAR_ENTRY: "Near Entry", WAIT_FOR_BREAKOUT: "Wait for Breakout",
  BREAKOUT_CONFIRMED: "Breakout Confirmed", EXTENDED: "Extended", AVOID: "Avoid",
};
const ENTRY_STATUS_TONE = {
  BUY_ZONE: "gain", NEAR_ENTRY: "accent", WAIT_FOR_BREAKOUT: "muted",
  BREAKOUT_CONFIRMED: "gain", EXTENDED: "warn", AVOID: "loss",
};
const SETUP_LABEL = {
  ATH_BREAKOUT: "ATH Breakout", BREAKOUT: "Breakout", PULLBACK: "Pullback",
  VOLUME_ACCUMULATION: "Volume Accumulation", EARLY_BREAKOUT: "Early Breakout",
  TREND_CONTINUATION: "Trend Continuation", EXTENDED: "Extended", FAILED_BREAKOUT_RISK: "Failed Breakout Risk",
};
const EXTENSION_TONE = { LOW: "gain", MEDIUM: "warn", HIGH: "loss" };
const FACTOR_LABEL = {
  trend: "Trend", momentum: "Momentum", relativeStrength: "Relative Strength", setup: "Breakout / Setup",
  volume: "Volume", sector: "Sector", volatility: "Volatility", riskReward: "Risk/Reward",
};


function DetailPanel({ stock, onClose, onAddClick }) {
  return (
    <div className="p-4 rounded-[14px]" style={{ border: "1px solid var(--c-line)", background: "var(--c-surface)" }}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-bold">{stock.symbol}</h3>
            <span className="text-[11px] text-muted">{stock.name !== stock.symbol ? stock.name : ""}</span>
          </div>
          <span className="text-[11px] text-muted">{stock.sector ?? "Sector unknown"}</span>
        </div>
        <div className="flex items-center gap-2">
          <a href={tradingViewUrl(stock.symbol)} target="_blank" rel="noopener noreferrer" className="topstep flex items-center gap-1.5">
            <ChartLineUp size={12} weight="bold" /> TradingView
          </a>
          <button onClick={() => onAddClick(stock)} className="topstep">Add to Portfolio</button>
          <button onClick={onClose} className="topstep">Close</button>
        </div>
      </div>

      <div className="flex items-center gap-4 mb-4">
        <ScoreBadge score={stock.swingScore} size="lg" />
        <div className="flex flex-col gap-0.5">
          <span className={`text-[11px] font-semibold ${toneClass(ENTRY_STATUS_TONE[stock.entryStatus])}`}>
            {ENTRY_STATUS_LABEL[stock.entryStatus] ?? stock.entryStatus}
          </span>
          <span className="text-[11px] text-muted">{SETUP_LABEL[stock.setupType] ?? stock.setupType}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2.5 mb-4 text-[11px]">
        <div><div className="text-muted">Entry</div><div className="n font-semibold">{inr(stock.price)}</div></div>
        <div><div className="text-muted">Target (+10%)</div><div className="n font-semibold text-gain">{inr(stock.target)}</div></div>
        <div><div className="text-muted">Stop</div><div className="n font-semibold text-loss">{inr(stock.stop)}</div></div>
        <div><div className="text-muted">R:R</div><div className="n font-semibold">{fm(stock.riskReward, 1)}</div></div>
      </div>

      <div className="flex flex-col gap-2.5 mb-4">
        {Object.entries(stock.factors).map(([key, value]) => (
          <FactorBar key={key} label={FACTOR_LABEL[key] ?? key} value={value} />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5 text-[11px] pt-3" style={{ borderTop: "1px solid var(--c-line)" }}>
        <div><div className="text-muted">RS (60d) vs NIFTY</div><div className="n font-semibold">{pctSigned(stock.relativeStrength60d)}</div></div>
        <div><div className="text-muted">Volume</div><div className="n font-semibold">{fm(stock.volRatio, 1)}×</div></div>
        <div><div className="text-muted">52W High Dist.</div><div className="n font-semibold">{pctSigned(stock.dist52wHighPct)}</div></div>
        <div><div className="text-muted">ATH Dist.</div><div className="n font-semibold">{pctSigned(stock.distAthPct)}</div></div>
        <div><div className="text-muted">ATR%</div><div className="n font-semibold">{fm(stock.atrPct, 1)}%</div></div>
        <div>
          <div className="text-muted">Extension Risk</div>
          <div className={`font-semibold ${toneClass(EXTENSION_TONE[stock.extensionRisk])}`}>{stock.extensionRisk}</div>
        </div>
      </div>
    </div>
  );
}

export default function SwingScanner() {
  const [view, setView] = useState("scanner"); // "scanner" | "portfolio"
  const [preset, setPreset] = useState("balanced");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [portfolioRefreshKey, setPortfolioRefreshKey] = useState(0);
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sizingStock, setSizingStock] = useState(null);

  useEffect(() => {
    fetch("/api/swing-settings").then((r) => r.json()).then((body) => {
      if (!body.error) setSettings(body);
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/swing-scanner?preset=${preset}&limit=50`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.message || body.error);
        setData(body);
        setSelected(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [preset]);

  useEffect(() => { load(); }, [load]);

  const confirmAddToPortfolio = useCallback(async (symbol, shares) => {
    const res = await fetch("/api/swing-watchlist", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, shares }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.message || body.error || "Failed to add.");
    if (body.alreadyTracked) {
      // The entry point is captured once and never overwritten, so a
      // second "add" on an already-tracked symbol is a no-op by design —
      // but resolving silently would look like this sizing was applied
      // when it wasn't. Surface it as an error in the modal instead.
      throw new Error(`${symbol} is already in your portfolio — remove it first to re-add with a new share count.`);
    }
    setPortfolioRefreshKey((k) => k + 1);
    setView("portfolio");
    setSelected(null);
    return body;
  }, []);

  const stocks = data?.stocks ?? [];

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <MagnifyingGlass size={16} weight="bold" className="text-accent" />
          <h1 className="text-[16px] font-bold">Swing Scanner</h1>
          {view === "scanner" && data?.date && <span className="text-[11px] text-muted">as of {data.date}</span>}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowSettings(true)} className="topstep flex items-center gap-1.5">
            <Wallet size={12} weight="bold" />
            {settings ? `${inr(settings.totalFund)} · ${settings.riskPct}% risk` : "Set Fund"}
          </button>
          <div className="seg-track" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === "scanner"} data-on={view === "scanner"}
              onClick={() => setView("scanner")} className="seg">Momentum Scan</button>
            <button role="tab" aria-selected={view === "structure"} data-on={view === "structure"}
              onClick={() => setView("structure")} className="seg">Structure Scan</button>
            <button role="tab" aria-selected={view === "portfolio"} data-on={view === "portfolio"}
              onClick={() => setView("portfolio")} className="seg">My Portfolio</button>
            <button role="tab" aria-selected={view === "autotrade"} data-on={view === "autotrade"}
              onClick={() => setView("autotrade")} className="seg">Auto Trade</button>
          </div>
          {view === "scanner" && (
            <div className="relative">
              <select value={preset} onChange={(e) => setPreset(e.target.value)}
                className="n appearance-none text-[12px] font-medium pl-3 pr-8 py-1.5 rounded-[8px] cursor-pointer"
                style={{ border: "1px solid var(--c-line-2)", background: "var(--c-surface)" }}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <CaretDown size={11} weight="bold" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
            </div>
          )}
        </div>
      </div>

      {view === "portfolio" ? (
        <>
          <p className="text-[11px] text-muted mb-4 max-w-[70ch]">
            Positions you've added from the Scanner, tracked from the price and score they had at the moment you added
            them — not re-ranked against the rest of the market like the Scanner is.
          </p>
          <SwingPortfolio refreshKey={portfolioRefreshKey} />
        </>
      ) : view === "autotrade" ? (
        <SwingAutoTrade />
      ) : view === "structure" ? (
        <StructureScanner />
      ) : (
      <>
      <p className="text-[11px] text-muted mb-4 max-w-[70ch]">
        Ranked by <b>Momentum Score</b> under the {PRESETS.find((p) => p.id === preset)?.label.toLowerCase()} weighting — a
        weighted blend of trend/momentum/relative-strength/setup factors, a technical opportunity read, not a
        profitability guarantee. Data refreshes once daily from NSE's own end-of-day prices.
      </p>

      {loading ? (
        <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12.5px] text-ink2">{error}</p>
        </div>
      ) : stocks.length === 0 ? (
        <p className="text-[12.5px] text-muted py-10 text-center">No scored stocks yet — run the scoring pipeline first.</p>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: selected ? "1.7fr 1fr" : "1fr" }}>
          <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                  <th className="font-medium py-2 pl-3 pr-2">#</th>
                  <th className="font-medium py-2 pr-2">Stock</th>
                  <th className="font-medium py-2 pr-2">Score</th>
                  <th className="font-medium py-2 pr-2">Setup</th>
                  <th className="font-medium py-2 pr-2">Status</th>
                  <th className="font-medium py-2 pr-2 text-right">Price</th>
                  <th className="font-medium py-2 pr-2 text-right">Target</th>
                  <th className="font-medium py-2 pr-2 text-right">Stop</th>
                  <th className="font-medium py-2 pr-2 text-right">R:R</th>
                  <th className="font-medium py-2 pr-2 text-right">RS 60d</th>
                  <th className="font-medium py-2 pr-2 text-right">Vol×</th>
                  <th className="font-medium py-2 pr-3 text-right">Ext. Risk</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((s, i) => (
                  <tr key={s.symbol} onClick={() => setSelected(s)}
                    style={{
                      borderTop: "1px solid var(--c-line)", cursor: "pointer",
                      background: selected?.symbol === s.symbol ? "var(--c-accent-soft)" : undefined,
                    }}
                    className={selected?.symbol === s.symbol ? "" : "hover:bg-[var(--c-surface-2)]"}>
                    <td className="py-2 pl-3 pr-2 text-muted n">{i + 1}</td>
                    <td className="py-2 pr-2">
                      <div className="font-semibold"><ChartHoverPreview symbol={s.symbol}>{s.symbol}</ChartHoverPreview></div>
                      <div className="text-[10.5px] text-faint">{s.sector ?? "—"}</div>
                    </td>
                    <td className="py-2 pr-2"><ScoreBadge score={s.swingScore} /></td>
                    <td className="py-2 pr-2 text-[11px]">{SETUP_LABEL[s.setupType] ?? s.setupType}</td>
                    <td className={`py-2 pr-2 text-[11px] font-medium ${toneClass(ENTRY_STATUS_TONE[s.entryStatus])}`}>
                      {ENTRY_STATUS_LABEL[s.entryStatus] ?? s.entryStatus}
                    </td>
                    <td className="py-2 pr-2 text-right n">{inr(s.price)}</td>
                    <td className="py-2 pr-2 text-right n text-gain">{inr(s.target)}</td>
                    <td className="py-2 pr-2 text-right n text-loss">{inr(s.stop)}</td>
                    <td className="py-2 pr-2 text-right n">{fm(s.riskReward, 1)}</td>
                    <td className="py-2 pr-2 text-right n">{pctSigned(s.relativeStrength60d)}</td>
                    <td className="py-2 pr-2 text-right n">{fm(s.volRatio, 1)}×</td>
                    <td className={`py-2 pr-3 text-right text-[11px] font-medium ${toneClass(EXTENSION_TONE[s.extensionRisk])}`}>
                      {s.extensionRisk}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && <DetailPanel key={selected.symbol} stock={selected} onClose={() => setSelected(null)} onAddClick={setSizingStock} />}
        </div>
      )}
      </>
      )}

      {showSettings && (
        <FundSettingsModal settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} />
      )}
      {sizingStock && (
        <PositionSizeModal stock={sizingStock} onClose={() => setSizingStock(null)}
          onConfirm={(shares) => confirmAddToPortfolio(sizingStock.symbol, shares)} />
      )}
    </div>
  );
}
