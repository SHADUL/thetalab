/**
 * thetalab quant core — Phases 1 & 2.
 *
 * Phase 1: option-chain data model, provider adapters, normalisation, validation.
 * Phase 2: Black-76 pricing, analytic Greeks, implied-vol solver, forward derivation.
 *
 * Nothing here imports React, fetches anything, or knows about a broker.
 * Later phases (expected move, strategy construction, strike optimiser, risk,
 * Monte Carlo, backtest) consume EnrichedChain and add to this barrel.
 */

export * from './types.ts';
export * from './config.ts';
export * from './math/normal.ts';
export * from './pricing/black76.ts';
export * from './data/adapter.ts';
export * from './data/providers/jsonRows.ts';
export { enrichChain, yearFraction } from './enrich.ts';
