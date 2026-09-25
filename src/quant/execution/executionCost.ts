/**
 * Canonical SHADOW execution-cost / net-P&L definitions (forward-
 * validation readiness phase, Tasks 2/3). Exactly ONE formula, used by the
 * ledger outcome and the position record alike — never re-derived ad hoc
 * per call site, which is what made the entryExecutionCost=0 hard-code
 * and the (now-fixed, see shadowScan.ts) costToClose sign bug possible to
 * miss for as long as they were.
 *
 * Definitions:
 *   grossPnl = the structure's economic payoff at MID-to-MID prices — what
 *     you'd have made with ZERO execution slippage. Computed by the caller
 *     as (entry theoretical maxProfit) - (mid-based costToCloseAtMid, see
 *     shadowScan.ts's simulateShadowExitFills) — passed in already
 *     assembled, since only the caller has both numbers.
 *   entryExecutionCost / exitExecutionCost = SLIPPAGE cost only — the
 *     difference between the simulated fill and the mid/decision price at
 *     each leg, summed and always reported as a non-negative cost (never
 *     a rebate). NEVER includes statutory charges.
 *   transactionChargesEstimate = brokerage/STT/exchange/SEBI/stamp-duty/
 *     GST, via the SAME cost model backtests already use
 *     (costs.ts's computeTradeCostBreakdown/ratesEffectiveOn) — a pure,
 *     deterministic function of trade date + turnover, so it never
 *     depends on live telemetry and is never null once turnover is known.
 *   totalExecutionCost = entryExecutionCost + exitExecutionCost, exactly
 *     (Task 2's own spec) — transaction charges are deliberately kept OUT
 *     of this sum so "execution cost" always means slippage alone, never
 *     silently merged with a different concept.
 *   netPnl = grossPnl - entryExecutionCost - exitExecutionCost
 *     - transactionChargesEstimate
 *
 * No double counting: entryExecutionCost is looked up from the phase=
 * 'ENTRY' telemetry batch for this forward_ledger_id, written exactly
 * once at signal time (shadowRepository.ts's own comment explains why a
 * second entry batch for the same ledger row is structurally
 * impossible). exitExecutionCost is computed directly from THIS exit's
 * own simulated fills, never re-queried, so there is no batch to
 * duplicate either.
 */
import { ratesEffectiveOn, type CostRates } from '../../options-auto/backtest/costs.ts';

export const EXECUTION_COST_MODEL_VERSION = 'EXEC_COST_V1';

export interface EntryExecutionCostLookup {
  value: number | null; // null = "not available" — never fabricated as 0
  rowCount: number;
}

export interface ExecutionCostBreakdown {
  entryExecutionCost: number | null;
  entryExecutionCostBasis: 'REAL_TELEMETRY' | 'UNAVAILABLE';
  exitExecutionCost: number;
  transactionChargesEstimate: number;
  /** null exactly when entryExecutionCost is null — Task 2's "do not silently merge unlike concepts" applied to the sum itself: if one addend is unknown, the sum must say so too, not silently treat unknown as 0. */
  totalExecutionCost: number | null;
}

export function computeExecutionCostBreakdown(input: {
  entryExecutionCostLookup: EntryExecutionCostLookup;
  exitExecutionCost: number;
  transactionChargesEstimate: number;
}): ExecutionCostBreakdown {
  const entryExecutionCost = input.entryExecutionCostLookup.value;
  const entryExecutionCostBasis = entryExecutionCost !== null ? ('REAL_TELEMETRY' as const) : ('UNAVAILABLE' as const);
  const totalExecutionCost = entryExecutionCost !== null ? entryExecutionCost + input.exitExecutionCost : null;
  return {
    entryExecutionCost, entryExecutionCostBasis,
    exitExecutionCost: input.exitExecutionCost,
    transactionChargesEstimate: input.transactionChargesEstimate,
    totalExecutionCost,
  };
}

export interface CanonicalForwardPnl {
  grossPnl: number;
  netPnl: number;
  entryExecutionCost: number;
  exitExecutionCost: number;
  totalExecutionCost: number;
  transactionChargesEstimate: number;
  costBasis: { entry: 'REAL_TELEMETRY' | 'UNAVAILABLE'; transactionCharges: 'MODELED' };
}

/**
 * The ONE net-P&L rollup every SHADOW outcome must go through. When
 * entryExecutionCost is unavailable (REAL_TELEMETRY lookup came back
 * null), it is treated as 0 for the arithmetic ONLY — costBasis.entry
 * stays 'UNAVAILABLE' so the caller can (and must) surface that in
 * dataQuality/valid_for_forward_validation, exactly like this codebase's
 * existing MAE_MFE_UNAVAILABLE convention. Never silently reported as an
 * exact netPnl without that flag attached.
 */
export function computeCanonicalForwardPnl(grossPnl: number, costs: ExecutionCostBreakdown): CanonicalForwardPnl {
  const entryExecutionCost = costs.entryExecutionCost ?? 0;
  const totalExecutionCost = entryExecutionCost + costs.exitExecutionCost;
  const netPnl = grossPnl - entryExecutionCost - costs.exitExecutionCost - costs.transactionChargesEstimate;
  return {
    grossPnl, netPnl, entryExecutionCost, exitExecutionCost: costs.exitExecutionCost,
    totalExecutionCost, transactionChargesEstimate: costs.transactionChargesEstimate,
    costBasis: { entry: costs.entryExecutionCostBasis, transactionCharges: 'MODELED' },
  };
}

/**
 * transactionChargesEstimate via the exact same statutory-rate model the
 * backtest engine uses (costs.ts) — a deterministic function of trade
 * date and each leg's entry/exit turnover, never a live-telemetry
 * dependency. `entrySlippage`/`exitSlippage`/`leggingCost` are passed as 0
 * here on purpose: this function's ONLY job is the statutory-charge
 * component; slippage is tracked separately as entryExecutionCost/
 * exitExecutionCost so the two concepts are never summed twice.
 */
export function estimateTransactionCharges(params: {
  legs: Array<{ side: 'BUY' | 'SELL'; entryTurnover: number; exitTurnover: number }>;
  tradeDate: string;
}): { estimate: number; rates: Pick<CostRates, 'effectiveFrom' | 'source'> } {
  const rates = ratesEffectiveOn(params.tradeDate);
  let brokerage = 0, stt = 0, exchangeCharges = 0, sebiCharges = 0, gst = 0, stampDuty = 0;
  for (const leg of params.legs) {
    const exitSide = leg.side === 'BUY' ? 'SELL' : 'BUY';
    for (const [side, turnover] of [[leg.side, leg.entryTurnover], [exitSide, leg.exitTurnover]] as const) {
      const exchangeTxn = turnover * rates.exchangeTxnPct;
      brokerage += rates.brokeragePerOrder;
      exchangeCharges += exchangeTxn;
      sebiCharges += turnover * rates.sebiPct;
      stt += side === 'SELL' ? turnover * rates.optionsSttSellPct : 0;
      stampDuty += side === 'BUY' ? turnover * rates.stampDutyBuyPct : 0;
      gst += (rates.brokeragePerOrder + exchangeTxn) * rates.gstPct;
    }
  }
  return { estimate: brokerage + stt + exchangeCharges + sebiCharges + gst + stampDuty, rates: { effectiveFrom: rates.effectiveFrom, source: rates.source } };
}
