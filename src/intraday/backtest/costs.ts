import type { Direction } from '../types.ts';

/**
 * Realistic Zerodha-style intraday equity cost model — standard
 * published rates (brokerage/STT/exchange transaction charges/SEBI
 * charges/stamp duty/GST), not fitted to make results look better or
 * worse. Real fills also carry slippage beyond what a bar's OHLC alone
 * can say; SLIPPAGE_PCT is a single flat adverse-fill assumption
 * applied to both the entry and exit price, not a market-impact model —
 * a genuinely finer model would need tick data this backtest doesn't
 * have.
 */
const BROKERAGE_PCT = 0.0003; // 0.03% per executed order
const BROKERAGE_CAP = 20; // ₹20 per executed order, whichever is lower
const STT_SELL_PCT = 0.00025; // 0.025%, sell-side only, intraday equity
const EXCHANGE_TXN_PCT = 0.0000297; // NSE
const SEBI_PCT = 0.0000001; // ₹10 per crore of turnover
const STAMP_DUTY_BUY_PCT = 0.00003; // 0.003%, buy-side only
const GST_PCT = 0.18; // on brokerage + exchange transaction charges
export const SLIPPAGE_PCT = 0.0002; // 0.02% adverse assumption per fill

function brokerage(turnover: number): number {
  return Math.min(BROKERAGE_CAP, turnover * BROKERAGE_PCT);
}

/**
 * Total round-trip cost in rupees for one simulated trade. `entryPrice`/
 * `exitPrice` should already include slippage (see applySlippage) —
 * this function only computes brokerage/statutory charges on the
 * resulting turnover, it does not itself model fill quality.
 */
export function computeIntradayRoundTripCosts(entryPrice: number, exitPrice: number, shares: number, direction: Direction): number {
  const buyPrice = direction === 'LONG' ? entryPrice : exitPrice;
  const sellPrice = direction === 'LONG' ? exitPrice : entryPrice;
  const buyTurnover = buyPrice * shares;
  const sellTurnover = sellPrice * shares;
  const totalTurnover = buyTurnover + sellTurnover;

  const brokerageCost = brokerage(buyTurnover) + brokerage(sellTurnover);
  const stt = sellTurnover * STT_SELL_PCT;
  const exchangeTxn = totalTurnover * EXCHANGE_TXN_PCT;
  const sebi = totalTurnover * SEBI_PCT;
  const stampDuty = buyTurnover * STAMP_DUTY_BUY_PCT;
  const gst = (brokerageCost + exchangeTxn) * GST_PCT;

  return brokerageCost + stt + exchangeTxn + sebi + stampDuty + gst;
}

/** Adverse-to-the-trade fill assumption: a worse entry, a worse exit. */
export function applySlippage(price: number, direction: Direction, side: 'ENTRY' | 'EXIT'): number {
  const adverseSign = direction === 'LONG' ? (side === 'ENTRY' ? 1 : -1) : (side === 'ENTRY' ? -1 : 1);
  return price * (1 + adverseSign * SLIPPAGE_PCT);
}
