/**
 * Definition 7.2 — marketable limit price. Shared by SHADOW's fill
 * simulation now and AUTO's real order pricing later (Milestone 5) —
 * exactly the same function, per the mode-agnostic-logic rule.
 */
import { THETA } from '../parameters.ts';

export function marketableLimitPrice(
  side: 'BUY' | 'SELL',
  ltp: number,
  tick: number,
  proportionalBuffer: number = THETA.MARKETABLE_LIMIT_PROPORTIONAL_BUFFER,
  absoluteFloor: number = THETA.MARKETABLE_LIMIT_ABSOLUTE_FLOOR,
): number {
  const buffer = Math.max(proportionalBuffer * ltp, absoluteFloor);
  if (side === 'BUY') return tick * Math.ceil((ltp + buffer) / tick);
  return Math.max(tick, tick * Math.floor((ltp - buffer) / tick));
}
