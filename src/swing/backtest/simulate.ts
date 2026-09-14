import type { Bar } from '../indicators/types.ts';
import type { SimulatedTrade, ExitReason } from './types.ts';

/**
 * Walks forward from entryIdx+1 in `bars` (already split-adjusted) to see
 * whether stop or target got hit first, or neither within maxHoldingDays.
 * This is the ONE place in the backtest allowed to look at "the future"
 * relative to entryIdx — signal generation (detectPatterns et al.) must
 * never see bars past its own asOfIdx, but simulation's entire job is
 * checking what actually happened afterward.
 *
 * When a single day's range crosses both stop and target (a big-range
 * day), STOP is assumed hit first — daily OHLC alone can't say which
 * happened first intraday, and assuming the worse outcome understates win
 * rate on those days rather than flattering it.
 *
 * A gap through either level fills at the day's open, not at the level
 * itself — a stock that opens below its stop was never fillable at the
 * stop price.
 */
export function simulateTrade(
  bars: Bar[], entryIdx: number, stop: number, target: number, maxHoldingDays: number,
): SimulatedTrade | null {
  const entryBar = bars[entryIdx];
  if (!entryBar) return null;
  const entryPrice = entryBar.c;

  const windowEndIdx = entryIdx + maxHoldingDays;
  const lastAvailableIdx = Math.min(bars.length - 1, windowEndIdx);

  const build = (exitIdx: number, exitPrice: number, exitReason: ExitReason): SimulatedTrade => ({
    entryIdx, entryDate: entryBar.t, entryPrice, stop, target,
    exitIdx, exitDate: bars[exitIdx].t, exitPrice, exitReason,
    holdingDays: exitIdx - entryIdx,
    returnPct: ((exitPrice - entryPrice) / entryPrice) * 100,
  });

  for (let i = entryIdx + 1; i <= lastAvailableIdx; i++) {
    const bar = bars[i];
    if (bar.l <= stop) {
      return build(i, bar.o < stop ? bar.o : stop, 'STOP');
    }
    if (bar.h >= target) {
      return build(i, bar.o > target ? bar.o : target, 'TARGET');
    }
  }

  // Neither hit. Distinguish "genuinely timed out with the window still
  // inside available data" from "ran out of history before we could know" —
  // the latter isn't a real outcome and must not be counted as one.
  const ranOutOfData = lastAvailableIdx < windowEndIdx;
  return build(lastAvailableIdx, bars[lastAvailableIdx].c, ranOutOfData ? 'DATA_END' : 'TIMEOUT');
}
