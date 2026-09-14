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
export * from './indicators/splitAdjust.ts';
export * from './indicators/weekly.ts';
export * from './patterns/types.ts';
export * from './patterns/detect.ts';
export * from './scoring/types.ts';
export * from './scoring/factors.ts';
export * from './scoring/riskReward.ts';
export * from './scoring/sectorStrength.ts';
export * from './scoring/presets.ts';
export * from './scoring/swingScore.ts';
export * from './backtest/types.ts';
export * from './backtest/simulate.ts';
export * from './backtest/regime.ts';
export * from './backtest/metrics.ts';
export * from './structure/types.ts';
export * from './structure/evaluate.ts';
