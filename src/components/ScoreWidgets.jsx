import { toneClass, scoreTone, scoreLabel } from "./swingFormat.js";

// Shared score-display atoms — pulled out once a second scanning strategy
// (Structure Scan) needed the exact same 0-100 badge/bar treatment as the
// original Momentum Scan, so both strategies visually read as the same
// kind of thing even though the scores are computed completely differently
// underneath (weighted blend vs. rule-gate strength).

export function ScoreBadge({ score, size = "md" }) {
  const dim = size === "lg" ? 46 : 34;
  const tone = scoreTone(score);
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center justify-center rounded-full font-bold shrink-0"
        style={{
          width: dim, height: dim, fontSize: size === "lg" ? 15 : 12.5,
          border: `2px solid var(--c-${tone === "muted" ? "line-2" : tone})`,
          color: `var(--c-${tone === "muted" ? "text-2" : tone})`,
        }}>
        {score}
      </div>
      {size === "lg" && <span className={`text-[10.5px] font-semibold ${toneClass(tone)}`}>{scoreLabel(score)}</span>}
    </div>
  );
}

export function FactorBar({ label, value }) {
  const tone = scoreTone(value);
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className="text-muted">{label}</span>
        <span className={`font-semibold ${toneClass(tone)}`}>{value}</span>
      </div>
      <div className="h-[5px] rounded-full overflow-hidden" style={{ background: "var(--c-surface-3)" }}>
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: `var(--c-${tone === "muted" ? "text-2" : tone})` }} />
      </div>
    </div>
  );
}
