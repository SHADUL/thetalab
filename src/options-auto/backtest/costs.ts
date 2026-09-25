/**
 * Realistic NSE/BSE F&O options cost model — standard published rates,
 * not fitted to make results look better or worse (same discipline as
 * src/intraday/backtest/costs.ts). Options STT specifically has changed
 * before (0.0625% -> 0.1% of premium, sell side, effective Oct 2024) and
 * will again — verify every rate below against the current NSE/SEBI
 * circular before relying on this for a real capital decision.
 *
 * QUANT_AUDIT.md Phase C, Task 3: rates are now versioned and dated rather
 * than bare module-level constants with no stated effective date — so a
 * future rate change is a NEW entry in RATE_HISTORY, not a silent edit that
 * makes every prior backtest result quietly mean something different than
 * when it was generated. `DEFAULT_RATES` is retained as a plain re-export
 * of the current entry for every existing caller (computeLegCharges/
 * computeRoundTripLegCharges are unchanged in behavior and signature).
 */

export interface CostRates {
  effectiveFrom: string; // "YYYY-MM-DD" — the date this rate set is believed to apply from
  source: string;        // what this was verified against, e.g. "Zerodha F&O tariff sheet, 2024-10 STT circular"
  brokeragePerOrder: number;
  optionsSttSellPct: number;
  exchangeTxnPct: number;
  sebiPct: number;
  stampDutyBuyPct: number;
  gstPct: number;
}

/**
 * Every known rate regime, oldest first — NOT exhaustive of all NSE
 * history, only what this codebase has verified. QUANT_AUDIT.md's
 * out-of-sample phase Task 13: the prior report applied the post-Oct-2024
 * rate schedule uniformly across the whole 2024-02-01 to 2026-09-15 real
 * backtest window, including the ~8 months (Feb-Sep 2024) that actually
 * traded under the LOWER pre-Oct-2024 options STT rate — a real,
 * verifiable historical fact (the same SEBI circular this module's own
 * prior comment already cited), not a guess. Every trade now looks up its
 * OWN trade date's applicable regime via ratesEffectiveOn(), rather than
 * always using DEFAULT_RATES.
 */
export const RATE_HISTORY: CostRates[] = [
  {
    effectiveFrom: '2024-02-01', // this codebase's real data coverage begins here — earlier regimes are NOT modeled (see ratesEffectiveOn's own fallback note)
    source: 'Pre-October-2024 options STT rate (0.0625% of premium, sell side) — the rate this SEBI/NSE circular explicitly says was superseded 2024-10-01. Brokerage/exchange/SEBI/stamp-duty/GST assumed unchanged from the current Zerodha F&O tariff sheet across this whole period (not independently re-verified per sub-period — only the STT change itself is a confirmed, dated fact this codebase has verified).',
    brokeragePerOrder: 20,
    optionsSttSellPct: 0.000625,
    exchangeTxnPct: 0.000325,
    sebiPct: 0.0000001,
    stampDutyBuyPct: 0.00003,
    gstPct: 0.18,
  },
  {
    effectiveFrom: '2024-10-01',
    source: 'SEBI/NSE STT circular (Oct 2024 options-STT increase, 0.0625% -> 0.1% of premium, sell side) + Zerodha F&O tariff sheet for brokerage/exchange/SEBI/stamp-duty rates.',
    brokeragePerOrder: 20,
    optionsSttSellPct: 0.001,
    exchangeTxnPct: 0.000325,
    sebiPct: 0.0000001,
    stampDutyBuyPct: 0.00003,
    gstPct: 0.18,
  },
];

/**
 * True only for the STT component specifically (the one rate change this
 * module has actually verified with a dated source) — brokerage/exchange/
 * SEBI/stamp-duty/GST are ASSUMED constant across the whole RATE_HISTORY
 * range, not independently confirmed per sub-period. Callers building a
 * data-quality label (e.g. the out-of-sample report) should cite this as
 * "STT: versioned and dated; other components: approximate, unverified
 * per-period" rather than claiming the whole cost model is exact history.
 */
export const COST_MODEL_LIMITATION =
  'Only the options-STT rate change (0.0625% -> 0.1%, 2024-10-01) is a confirmed, dated historical fact in this model. Brokerage/exchange/SEBI/stamp-duty/GST are held constant at current rates across the entire backtest window and are NOT independently verified for every historical sub-period — treat absolute historical cost figures as approximate, not exact.';

/** The rate set in effect for a given trade date — falls back to the OLDEST known entry for a date before RATE_HISTORY's own coverage begins (never fabricates an earlier regime; this is a stated limitation, not a real historical rate). */
export function ratesEffectiveOn(dateISO: string): CostRates {
  const applicable = RATE_HISTORY.filter((r) => r.effectiveFrom <= dateISO);
  return applicable.length ? applicable[applicable.length - 1] : RATE_HISTORY[0];
}

/** The current default — always the latest entry in RATE_HISTORY. Existing callers (computeLegCharges/computeRoundTripLegCharges) use this implicitly unless a specific historical date is given. */
export const DEFAULT_RATES: CostRates = RATE_HISTORY[RATE_HISTORY.length - 1];

