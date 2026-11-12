/**
 * Trading-cost models for a 2-leg NIFTY options spread (4 orders per round
 * trip). Both are ESTIMATES, not contract notes.
 *
 *  FLAT     — the baseline's configurable round-trip estimate (₹150 default),
 *             used for baseline comparison exactly as specified.
 *  DETAILED — per-order NSE F&O schedule (Zerodha published rates):
 *             brokerage ₹20/order, STT 0.1% of sell-side premium, NSE txn
 *             0.03503% of premium, SEBI ₹10/crore, stamp 0.003% of buy-side
 *             premium, GST 18% on (brokerage + txn + SEBI).
 *
 * Rates change; they are inputs here, not facts, and must be re-verified
 * before any result is treated as realistic.
 */
export const NSE_FO_OPTION_RATES = Object.freeze({
  brokeragePerOrder: 20,
  sttSellPct: 0.1,
  txnPct: 0.03503,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
  gstPct: 18,
});

export type OrderSide = 'BUY' | 'SELL';

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  txn: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function orderCharges(side: OrderSide, price: number, qty: number, rates = NSE_FO_OPTION_RATES): CostBreakdown {
  const turnover = Math.max(0, price) * qty;
  const brokerage = turnover > 0 ? rates.brokeragePerOrder : 0;
  const stt = side === 'SELL' ? turnover * rates.sttSellPct / 100 : 0;
  const txn = turnover * rates.txnPct / 100;
  const sebi = turnover * rates.sebiPerCrore / 1e7;
  const stamp = side === 'BUY' ? turnover * rates.stampBuyPct / 100 : 0;
  const gst = (brokerage + txn + sebi) * rates.gstPct / 100;
  return { brokerage, stt, txn, sebi, stamp, gst, total: brokerage + stt + txn + sebi + stamp + gst };
}

export function sumCosts(parts: CostBreakdown[]): CostBreakdown {
  const out = { brokerage: 0, stt: 0, txn: 0, sebi: 0, stamp: 0, gst: 0, total: 0 };
  for (const p of parts) for (const k of Object.keys(out) as Array<keyof CostBreakdown>) out[k] += p[k];
  for (const k of Object.keys(out) as Array<keyof CostBreakdown>) out[k] = r2(out[k]);
  return out;
}

/**
 * Detailed round-trip charges for a credit spread: SELL short + BUY long to
 * open; BUY short + SELL long to close.
 */
export function spreadRoundTripDetailed(p: { shortEntry: number; longEntry: number; shortExit: number; longExit: number; qty: number }): CostBreakdown {
  return sumCosts([
    orderCharges('SELL', p.shortEntry, p.qty),
    orderCharges('BUY', p.longEntry, p.qty),
    orderCharges('BUY', p.shortExit, p.qty),
    orderCharges('SELL', p.longExit, p.qty),
  ]);
}

/** Entry-side detailed charges only (2 orders). */
export function spreadEntryDetailed(p: { shortEntry: number; longEntry: number; qty: number }): CostBreakdown {
  return sumCosts([orderCharges('SELL', p.shortEntry, p.qty), orderCharges('BUY', p.longEntry, p.qty)]);
}

/** Round-trip cost the strategy uses for risk and exit decisions under the given model. */
export function modelRoundTripCost(model: 'FLAT' | 'DETAILED', flatEstimate: number, detailed: CostBreakdown): number {
  return model === 'FLAT' ? flatEstimate : detailed.total;
}
