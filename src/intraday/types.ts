/**
 * Intraday Trader — a completely separate module from the Swing Scanner
 * (own data model, own UI section), per the user's own spec. Market
 * Regime -> Ranking -> Setup -> Signal -> Risk -> Execution (paper) ->
 * Position Management/Exit -> Kill Switch -> Settings -> Backtest are
 * all implemented; PAPER is still the only execution mode. Deferred:
 * ALERT/SEMI_AUTO/AUTO execution, and dashboard UI polish (top-5 cards,
 * alert-state timeline, per-stock chart view).
 */
export interface IntradayBar {
  t: number; // epoch ms
  o: number; h: number; l: number; c: number; v: number;
}

export type Regime = 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';

export type VwapRelationship = 'ABOVE_RISING' | 'ABOVE_FALLING' | 'BELOW_RISING' | 'BELOW_FALLING' | 'AT_VWAP';

export type RvolClass = 'WEAK' | 'NORMAL' | 'POSITIVE' | 'STRONG' | 'EXCEPTIONAL' | 'UNKNOWN';

export type SetupType = 'ORB' | 'VWAP_PULLBACK' | 'EMA_TREND_CONTINUATION' | 'BREAKOUT' | 'BREAKOUT_RETEST' | 'LIQUIDITY_GRAB';

export type Direction = 'LONG' | 'SHORT';

export interface OpeningRange {
  high: number;
  low: number;
  width: number;
}

export interface SetupSignal {
  type: SetupType;
  direction: Direction;
  fired: boolean;
  quality: number; // 0-100, how well-formed the setup is
  detail: string; // one-line human-readable reason
}

export interface IntradayFactorScores {
  relativeStrength: number;
  momentum: number;
  volume: number;
  setup: number;
  vwapPosition: number;
  regimeAlignment: number;
  sectorStrength: number;
  liquidity: number;
}

export interface EntryChecklist {
  regimeSupportive: boolean;
  sectorSupportive: boolean;
  relativeStrengthStrong: boolean;
  liquid: boolean;
  vwapAligned: boolean;
  trendAligned: boolean;
  validSetup: boolean;
  rvolConfirms: boolean;
  triggerOccurred: boolean;
  stopLogical: boolean;
  rrAcceptable: boolean;
  notExtended: boolean;
}

export interface TradePlan {
  direction: Direction;
  entry: number;
  stop: number;
  target1: number; // 1R
  target2: number; // 2R
  riskPerShare: number;
  riskReward: number | null;
}
