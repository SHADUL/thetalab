import { useState, useEffect, useCallback } from "react";
import { ChartBar, Info, ChartLineUp, CheckCircle, XCircle } from "@phosphor-icons/react";
import { toneClass, fm, inr, pctSigned, tradingViewUrl } from "./swingFormat.js";
import { ScoreBadge, FactorBar } from "./ScoreWidgets.jsx";
import ChartHoverPreview from "./ChartHoverPreview.jsx";

const GATE_LABEL = {
  priceFloor: "Close > ₹20",
  liquidity: "Yesterday's volume > 70,000",
  near52wHigh: "Close within 25% of 52w high",
  aboveDailyEma20: "Close above daily EMA20",
  weeklyRsiCeiling: "Weekly RSI14 < 75",
  weeklyHigherHigh: "This week's high > last week's",
};
const FACTOR_LABEL = {
  proximity: "52w High Proximity", trend: "Trend (vs EMA20)",
  weeklyMomentum: "Weekly Momentum", weeklyBreakout: "Weekly Breakout Strength",
};

function GateRow({ label, pass }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {pass ? <CheckCircle size={13} weight="fill" className="text-gain shrink-0" /> : <XCircle size={13} weight="fill" className="text-loss shrink-0" />}
      <span className={pass ? "text-ink2" : "text-faint"}>{label}</span>
    </div>
  );
}

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
        <ScoreBadge score={stock.score} size="lg" />
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold text-gain">Passes all 6 conditions</span>
          <span className="text-[11px] text-muted">{inr(stock.price)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 mb-4 p-3 rounded-[10px]" style={{ background: "var(--c-surface-2)" }}>
        {Object.entries(GATE_LABEL).map(([key, label]) => (
          <GateRow key={key} label={label} pass={stock.gates[key]} />
        ))}
      </div>

      <div className="flex flex-col gap-2.5 mb-4">
        {Object.entries(stock.factors).map(([key, value]) => (
          <FactorBar key={key} label={FACTOR_LABEL[key] ?? key} value={value} />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5 text-[11px] pt-3" style={{ borderTop: "1px solid var(--c-line)" }}>
        <div><div className="text-muted">% of 52W High</div><div className="n font-semibold">{fm(stock.pctOf52wHigh, 1)}%</div></div>
        <div><div className="text-muted">% Above EMA20</div><div className="n font-semibold">{pctSigned(stock.pctAboveEma20)}</div></div>
        <div><div className="text-muted">Weekly RSI14</div><div className="n font-semibold">{fm(stock.weeklyRsi14, 1)}</div></div>
        <div><div className="text-muted">Weekly High</div><div className="n font-semibold">{inr(stock.weeklyHigh)}</div></div>
        <div><div className="text-muted">Prior Weekly High</div><div className="n font-semibold">{inr(stock.prevWeeklyHigh)}</div></div>
      </div>
    </div>
  );
}

export default function StructureScanner({ onAddClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/swing-scanner?strategy=structure&limit=50")
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.message || body.error);
        setData(body);
        setSelected(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const stocks = data?.stocks ?? [];

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <ChartBar size={16} weight="bold" className="text-accent" />
        <h2 className="text-[15px] font-bold">Structure Score</h2>
        {data?.date && <span className="text-[11px] text-muted">as of {data.date}</span>}
      </div>
      <p className="text-[11px] text-muted mb-4 max-w-[70ch]">
        A fixed rule-based scan, not a weighted blend like Momentum Score: a stock only appears here if it passes{" "}
        <b>every one</b> of 6 conditions — near its 52-week high, above its daily EMA20, healthy-but-not-overbought
        weekly RSI, and a fresh weekly higher high. The score ranks how strongly qualifying stocks satisfy those
        conditions, not whether they do.
      </p>

      {loading ? (
        <p className="text-[12.5px] text-muted py-10 text-center">Loading…</p>
      ) : error ? (
        <div className="flex gap-2.5 px-4 py-3.5 rounded-[12px]" style={{ border: "1px solid var(--c-warn)", background: "var(--c-warn-soft)" }}>
          <Info size={16} weight="duotone" className="shrink-0 mt-px text-warn" />
          <p className="text-[12.5px] text-ink2">{error}</p>
        </div>
      ) : stocks.length === 0 ? (
        <p className="text-[12.5px] text-muted py-10 text-center">No stocks currently pass every condition — run the scoring pipeline if this seems wrong.</p>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: selected ? "1.7fr 1fr" : "1fr" }}>
          <div className="overflow-x-auto rounded-[14px]" style={{ border: "1px solid var(--c-line)" }}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-muted text-left" style={{ background: "var(--c-surface-2)" }}>
                  <th className="font-medium py-2 pl-3 pr-2">#</th>
                  <th className="font-medium py-2 pr-2">Stock</th>
                  <th className="font-medium py-2 pr-2">Score</th>
                  <th className="font-medium py-2 pr-2 text-right">Price</th>
                  <th className="font-medium py-2 pr-2 text-right">% of 52W High</th>
                  <th className="font-medium py-2 pr-2 text-right">% Above EMA20</th>
                  <th className="font-medium py-2 pr-3 text-right">Weekly RSI</th>
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
                    <td className="py-2 pr-2"><ScoreBadge score={s.score} /></td>
                    <td className="py-2 pr-2 text-right n">{inr(s.price)}</td>
                    <td className="py-2 pr-2 text-right n">{fm(s.pctOf52wHigh, 1)}%</td>
                    <td className={`py-2 pr-2 text-right n ${toneClass(s.pctAboveEma20 >= 0 ? "gain" : "loss")}`}>{pctSigned(s.pctAboveEma20)}</td>
                    <td className="py-2 pr-3 text-right n">{fm(s.weeklyRsi14, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && <DetailPanel stock={selected} onClose={() => setSelected(null)} onAddClick={onAddClick} />}
        </div>
      )}
    </div>
  );
}
