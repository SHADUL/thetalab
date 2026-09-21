/**
 * Multiple independent exit triggers for an OPEN defined-risk structure
 * (Phase 14-16) — the gap this codebase had until now: a position could
 * open but nothing ever managed or closed it. Checked in a fixed priority
 * order, safety first, matching api/intraday.js's own managePositions()
 * exit-priority convention (EOD > target > stop > momentum failure):
 *
 *   1. SHORT_STRIKE_BREACHED — the underlying has reached a short strike.
 *      Real, immediate danger; checked before anything else.
 *   2. STOP_LOSS_MAX_LOSS — closing now would realize a loss at or beyond
 *      the structure's own defined max loss (the final numeric backstop,
 *      independent of the strike-breach check above).
 *   3. STOP_LOSS_CREDIT_MULTIPLE — cost to close has grown to some
 *      multiple of the credit collected (a softer, earlier stop).
 *   4. PROFIT_TARGET — most of the max credit has already been captured;
 *      don't wait for the last few rupees of theta.
 *   5. TIME_EXIT — inside the same near-expiry gamma-risk window
 *      expirySelector.ts already refuses NEW entries in (minDte).
 *
 * All four thresholds are configurable, provisional defaults — same
 * posture as every other threshold in this engine (regimeSelect.ts's skew
 * band, tradeQualityScore.ts's weights): stated plainly so they can be
 * argued with and tuned once a backtest exists for this module.
 */

export type ExitReason =
  | 'SHORT_STRIKE_BREACHED'
  | 'STOP_LOSS_MAX_LOSS'
  | 'STOP_LOSS_CREDIT_MULTIPLE'
  | 'PROFIT_TARGET'
  | 'TIME_EXIT'
  | null;

export interface ExitDecision {
  action: 'HOLD' | 'CLOSE';
  reason: ExitReason;
  detail: string;
  /** (maxProfit - currentCostToClose) / maxProfit * 100. Null when maxProfit isn't positive. */
  profitCapturedPct: number | null;
}

export interface ShortStrike {
  strike: number;
  right: 'CE' | 'PE';
}

export interface ExitEvaluationInput {
  /** Total credit collected at entry — for a fully-filled defined-risk structure this equals maxProfit. Already scaled for the actual lots held. */
  maxProfit: number;
  /** Total defined max loss, already scaled for the actual lots held. */
  maxLoss: number;
  /** Live total rupee cost to close the position right now (buy back shorts, sell longs), already scaled for the actual lots held. */
  currentCostToClose: number;
  dte: number;
  underlyingPrice: number;
  shortStrikes: ShortStrike[];
  profitTargetPct?: number;
  stopLossCreditMultiple?: number;
  timeExitDte?: number;
  /** How far past a short strike (percent of strike) before flagging a breach. 0 = exactly at/through it. */
  strikeBreachBufferPct?: number;
}

export const DEFAULT_EXIT_PARAMS = {
  profitTargetPct: 50,
  stopLossCreditMultiple: 2,
  timeExitDte: 2,
  strikeBreachBufferPct: 0,
};

export function evaluateExit(input: ExitEvaluationInput): ExitDecision {
  const profitTargetPct = input.profitTargetPct ?? DEFAULT_EXIT_PARAMS.profitTargetPct;
  const stopLossCreditMultiple = input.stopLossCreditMultiple ?? DEFAULT_EXIT_PARAMS.stopLossCreditMultiple;
  const timeExitDte = input.timeExitDte ?? DEFAULT_EXIT_PARAMS.timeExitDte;
  const strikeBreachBufferPct = input.strikeBreachBufferPct ?? DEFAULT_EXIT_PARAMS.strikeBreachBufferPct;

  const profitCapturedPct = input.maxProfit > 0
    ? ((input.maxProfit - input.currentCostToClose) / input.maxProfit) * 100
    : null;

  const breached = input.shortStrikes.find((s) => {
    const buffer = s.strike * (strikeBreachBufferPct / 100);
    return s.right === 'CE' ? input.underlyingPrice >= s.strike - buffer : input.underlyingPrice <= s.strike + buffer;
  });
  if (breached) {
    return {
      action: 'CLOSE', reason: 'SHORT_STRIKE_BREACHED',
      detail: `Underlying ${input.underlyingPrice} has reached the short ${breached.right} strike ${breached.strike}.`,
      profitCapturedPct,
    };
  }

  if (input.currentCostToClose - input.maxProfit >= input.maxLoss) {
    return {
      action: 'CLOSE', reason: 'STOP_LOSS_MAX_LOSS',
      detail: `Closing now would realize a loss of ₹${(input.currentCostToClose - input.maxProfit).toFixed(0)}, at or beyond the defined max loss of ₹${input.maxLoss.toFixed(0)}.`,
      profitCapturedPct,
    };
  }

  if (input.maxProfit > 0 && input.currentCostToClose >= input.maxProfit * stopLossCreditMultiple) {
    return {
      action: 'CLOSE', reason: 'STOP_LOSS_CREDIT_MULTIPLE',
      detail: `Cost to close (₹${input.currentCostToClose.toFixed(0)}) is ${(input.currentCostToClose / input.maxProfit).toFixed(1)}x the credit collected (stop at ${stopLossCreditMultiple}x).`,
      profitCapturedPct,
    };
  }

  if (profitCapturedPct !== null && profitCapturedPct >= profitTargetPct) {
    return {
      action: 'CLOSE', reason: 'PROFIT_TARGET',
      detail: `${profitCapturedPct.toFixed(0)}% of max credit captured (target ${profitTargetPct}%).`,
      profitCapturedPct,
    };
  }

  if (input.dte <= timeExitDte) {
    return {
      action: 'CLOSE', reason: 'TIME_EXIT',
      detail: `${input.dte} DTE remaining — inside the forced time-exit window (${timeExitDte}).`,
      profitCapturedPct,
    };
  }

  return { action: 'HOLD', reason: null, detail: 'No exit condition met.', profitCapturedPct };
}
