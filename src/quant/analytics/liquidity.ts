/**
 * A HARD liquidity gate for individual option legs and full strategies —
 * distinct from tradeQualityScore.ts's scoreLiquidity(), which only
 * soft-discounts a candidate's score for thin liquidity. Soft discounting
 * is the wrong mechanism for the case that actually matters: a
 * mathematically attractive but genuinely unfillable spread (0 OI, 0
 * volume, a 17.9% spread — a real candidate this engine's own diagnostics
 * surfaced) must be REJECTED outright, never merely scored lower and left
 * to possibly win anyway on its other components.
 *
 * Classifies OI, volume, and spread (when quoted) against config.ts's own
 * dataQuality thresholds — the same thresholds scoreLiquidity already
 * uses, so nothing that fails this hard gate is ever scored as healthy by
 * the soft scorer either.
 *
 * Two signals from the fuller liquidity spec are deliberately NOT
 * implemented here: quote freshness and available quantity at the touch.
 * This engine doesn't capture either anywhere in its data model today —
 * `OptionQuote.asOf` is the batch request time, uniform across every leg
 * in a scan (see kiteQuoteToOptionRow), not a genuine per-instrument
 * last-trade-time; and no market-depth/quantity field exists at all.
 * Left out rather than faked with a number that would look precise but
 * measure nothing.
 */
import type { EnrichedQuote } from '../types.ts';
import { DEFAULT_CONFIG, type DataQualityConfig } from '../config.ts';

export type LiquidityTier = 'LIQUID' | 'ACCEPTABLE' | 'POOR' | 'UNTRADABLE';

export interface LegLiquidity {
  tier: LiquidityTier;
  /** Plain-English reasons contributing to a non-LIQUID tier. Empty when tier is LIQUID. */
  reasons: string[];
  openInterest: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  spreadAbs: number | null;
}

/** Classifies one leg's tradability from its own quote — see this file's header for what is and isn't checked. */
export function classifyLegLiquidity(
  quote: EnrichedQuote,
  cfg: DataQualityConfig = DEFAULT_CONFIG.dataQuality,
): LegLiquidity {
  const { openInterest, volume, bid, ask } = quote.quote;
  const spreadPct = quote.spreadPct;
  const spreadAbs = quote.spread;
  const reasons: string[] = [];
  let untradable = false;
  let poor = false;

  // Zero OI AND zero volume together mean nobody is trading this strike at
  // all — untradable regardless of what the spread happens to show, and
  // meaningful even when spread is unavailable (EOD/bhavcopy data).
  if (openInterest === 0 && volume === 0) {
    untradable = true;
    reasons.push('zero open interest and zero volume — no one is trading this strike');
  } else {
    if (openInterest !== null && openInterest < cfg.minOpenInterest) {
      poor = true;
      reasons.push(`open interest ${openInterest} below the ${cfg.minOpenInterest} minimum`);
    }
    if (volume !== null && volume < cfg.minVolume) {
      poor = true;
      reasons.push(`volume ${volume} below the ${cfg.minVolume} minimum`);
    }
  }

  // Spread is only evaluable with a genuine two-sided quote (live data) —
  // EOD/bhavcopy data has no bid/ask at all, and that absence must NOT be
  // treated as untradable (same discipline as tradeQualityScore.ts's
  // scoreLiquidity — see this file's header).
  if (spreadPct !== null) {
    if (spreadPct >= cfg.fatalSpreadPct) {
      untradable = true;
      reasons.push(`bid/ask spread ${(spreadPct * 100).toFixed(1)}% at or beyond the ${(cfg.fatalSpreadPct * 100).toFixed(0)}% fatal threshold`);
    } else if (spreadPct > cfg.maxSpreadPct) {
      poor = true;
      reasons.push(`bid/ask spread ${(spreadPct * 100).toFixed(1)}% above the ${(cfg.maxSpreadPct * 100).toFixed(0)}% acceptable threshold`);
    }
  } else {
    reasons.push('no live bid/ask — liquidity assessed from open interest/volume only');
  }

  let tier: LiquidityTier;
  if (untradable) {
    tier = 'UNTRADABLE';
  } else if (poor) {
    tier = 'POOR';
  } else if (
    bid !== null && ask !== null && bid > 0 && ask > 0 &&
    openInterest !== null && openInterest >= cfg.minOpenInterest * 2 &&
    volume !== null && volume >= cfg.minVolume * 2 &&
    spreadPct !== null && spreadPct <= cfg.maxSpreadPct / 2
  ) {
    tier = 'LIQUID';
  } else {
    // Meets the hard minimums but doesn't clear the comfortable-margin bar
    // above for LIQUID — most commonly because spread/bid-ask isn't quoted
    // at all (EOD data) even though OI/volume are healthy.
    tier = 'ACCEPTABLE';
  }

  return { tier, reasons: tier === 'LIQUID' ? [] : reasons, openInterest, volume, bid, ask, spreadPct, spreadAbs };
}

export interface StrategyLiquidity {
  /** The worst tier across all legs — a strategy is only as liquid as its least liquid leg. */
  tier: LiquidityTier;
  legs: LegLiquidity[];
  /** Populated only when tier is UNTRADABLE — the specific reason(s) that blocked the strategy. */
  blockingReasons: string[];
}

const TIER_ORDER: LiquidityTier[] = ['UNTRADABLE', 'POOR', 'ACCEPTABLE', 'LIQUID'];

/** A strategy's liquidity is its worst leg's liquidity — one illiquid leg makes the whole spread unfillable at a fair price. */
export function classifyStrategyLiquidity(legs: LegLiquidity[]): StrategyLiquidity {
  const tier = TIER_ORDER.find((t) => legs.some((l) => l.tier === t)) ?? 'LIQUID';
  const blockingReasons = tier === 'UNTRADABLE'
    ? legs.filter((l) => l.tier === 'UNTRADABLE').flatMap((l) => l.reasons)
    : [];
  return { tier, legs, blockingReasons };
}
