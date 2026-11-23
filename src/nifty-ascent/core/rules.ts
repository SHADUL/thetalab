/**
 * NIFTY ASCENT — research rules v1 (Gap-and-Go → Williams) and execution settings.
 *
 * RESEARCH_RULES_V1 is the source of truth supplied as OptionsBuyer.in research
 * data plus the owner's clarification decisions of 23 Nov 2026 (Q1–Q15, see
 * NIFTY_ASCENT.md). It is frozen: changing a research threshold means a new
 * strategy version, never an edit here.
 *
 * Time convention (Q2): Kite start-labelled 1-minute bars. A bar's label is
 * minutes after IST midnight; label 555 = 09:15 covers ticks whose exchange
 * time is in [09:15:00.000, 09:16:00.000) and is confirmed only after 09:16:00.
 */

export const STRATEGY_ID = 'NIFTY_ASCENT_V1';
export const STRATEGY_NAME = 'Gap-and-Go → Williams';

export interface ResearchRules {
  readonly version: string;
  /** First and last opening-range bars (inclusive): 09:15 … 09:45 = 31 bars. */
  readonly orFirstBar: number;
  readonly orLastBar: number;
  readonly orBarCount: number;
  /** Gap-and-Go band = OR edge ± bandFraction × OR width. */
  readonly bandFraction: number;
  /** Gap-and-Go signal window, inclusive bar labels: 09:46 … 12:00. */
  readonly gapGoFirstBar: number;
  readonly gapGoLastBar: number;
  /** Williams allowed when gap% < lowGapPct OR gap% ≥ highGapPct. */
  readonly williamsLowGapPct: number;
  readonly williamsHighGapPct: number;
  /** Williams level = today_open ± williamsFraction × previous-day close range. */
  readonly williamsFraction: number;
  /** Last Williams bar (inclusive): 14:29. */
  readonly williamsLastBar: number;
  /** Previous day's reference bar: the close of the bar labelled 15:15. */
  readonly prevCloseBar: number;
  /** Option depth in the money, in index points. */
  readonly itmPoints: number;
  /** Fixed stop: premium close ≤ entry × fixedStopFactor. */
  readonly fixedStopFactor: number;
  /** Trail activates on a premium close strictly > entry × trailActivationFactor. */
  readonly trailActivationFactor: number;
  /** Trailing stop: premium close ≤ highest close × trailStopFactor. */
  readonly trailStopFactor: number;
  /** Mandatory time exit is initiated at this IST minute (15:15:00). */
  readonly timeExitMinute: number;
  /** Positions per trading day, across both bots. */
  readonly maxPositionsPerDay: number;
  /** Q9: on expiry day use the next listed expiry (provisional research convention). */
  readonly expiryDayUsesNextExpiry: boolean;
  /**
   * Filter on top of V1 (absent from RESEARCH_RULES_V1; set in LIVE_PAPER_RULES
   * and backtest variants). Skip the whole day (both bots) when the 09:15–09:45 opening
   * range is narrower than this many index points.
   */
  readonly minOrWidth?: number;
  /**
   * Filter on top of V1 (as above) — when the nearest listed expiry is this many
   * calendar days away or fewer (but not today), trade the next listed expiry.
   */
  readonly rollExpiryWithinDays?: number;
}

export const RESEARCH_RULES_V1: ResearchRules = Object.freeze({
  version: 'NIFTY_ASCENT_V1.0',
  orFirstBar: 9 * 60 + 15,
  orLastBar: 9 * 60 + 45,
  orBarCount: 31,
  bandFraction: 0.10,
  gapGoFirstBar: 9 * 60 + 46,
  gapGoLastBar: 12 * 60,
  williamsLowGapPct: 0.2,
  williamsHighGapPct: 0.5,
  williamsFraction: 0.5,
  williamsLastBar: 14 * 60 + 29,
  prevCloseBar: 15 * 60 + 15,
  itmPoints: 150,
  fixedStopFactor: 0.70,
  trailActivationFactor: 1.05,
  trailStopFactor: 0.80,
  timeExitMinute: 15 * 60 + 15,
  maxPositionsPerDay: 1,
  expiryDayUsesNextExpiry: true,
});

/** Rule variant on top of V1 (backtest variants and LIVE_PAPER_RULES). */
export interface RuleVariant { minOrWidth: number; rollExpiryWithinDays: number }
export const NO_VARIANT: RuleVariant = Object.freeze({ minOrWidth: 0, rollExpiryWithinDays: 0 });

