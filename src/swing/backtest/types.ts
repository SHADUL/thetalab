/**
 * Backtest Engine (spec §31-34) — validates whether the Swing Score is
 * actually predictive, using the same point-in-time signal generation the
 * live scanner uses (detectPatterns/computeTradePlan/scoreSymbol), then
 * simulating forward through real historical OHLCV to see what actually
 * happened to each signal.
 */
export type ExitReason = 'TARGET' | 'STOP' | 'TIMEOUT' | 'DATA_END';

export interface SimulatedTrade {
  entryIdx: number;
  entryDate: string;
  entryPrice: number;
  stop: number;
  target: number;
  exitIdx: number;
  exitDate: string;
  exitPrice: number;
  exitReason: ExitReason;
  holdingDays: number;
  returnPct: number;
}

export type Regime = 'BULLISH' | 'NEUTRAL' | 'BEARISH';

/** One simulated trade plus the signal context that produced it — what
 *  the score-bucket/regime/setup-type breakdowns group by. */
export interface ScoredTrade extends SimulatedTrade {
  symbol: string;
  preset: string;
  score: number;
  setupType: string;
  entryStatus: string;
  regime: Regime | null;
}

export interface TradeMetrics {
  count: number;
  targetHitRate: number | null;
  positiveReturnRate: number | null;
  profitFactor: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  avgHoldingDays: number | null;
}
