import { MagnifyingGlass, DownloadSimple } from "@phosphor-icons/react";
import { fm, fi, cx } from "../lib/format";

const Delta = ({ pts, pct }) => {
  if (pts == null) return null;
  const tone = pts > 0 ? "text-gain" : pts < 0 ? "text-loss" : "text-muted";
  return (
    <span className={cx("n text-[11px] ml-1.5", tone)}>
      ({pts > 0 ? "+" : ""}{fm(pts, 1)}pt, {pts > 0 ? "+" : ""}{fm(pct, 2)}%)
    </span>
  );
};

const Quote = ({ label, value, pts, pct, note }) => (
  <span className="flex items-baseline gap-1.5 whitespace-nowrap">
    <span className="text-[11.5px] text-muted">{label}:</span>
    <span className="n text-[13px] font-medium text-ink">{value}</span>
    {note && <span className="text-[10.5px] text-muted">{note}</span>}
    <Delta pts={pts} pct={pct} />
  </span>
);

/**
 * The quote strip. The reference desk also carries a live futures price and an
 * "Add Futures" leg; both are absent here because the bhavcopy downloader keeps
 * only CE/PE rows, so this project has no futures series to quote. The
 * synthetic future is shown instead — it is derived from the ATM call and put
 * by put-call parity, which is the forward the options are actually pricing.
 */
export default function MarketStrip({ ohlc, prevClose, spot, synthFut, expiry, onFind, onImport }) {
  const open = ohlc?.[0] ?? null;
  const gapPts = open != null && prevClose != null ? open - prevClose : null;
  const gapPct = gapPts != null && prevClose ? (gapPts / prevClose) * 100 : null;
  const movePts = spot != null && open != null ? spot - open : null;
  const movePct = movePts != null && open ? (movePts / open) * 100 : null;
  const expShort = expiry
    ? new Date(expiry + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toUpperCase()
    : null;

  return (
    <div className="mktstrip">
      <div className="flex items-baseline gap-x-5 gap-y-1.5 flex-wrap min-w-0">
        <Quote label="Day Open" value={fm(open, 1)} pts={gapPts} pct={gapPct} />
        <Quote label="Spot" value={fm(spot, 1)} pts={movePts} pct={movePct} />
        <Quote label="Synth Fut" value={synthFut != null ? fm(synthFut, 1) : "—"}
          note={expShort ? `(${expShort})` : null} />
        {ohlc && (
          <span className="n text-[11px] text-muted whitespace-nowrap hidden xl:inline">
            H {fi(ohlc[1])} · L {fi(ohlc[2])}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button className="stripbtn" onClick={onFind}>
          <MagnifyingGlass size={12} weight="bold" />Strategy Finder
        </button>
        <button className="stripbtn" onClick={onImport}>
          <DownloadSimple size={12} weight="bold" />Import Strategy
        </button>
      </div>
    </div>
  );
}
