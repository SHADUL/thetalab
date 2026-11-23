/**
 * Versioned Indian index-options cost model for a BUY-then-SELL round trip
 * (Zerodha's published schedule, NSE). Estimates, not a contract note.
 *   brokerage ₹20/order · STT 0.1% of sell premium · NSE txn 0.03503% both
 *   sides · SEBI ₹10/crore both sides · stamp 0.003% of buy · GST 18% on
 *   brokerage + txn + SEBI.
 */
export const COST_MODEL_VERSION = 'IN-NFO-OPT-BUY-2026.11';

export interface CostModel {
  version: string;
  brokeragePerOrder: number;
  sttSellRate: number;
  txnRate: number;
  sebiPerCrore: number;
  stampBuyRate: number;
  gstRate: number;
}

export const COST_MODEL: CostModel = {
  version: COST_MODEL_VERSION,
  brokeragePerOrder: 20,
  sttSellRate: 0.001,
  txnRate: 0.0003503,
  sebiPerCrore: 10,
  stampBuyRate: 0.00003,
  gstRate: 0.18,
};

const r2 = (v: number) => Math.round(v * 100) / 100;

export function buyFees(premium: number, qty: number, m: CostModel = COST_MODEL): number {
  const t = premium * qty;
  const txn = t * m.txnRate, sebi = (t * m.sebiPerCrore) / 1e7;
  return r2(m.brokeragePerOrder + txn + sebi + t * m.stampBuyRate + m.gstRate * (m.brokeragePerOrder + txn + sebi));
}

export function sellFees(premium: number, qty: number, m: CostModel = COST_MODEL): number {
  const t = premium * qty;
  const txn = t * m.txnRate, sebi = (t * m.sebiPerCrore) / 1e7;
  return r2(m.brokeragePerOrder + t * m.sttSellRate + txn + sebi + m.gstRate * (m.brokeragePerOrder + txn + sebi));
}