/** V1 plus the variant; returns V1 itself when nothing is switched on. */
export function variantRules(v: RuleVariant): ResearchRules {
  const or = v.minOrWidth > 0 ? v.minOrWidth : 0, roll = v.rollExpiryWithinDays > 0 ? v.rollExpiryWithinDays : 0;
  if (!or && !roll) return RESEARCH_RULES_V1;
  const tag = [or ? `OR${or}` : '', roll ? `ROLL${roll}` : ''].filter(Boolean).join('+');
  return Object.freeze({ ...RESEARCH_RULES_V1, version: `${RESEARCH_RULES_V1.version}+${tag}`, ...(or ? { minOrWidth: or } : {}), ...(roll ? { rollExpiryWithinDays: roll } : {}) });
}

/**
 * Live paper research rules (owner decision 23 Nov 2026): V1 plus a 60-point
 * minimum opening-range width and the 1-day-to-expiry roll. V1 itself is unchanged.
 */
export const LIVE_PAPER_VARIANT: RuleVariant = Object.freeze({ minOrWidth: 60, rollExpiryWithinDays: 1 });
export const LIVE_PAPER_RULES: ResearchRules = variantRules(LIVE_PAPER_VARIANT);

/** Adjustable execution / risk settings (Q13 defaults). Not research rules. */
export interface ExecutionSettings {
  version: string;
  paperCapital: number;
  lots: number;
  /** Premium × quantity + estimated entry fees must not exceed this. */
  maxPremiumOutlay: number;
  /** Full premium + round-trip fees (an option can expire worthless). */
  maxTheoreticalLoss: number;
  dailyLossCutoff: number;
  /** Quote freshness: now − exchange time. */
  maxQuoteAgeMs: number;
  /** Bid/ask spread as % of midpoint (entry liquidity gate). */
  maxSpreadPct: number;
  /** Minimum contracts traded today (entry liquidity gate). */
  minDailyVolume: number;
  /** Simulated slippage fraction applied against us on every fill. */
  slippage: number;
  /** A bar is confirmed this long after its minute ends (network grace). */
  barGraceMs: number;
  /** An index tick older than this on receipt is rejected as stale. */
  maxIndexLagMs: number;
  /** Previous-day minute bars required (of 375) for the Williams range. */
  minPrevDayBars: number;
}

export const DEFAULT_EXECUTION: ExecutionSettings = {
  version: 'EXEC-1',
  paperCapital: 200_000,
  lots: 1,
  maxPremiumOutlay: 15_000,
  maxTheoreticalLoss: 15_000,
  dailyLossCutoff: 15_000,
  maxQuoteAgeMs: 2_000,
  maxSpreadPct: 1.5,
  minDailyVolume: 500,
  slippage: 0.0025,
  barGraceMs: 1_500,
  maxIndexLagMs: 5_000,
  minPrevDayBars: 370,
};

/**
 * LIVE PAPER execution settings. Owner decision 23 Nov 2026: premium outlay and
 * theoretical loss raised to ₹20,000 (one lot of a 150-pt ITM weekly costs ~₹16.5–18.5k
 * at lot 65). Everything else — including the ₹15,000 daily loss cutoff — is unchanged.
 * Simulation and backtest keep DEFAULT_EXECUTION unless changed in Risk & Settings.
 */
export const LIVE_PAPER_EXECUTION: ExecutionSettings = {
  ...DEFAULT_EXECUTION,
  version: 'EXEC-2',
  maxPremiumOutlay: 20_000,
  maxTheoreticalLoss: 20_000,
};

/* ------------------------------------------------------------------ */
/* Time helpers (all IST)                                               */
/* ------------------------------------------------------------------ */

export const MIN_MS = 60_000;
const IST_OFFSET_MS = 330 * MIN_MS;

/** Epoch ms of IST midnight for a YYYY-MM-DD session date. */
export function istMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00+05:30`);
}
/** Epoch ms at which bar `label` starts. */
export function barStart(date: string, label: number): number {
  return istMidnight(date) + label * MIN_MS;
}
/** Bar label (IST minute) containing epoch ms `t` on `date`. */
export function barLabelOf(date: string, t: number): number {
  return Math.floor((t - istMidnight(date)) / MIN_MS);
}
export function hhmm(label: number): string {
  return `${String(Math.floor(label / 60)).padStart(2, '0')}:${String(label % 60).padStart(2, '0')}`;
}
export function istDateOf(t: number): string {
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}
/** First session bar 09:15 and last 15:29. */
export const SESSION_FIRST_BAR = 9 * 60 + 15;
export const SESSION_LAST_BAR = 15 * 60 + 29;