// Backward-compatible bare exports — unchanged values, now sourced from
// DEFAULT_RATES so there is exactly one place a rate is actually defined.
export const BROKERAGE_PER_ORDER = DEFAULT_RATES.brokeragePerOrder;
export const OPTIONS_STT_SELL_PCT = DEFAULT_RATES.optionsSttSellPct;
export const EXCHANGE_TXN_PCT = DEFAULT_RATES.exchangeTxnPct;
export const SEBI_PCT = DEFAULT_RATES.sebiPct;
export const STAMP_DUTY_BUY_PCT = DEFAULT_RATES.stampDutyBuyPct;
export const GST_PCT = DEFAULT_RATES.gstPct;

export interface LegCharge {
  side: 'BUY' | 'SELL';
  /** price * quantity for this one order (entry OR exit, not both). */
  turnover: number;
}

export function computeLegCharges(leg: LegCharge, rates: CostRates = DEFAULT_RATES): number {
  const exchangeTxn = leg.turnover * rates.exchangeTxnPct;
  const sebi = leg.turnover * rates.sebiPct;
  const stt = leg.side === 'SELL' ? leg.turnover * rates.optionsSttSellPct : 0;
  const stampDuty = leg.side === 'BUY' ? leg.turnover * rates.stampDutyBuyPct : 0;
  const gst = (rates.brokeragePerOrder + exchangeTxn) * rates.gstPct;
  return rates.brokeragePerOrder + exchangeTxn + sebi + stt + stampDuty + gst;
}

/**
 * Full round-trip charges for one leg: an entry order at `entrySide` and
 * an exit order that necessarily flips it (closing a SELL means BUYing
 * back, and vice versa) — each leg's own side determines its own STT/
 * stamp-duty treatment on each of the two orders.
 */
export function computeRoundTripLegCharges(entrySide: 'BUY' | 'SELL', entryTurnover: number, exitTurnover: number, rates: CostRates = DEFAULT_RATES): number {
  const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
  return computeLegCharges({ side: entrySide, turnover: entryTurnover }, rates) + computeLegCharges({ side: exitSide, turnover: exitTurnover }, rates);
}

/**
 * The canonical, itemized per-trade cost/P&L breakdown (QUANT_AUDIT.md
 * Phase C, Task 3) — every research/backtest consumer should build ONE of
 * these per trade rather than computing net P&L ad hoc. Slippage/legging
 * cost are NOT computed here (they depend on the fill model, see
 * execution/fillSimulator.ts) — they are inputs, already known by the time
 * this is assembled, so this function stays a pure statutory-cost
 * calculator plus a final rollup.
 */
export interface TradeCostBreakdown {
  grossCredit: number;
  grossPnl: number;
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  sebiCharges: number;
  gst: number;
  stampDuty: number;
  entrySlippage: number;
  exitSlippage: number;
  leggingCost: number;
  totalCost: number;
  netPnl: number;
  ratesUsed: Pick<CostRates, 'effectiveFrom' | 'source'>;
}

export interface TradeCostLeg {
  side: 'BUY' | 'SELL';
  entryTurnover: number;
  exitTurnover: number;
}

export function computeTradeCostBreakdown(params: {
  grossCredit: number;
  grossPnl: number;
  legs: TradeCostLeg[];
  entrySlippage: number;
  exitSlippage: number;
  leggingCost: number;
  tradeDate: string;
}): TradeCostBreakdown {
  const rates = ratesEffectiveOn(params.tradeDate);
  let brokerage = 0, stt = 0, exchangeCharges = 0, sebiCharges = 0, gst = 0, stampDuty = 0;

  for (const leg of params.legs) {
    const exitSide = leg.side === 'BUY' ? 'SELL' : 'BUY';
    for (const [side, turnover] of [[leg.side, leg.entryTurnover], [exitSide, leg.exitTurnover]] as const) {
      const exchangeTxn = turnover * rates.exchangeTxnPct;
      const sebi = turnover * rates.sebiPct;
      const sttPart = side === 'SELL' ? turnover * rates.optionsSttSellPct : 0;
      const stampPart = side === 'BUY' ? turnover * rates.stampDutyBuyPct : 0;
      brokerage += rates.brokeragePerOrder;
      exchangeCharges += exchangeTxn;
      sebiCharges += sebi;
      stt += sttPart;
      stampDuty += stampPart;
      gst += (rates.brokeragePerOrder + exchangeTxn) * rates.gstPct;
    }
  }

  const totalCost = brokerage + stt + exchangeCharges + sebiCharges + gst + stampDuty +
    params.entrySlippage + params.exitSlippage + params.leggingCost;

  return {
    grossCredit: params.grossCredit, grossPnl: params.grossPnl,
    brokerage, stt, exchangeCharges, sebiCharges, gst, stampDuty,
    entrySlippage: params.entrySlippage, exitSlippage: params.exitSlippage, leggingCost: params.leggingCost,
    totalCost, netPnl: params.grossPnl - totalCost,
    ratesUsed: { effectiveFrom: rates.effectiveFrom, source: rates.source },
  };
}
