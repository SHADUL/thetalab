/**
 * The ONE canonical VWAP Scalper gross-P&L formula (VWAP_SCALPER_CORRECTNESS
 * Task 4) — before this file existed, `handleVwapScalperMonitor` computed
 * P&L inline, twice (once for unrealized, once for realized), with no
 * shared function backing either. Both call sites now go through this.
 *
 * Sign convention: a LONG profits when exit > entry; a SHORT profits when
 * exit < entry — mirrored, not two separate formulas.
 */
import type { Direction } from './types.ts';

export function computeVwapScalperGrossPnl(direction: Direction, entryPrice: number, exitPrice: number, quantity: number): number {
  const perShare = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return perShare * quantity;
}
