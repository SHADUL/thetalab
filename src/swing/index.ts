/**
 * Swing Scanner — Phase 3 of the plan (indicator engine).
 *
 * Phase 3 (this file so far): pure technical-indicator math over OHLCV
 * arrays — EMA/SMA, RSI, MACD, ATR, ADX, Bollinger Bands, volume ratio.
 * Nothing here fetches data, stores anything, or knows about Kite or a
 * database; those are separate layers still to come (data → pattern →
 * ranking → risk → UI, per the architecture proposal), the same separation
 * src/quant already uses for the options side.
 */

export * from './indicators/types.ts';
export * from './indicators/movingAverages.ts';
export * from './indicators/oscillators.ts';
export * from './indicators/trend.ts';
export * from './indicators/bands.ts';
export * from './indicators/volume.ts';
