import type { IntradayBar, Direction, SetupType } from '../types.ts';
import type { ExitReason } from './types.ts';

export interface SimulatedExit {
  exitIdx: number;
  exitPrice: number;
  exitReason: ExitReason;
}

const MOMENTUM_FAILURE_SETUPS: ReadonlySet<SetupType> = new Set(['VWAP_PULLBACK', 'EMA_TREND_CONTINUATION']);

/**
 * Walks forward from entryIdx+1 through the rest of the trading day,
 * applying the EXACT exit priority api/intraday.js's managePositions
 * uses live — EOD square-off > target2 (full exit) > stop (STOP, or
 * TRAIL once the stop has already been walked to breakeven) > momentum
 * failure (VWAP/EMA-based setups only, checked on the bar's close, the
 * closest analogue to a live quote snapshot within a bar — unlike
 * stop/target2, this was never checked against intrabar wicks live
 * either). target1-reached-so-trail-to-breakeven is recomputed fresh
 * every bar (via that bar's close), matching live's per-tick check
 * exactly, while the stop itself is a genuinely sticky mutation once
 * moved — both intentional, not simplifications.
 *
 * When a single bar's range crosses both stop and target2, STOP is
 * resolved first — 5-min OHLC can't say which happened first
 * intrabar, and assuming the worse outcome understates win rate rather
 * than flattering it (same convention the swing backtest's own
 * simulateTrade uses). A gap through a level fills at the bar's open,
 * not the level itself.
 */
export function simulateIntradayExit(
  bars: IntradayBar[],
  entryIdx: number,
  direction: Direction,
  setupType: SetupType,
  entryPrice: number,
  initialStop: number,
  target1: number,
  target2: number,
  vwapSeries: number[],
  squareOffBarIdx: number,
): SimulatedExit {
  let stop = initialStop;
  const finalIdx = Math.min(bars.length - 1, squareOffBarIdx);

  for (let i = entryIdx + 1; i <= finalIdx; i++) {
    const bar = bars[i];
    const target2Hit = direction === 'LONG' ? bar.h >= target2 : bar.l <= target2;
    const stopHit = direction === 'LONG' ? bar.l <= stop : bar.h >= stop;

    if (stopHit) {
      const atBreakeven = Math.abs(stop - entryPrice) < 1e-6 * Math.max(1, entryPrice);
      const exitPrice = direction === 'LONG'
        ? (bar.o < stop ? bar.o : stop)
        : (bar.o > stop ? bar.o : stop);
      return { exitIdx: i, exitPrice, exitReason: atBreakeven ? 'TRAIL' : 'STOP' };
    }
    if (target2Hit) {
      const exitPrice = direction === 'LONG'
        ? (bar.o > target2 ? bar.o : target2)
        : (bar.o < target2 ? bar.o : target2);
      return { exitIdx: i, exitPrice, exitReason: 'TARGET2' };
    }

    const target1HitNow = direction === 'LONG' ? bar.c >= target1 : bar.c <= target1;
    if (!target1HitNow && MOMENTUM_FAILURE_SETUPS.has(setupType)) {
      const vwap = vwapSeries[i];
      if (vwap) {
        const wrongSide = direction === 'LONG' ? bar.c < vwap * 0.9995 : bar.c > vwap * 1.0005;
        if (wrongSide) return { exitIdx: i, exitPrice: bar.c, exitReason: 'MOMENTUM_FAILURE' };
      }
    }
    if (target1HitNow) {
      const worseThanBreakeven = direction === 'LONG' ? stop < entryPrice : stop > entryPrice;
      if (worseThanBreakeven) stop = entryPrice;
    }
  }

  const eodBar = bars[finalIdx];
  return { exitIdx: finalIdx, exitPrice: eodBar.c, exitReason: 'EOD_SQUAREOFF' };
}
