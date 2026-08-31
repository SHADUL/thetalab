/**
 * All thresholds live here, none in the engines. Phase 1-2 only needs the
 * data-quality and pricing blocks; risk/scoring blocks land in later phases
 * and extend this same object so there is one settings surface, not five.
 */

export interface DataQualityConfig {
  /** Quote older than this (ms) is flagged stale. */
  maxQuoteAgeMs: number;
  /** Spread/mid above this is flagged wide. Fraction, not percent. */
  maxSpreadPct: number;
  /** Spread/mid above this is fatal — the quote is unusable for pricing. */
  fatalSpreadPct: number;
  /** Minimum open interest before a strike is flagged illiquid. */
  minOpenInterest: number;
  /** Minimum session volume before a strike is flagged illiquid. */
  minVolume: number;
  /** IV outside [min,max] is implausible for an index option. */
  minPlausibleIv: number;
  maxPlausibleIv: number;
  /**
   * Relative gap between a provider's Greek and ours before we flag it.
   * Divergence usually means a different underlying (spot vs forward) or a
   * different day-count on theta — worth knowing, not worth auto-correcting.
   */
  greekDivergenceTolerance: number;
  /** A slice with fewer usable strikes than this cannot support selection. */
  minStrikesForSelection: number;
  /**
   * Minimum vega (price change per 1.00 of vol) for a solved IV to be
   * meaningful. Below this the quote cannot resolve volatility at the
   * exchange tick size, and the IV is reported as unavailable rather than
   * fitted. Default 5.0: with a 0.05 tick, that is roughly one vol point of
   * resolution.
   */
  minVegaForIv: number;
}

export interface PricingConfig {
  /** Fallback risk-free rate when the provider gives none. */
  defaultRiskFreeRate: number;
  /** Day count for time to expiry. ACT/365 matches how IV is quoted. */
  dayCount: 'ACT/365';
  /**
   * Prefer mid, then settle, then last, when solving for IV. Order matters:
   * `last` can be hours stale on a wing strike and produces a garbage smile.
   */
  markPricePreference: Array<'mid' | 'settle' | 'last'>;
  /** Recompute model Greeks even when the provider supplies its own. */
  alwaysComputeModelGreeks: boolean;
  /** Which set the engine consumes downstream when both exist. */
  preferredGreekSource: 'observed' | 'model';
}

export interface QuantConfig {
  dataQuality: DataQualityConfig;
  pricing: PricingConfig;
}

export const DEFAULT_CONFIG: QuantConfig = {
  dataQuality: {
    maxQuoteAgeMs: 5 * 60_000,
    maxSpreadPct: 0.05,
    fatalSpreadPct: 0.5,
    minOpenInterest: 500,
    minVolume: 100,
    minPlausibleIv: 0.02,
    maxPlausibleIv: 2.5,
    greekDivergenceTolerance: 0.1,
    minStrikesForSelection: 8,
    minVegaForIv: 5.0,
  },
  pricing: {
    defaultRiskFreeRate: 0.065,
    dayCount: 'ACT/365',
    // Model Greeks are preferred by default because Indian feeds either omit
    // Greeks entirely or compute them against spot rather than the forward.
    markPricePreference: ['mid', 'settle', 'last'],
    alwaysComputeModelGreeks: true,
    preferredGreekSource: 'model',
  },
};

export function withConfig(overrides: DeepPartial<QuantConfig>): QuantConfig {
  return {
    dataQuality: { ...DEFAULT_CONFIG.dataQuality, ...overrides.dataQuality },
    pricing: { ...DEFAULT_CONFIG.pricing, ...overrides.pricing } as QuantConfig['pricing'],
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };
