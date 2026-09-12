/**
 * Setup Types (spec §23) — a stock can carry more than one, so this is a
 * list, not a single tag. Order in the list has no meaning; the caller
 * (ranking engine) decides what to feature.
 */
export type SetupType =
  | 'BREAKOUT' | 'EARLY_BREAKOUT' | 'ATH_BREAKOUT'
  | 'PULLBACK' | 'TREND_CONTINUATION'
  | 'VOLUME_ACCUMULATION' | 'EXTENDED' | 'FAILED_BREAKOUT_RISK';

/** Entry Status (spec §27) — rule-based, not a subjective label. */
export type EntryStatus =
  | 'BUY_ZONE' | 'NEAR_ENTRY' | 'WAIT_FOR_BREAKOUT'
  | 'BREAKOUT_CONFIRMED' | 'EXTENDED' | 'AVOID';

export type ExtensionRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export type GapType = 'NONE' | 'GAP_UP' | 'GAP_DOWN';

export interface BreakoutSignal {
  lookback: 20 | 50 | 100 | 252;
  /** The prior lookback-period high this would need to clear — null before
   *  there's enough history to have one. */
  level: number | null;
  brokeOut: boolean;
}

export interface ConsolidationSignal {
  inConsolidation: boolean;
  /** Short-window ATR% over the long-window ATR% — well under 1 means the
   *  range has genuinely tightened, not just gone quiet for a day. */
  contractionRatio: number | null;
  rangePct: number | null;
}

export interface PullbackSignal {
  toEma20: boolean;
  toEma50: boolean;
  /** Price sitting back near a level it broke out above recently, with the
   *  old resistance now acting as support rather than being violated. */
  breakoutRetest: boolean;
}

export interface GapSignal {
  type: GapType;
  gapPct: number | null;
}

export interface PatternResult {
  breakouts: BreakoutSignal[];
  breakoutQuality: number | null; // 0-100, meaningful only when a breakout fired today
  volumeConfirmed: boolean;
  closingStrength: number | null; // 0 (closed at the low) .. 1 (closed at the high)
  consolidation: ConsolidationSignal;
  pullback: PullbackSignal;
  gap: GapSignal;
  extensionRisk: ExtensionRisk;
  entryStatus: EntryStatus;
  setupTypes: SetupType[];
}
