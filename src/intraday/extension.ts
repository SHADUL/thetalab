const EXTENDED_ATR_THRESHOLD = 2.5; // starting heuristic, not fitted — see spec §59 on avoiding overfit thresholds

export interface ExtensionResult {
  distFromVwapAtr: number;
  distFromEma9Atr: number;
  extended: boolean;
}

/**
 * Extension check (spec §22) — "do not buy simply because a stock has
 * already risen 4-6% intraday." Measured in ATR units (volatility-
 * relative), not a flat percentage, so a naturally volatile stock isn't
 * penalized for a move that's normal for it.
 */
export function computeExtension(price: number, vwap: number, ema9: number, atr14: number | null): ExtensionResult {
  const atr = atr14 && atr14 > 0 ? atr14 : null;
  const distFromVwapAtr = atr ? Math.abs(price - vwap) / atr : 0;
  const distFromEma9Atr = atr ? Math.abs(price - ema9) / atr : 0;
  const extended = distFromVwapAtr > EXTENDED_ATR_THRESHOLD || distFromEma9Atr > EXTENDED_ATR_THRESHOLD;
  return { distFromVwapAtr, distFromEma9Atr, extended };
}
