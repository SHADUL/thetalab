/**
 * Definition 9.4 — exit sequencing, simulated. ALL short-entered legs close
 * first, each gated to COMPLETE within θ27; ONLY after every short is
 * confirmed closed are long-entered legs sold, without gating. If a short
 * fails to close, protective longs are left OPEN on purpose — a covered
 * residual is safe, a naked short is not (spec's own words).
 */
import { simulateFill, type MarketSnapshot, type FillOutcome } from '../execution/shadowFillModel.ts';
import { marketableLimitPrice } from '../execution/marketableLimit.ts';
import { THETA } from '../parameters.ts';

export interface ExitLegSpec {
  legIndex: number;
  /** The side the leg was ENTERED with (BUY or SELL) — exit closes the opposite side. */
  entrySide: 'BUY' | 'SELL';
  quantity: number;
  tick: number;
  referencePrice: number;
  snapshots: MarketSnapshot[];
}

export interface ExitLegResult {
  legIndex: number;
  closingSide: 'BUY' | 'SELL';
  limit: number;
  outcome: FillOutcome;
}

export interface ShortFirstExitResult {
  shortResults: ExitLegResult[];
  longResults: ExitLegResult[];
  /** true iff EVERY short leg reached COMPLETE within θ27 — gates whether longs are released at all. */
  allShortsClosed: boolean;
  /** Long legs deliberately left OPEN because a short failed to close. */
  heldOpenLegIndices: number[];
}

export function simulateShortFirstExit(legs: ExitLegSpec[]): ShortFirstExitResult {
  const shorts = legs.filter((l) => l.entrySide === 'SELL');
  const longs = legs.filter((l) => l.entrySide === 'BUY');
  const shortGateMs = THETA.EXIT_SHORT_CLOSE_GATE_SEC * 1000;

  const shortResults: ExitLegResult[] = shorts.map((leg) => {
    const closingSide: 'BUY' | 'SELL' = 'BUY'; // buy-to-close a short
    const limit = marketableLimitPrice(closingSide, leg.referencePrice, leg.tick);
    const outcome = simulateFill(closingSide, limit, leg.referencePrice, leg.snapshots, shortGateMs);
    return { legIndex: leg.legIndex, closingSide, limit, outcome };
  });

  const allShortsClosed = shortResults.every((r) => r.outcome.filled);

  if (!allShortsClosed) {
    return {
      shortResults,
      longResults: [],
      allShortsClosed: false,
      heldOpenLegIndices: longs.map((l) => l.legIndex),
    };
  }

  const longResults: ExitLegResult[] = longs.map((leg) => {
    const closingSide: 'BUY' | 'SELL' = 'SELL'; // sell-to-close a long
    const limit = marketableLimitPrice(closingSide, leg.referencePrice, leg.tick);
    // Longs are not gated (spec: "without gating") — a generous timeout stands in for "not time-boxed the same way."
    const outcome = simulateFill(closingSide, limit, leg.referencePrice, leg.snapshots, shortGateMs * 10);
    return { legIndex: leg.legIndex, closingSide, limit, outcome };
  });

  return { shortResults, longResults, allShortsClosed: true, heldOpenLegIndices: [] };
}
