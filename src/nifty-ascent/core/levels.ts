/**
 * Pure level calculations for NIFTY ASCENT. Comparisons that decide a
 * boundary (gap-size eligibility, strike ties) are done in integer paise so
 * 0.2000% is exactly 0.2000% — never 0.20000000000000004%.
 */
import type { ResearchRules } from './rules.ts';

export type GapDirection = 'UP' | 'DOWN' | 'NONE';
export type Right = 'CE' | 'PE';

/** Price → integer paise (2-decimal exchange prices are exact). */
export const paise = (p: number): number => Math.round(p * 100);

export interface Gap {
  previousClose: number;
  todayOpen: number;
  points: number;
  /** For display only — decisions use the exact integer comparisons below. */
  pct: number;
  direction: GapDirection;
}

export function computeGap(previousClose: number, todayOpen: number): Gap {
  const g = paise(todayOpen) - paise(previousClose);
  return {
    previousClose, todayOpen,
    points: g / 100,
    pct: Math.abs(g / paise(previousClose)) * 100,
    direction: g > 0 ? 'UP' : g < 0 ? 'DOWN' : 'NONE',
  };
}

/** |gap| / prev × 100 < thresholdPct, exactly. thresholdPct has ≤ 4 decimals. */
function gapPctBelow(gap: Gap, thresholdPct: number): boolean {
  const g = Math.abs(paise(gap.todayOpen) - paise(gap.previousClose));
  const prev = paise(gap.previousClose);
  const t = Math.round(thresholdPct * 10_000); // threshold in 1e-4 percent
  // g/prev*100 < t/1e4  ⇔  g * 1e6 < t * prev
  return g * 1_000_000 < t * prev;
}

/** Williams gap-size filter: eligible iff gap% < low OR gap% ≥ high. */
export function williamsGapEligible(gap: Gap, rules: ResearchRules): boolean {
  return gapPctBelow(gap, rules.williamsLowGapPct) || !gapPctBelow(gap, rules.williamsHighGapPct);
}

export interface OpeningRange {
  closes: Array<{ label: number; close: number }>;
  high: number;
  low: number;
  width: number;
  upsideBand: number;
  downsideBand: number;
}

/** Opening range from exactly the OR bars' CLOSES (never highs/lows). */
export function openingRange(closes: Array<{ label: number; close: number }>, rules: ResearchRules): OpeningRange {
  if (closes.length !== rules.orBarCount) throw new Error(`opening range needs ${rules.orBarCount} closes, got ${closes.length}`);
  for (const c of closes) {
    if (c.label < rules.orFirstBar || c.label > rules.orLastBar) throw new Error(`bar ${c.label} outside the opening range`);
  }
  const vals = closes.map((c) => c.close);
  const high = Math.max(...vals), low = Math.min(...vals);
  const width = high - low;
  return {
    closes, high, low, width,
    upsideBand: high + rules.bandFraction * width,
    downsideBand: low - rules.bandFraction * width,
  };
}

export interface WilliamsLevels {
  prevHighClose: number;
  prevLowClose: number;
  range: number;
  ceLevel: number;
  peLevel: number;
}

export function williamsLevels(todayOpen: number, prevCloses: number[], rules: ResearchRules): WilliamsLevels {
  const prevHighClose = Math.max(...prevCloses), prevLowClose = Math.min(...prevCloses);
  const range = prevHighClose - prevLowClose;
  return {
    prevHighClose, prevLowClose, range,
    ceLevel: todayOpen + rules.williamsFraction * range,
    peLevel: todayOpen - rules.williamsFraction * range,
  };
}

/**
 * 150-point ITM strike measured from the signal minute's NIFTY close (Q7),
 * rounded to the listed strike interval; an exact halfway tie goes to the
 * deeper-ITM strike (Q8): lower for CE, higher for PE.
 */
export function itmStrike(reference: number, right: Right, itmPoints: number, step: number): number {
  const stepP = paise(step);
  const target = right === 'CE' ? paise(reference) - paise(itmPoints) : paise(reference) + paise(itmPoints);
  const q = Math.floor(target / stepP);
  const rem = target - q * stepP;
  let k: number;
  if (rem * 2 < stepP) k = q;
  else if (rem * 2 > stepP) k = q + 1;
  else k = right === 'CE' ? q : q + 1;
  return (k * stepP) / 100;
}

/** Strike interval from the listed strikes nearest the reference (never hardcoded). */
export function strikeStep(strikes: number[], reference: number): number | null {
  const near = [...new Set(strikes)].filter((k) => Math.abs(k - reference) <= 1_000).sort((a, b) => a - b);
  let step: number | null = null;
  for (let i = 1; i < near.length; i++) {
    const d = paise(near[i]) - paise(near[i - 1]);
    if (d > 0 && (step == null || d < step)) step = d;
  }
  return step == null ? null : step / 100;
}
