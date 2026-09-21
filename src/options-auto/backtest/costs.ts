/**
 * Realistic NSE/BSE F&O options cost model — standard published rates,
 * not fitted to make results look better or worse (same discipline as
 * src/intraday/backtest/costs.ts). Options STT specifically has changed
 * before (0.0625% -> 0.1% of premium, sell side, effective Oct 2024) and
 * will again — verify every rate below against the current NSE/SEBI
 * circular before relying on this for a real capital decision.
 */

export const BROKERAGE_PER_ORDER = 20;      // flat per executed order (Zerodha-style F&O brokerage — not %-capped like equity intraday)
export const OPTIONS_STT_SELL_PCT = 0.001;  // 0.1% of premium, SELL side only
export const EXCHANGE_TXN_PCT = 0.000325;   // ~0.0325% of premium
export const SEBI_PCT = 0.0000001;          // ₹10 per crore of turnover
export const STAMP_DUTY_BUY_PCT = 0.00003;  // 0.003% of premium, BUY side only
export const GST_PCT = 0.18;                // on (brokerage + exchange transaction charge)

export interface LegCharge {
  side: 'BUY' | 'SELL';
  /** price * quantity for this one order (entry OR exit, not both). */
  turnover: number;
}

export function computeLegCharges(leg: LegCharge): number {
  const exchangeTxn = leg.turnover * EXCHANGE_TXN_PCT;
  const sebi = leg.turnover * SEBI_PCT;
  const stt = leg.side === 'SELL' ? leg.turnover * OPTIONS_STT_SELL_PCT : 0;
  const stampDuty = leg.side === 'BUY' ? leg.turnover * STAMP_DUTY_BUY_PCT : 0;
  const gst = (BROKERAGE_PER_ORDER + exchangeTxn) * GST_PCT;
  return BROKERAGE_PER_ORDER + exchangeTxn + sebi + stt + stampDuty + gst;
}

/**
 * Full round-trip charges for one leg: an entry order at `entrySide` and
 * an exit order that necessarily flips it (closing a SELL means BUYing
 * back, and vice versa) — each leg's own side determines its own STT/
 * stamp-duty treatment on each of the two orders.
 */
export function computeRoundTripLegCharges(entrySide: 'BUY' | 'SELL', entryTurnover: number, exitTurnover: number): number {
  const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
  return computeLegCharges({ side: entrySide, turnover: entryTurnover }) + computeLegCharges({ side: exitSide, turnover: exitTurnover });
}
