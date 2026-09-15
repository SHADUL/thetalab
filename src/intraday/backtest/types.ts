/**
 * Intraday Backtest Engine — walks the EXACT live scan/execution/exit
 * logic (imported directly from api/intraday.js's exported pure
 * functions, not re-implemented here) forward through real historical
 * 5-min candles, one bar at a time, strictly point-in-time. See
 * src/intraday/scripts/runBacktest.ts for the orchestration and its
 * methodology notes (why signal-level not portfolio-level, what's
 * approximated, what costs are modeled).
 */
import type { Direction, SetupType, Regime } from '../types.ts';
import type { SignalConfidence } from '../score.ts';

export type ExitReason = 'TARGET2' | 'STOP' | 'TRAIL' | 'MOMENTUM_FAILURE' | 'EOD_SQUAREOFF';

export interface SimulatedIntradayTrade {
  symbol: string;
  sector: string | null;
  date: string; // YYYY-MM-DD
  direction: Direction;
  setupType: SetupType;
  score: number;
  confidence: SignalConfidence;
  regime: Regime;
  entryTime: number; // epoch ms
  entryPrice: number;
  stop: number;
  target1: number;
  target2: number;
  shares: number;
  exitTime: number;
  exitPrice: number;
  exitReason: ExitReason;
  riskPerShare: number;
  rMultipleGross: number;
  rMultipleNet: number;
  pnlGross: number; // rupees, at the simulated position size
  pnlNet: number;
  costs: number;
}

export interface IntradayTradeMetrics {
  count: number;
  winRateGross: number | null;
  winRateNet: number | null;
  profitFactorGross: number | null;
  profitFactorNet: number | null;
  expectancyRGross: number | null;
  expectancyRNet: number | null;
  avgWinRNet: number | null;
  avgLossRNet: number | null;
  avgCostAsPctOfRisk: number | null;
}
