/**
 * Nifty Alpha Edge (hedged131) — parameters that DIFFER from, or are
 * specific to, this strategy. The signal parameters (θ1–θ9: quantile 0.85,
 * 150,000 warm-up, 15-min windows, 3-min snapshots, crossing 9.0, dead-band
 * 1e-4, calm VIX 12.5, strong read 4.5, 15-min VIX bars) are IDENTICAL to
 * hedged133 and are not redefined here: the signal comes from the shared
 * engine (src/nifty-alpha-ladder/signal) unchanged.
 */
export const STRATEGY_ID = 'hedged131';
export const STRATEGY_NAME = 'Nifty Alpha Edge';
export const STRATEGY_VERSION = 'HEDGED131_V3_0';

/** Wing distance in strike steps (4 × 50 = 200 points on NIFTY). */
export const WING_STEPS = 4;
/** Option type of the bearish form; the bullish form mirrors it (PE). */
export const BEARISH_OPTION_TYPE = 'CE' as const;

/** θ39 — capital budget per structure unit. */
export const UNIT_BUDGET_RUPEES = 125_000;

/** θ14 — pause between the protective BUY and the short SELL. */
export const INTER_LEG_SPACING_MS = 750;

/** Scheduled force-exit / safety-net on the position's expiry day (Tuesday for normal weekly expiries). */
export const SCHEDULED_EXIT_MIN = 15 * 60 + 10;
export const SAFETY_EXIT_MIN = 15 * 60 + 20;
export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;

/**
 * Entry must follow the signal promptly: the engine is driven by a 1-minute
 * cron, so a position is opened on the first tick after the signal is
 * recorded, and never more than this long after it (stale entry = skip the
 * week rather than enter at a different price than the decision assumed).
 */
export const ENTRY_GRACE_MIN = 20;

/** Per-order fill wait for AUTO (bounded by the 60 s serverless budget; the spec's 75/100 s gates do not fit one invocation). */
export const AUTO_FILL_TIMEOUT_MS = 20_000;

export const OPTION_TICK = 0.05;

/** India VIX — read for Variation C at the signal instant. */
export const INDIA_VIX_QUOTE_KEY = 'NSE:INDIA VIX';
