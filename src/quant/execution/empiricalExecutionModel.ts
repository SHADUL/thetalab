/**
 * Empirical execution-model calibration (live-data-capture phase, Task 9).
 * Builds `REALISTIC_EMPIRICAL_V1` — a FillSimulatorConfig fit from REAL
 * observed SHADOW/AUTO execution-quality records — WITHOUT ever touching
 * `REALISTIC_V1` (fillSimulator.ts's existing assumed model, kept
 * unchanged for comparison, per this phase's explicit instruction).
 *
 * Cannot produce a defensible result from too little data — refuses
 * (returns `null`) below MIN_OBSERVATIONS, the same "refuse rather than
 * guess" discipline every other statistical model in this codebase
 * already follows (realizedVolatility.ts's MIN_RETURNS_FOR_RV,
 * ivRank.ts's MIN_WINDOW_DAYS).
 */
import type { FillSimulatorConfig } from './fillSimulator.ts';

export interface ObservedFill {
  side: 'BUY' | 'SELL';
  decisionMid: number;
  bid: number;
  ask: number;
  actualFill: number;
  latencyMs: number;
  openInterest: number | null;
  volume: number | null;
}

export const MIN_OBSERVATIONS_FOR_CALIBRATION = 30; // matches FORWARD_VALIDATION_PROTOCOL.md's own 30-trade minimum

export interface EmpiricalDistributionSummary {
  n: number;
  meanSpreadPct: number;
  medianSpreadPct: number;
  meanSlippageBps: number;
  medianSlippageBps: number;
  meanLatencyMs: number;
  /** Fraction of the observed spread the average fill actually consumed — the empirical analog of fillSimulator's realisticSpreadFraction. */
  observedSpreadFraction: number;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeObservedFills(fills: ObservedFill[]): EmpiricalDistributionSummary | null {
  if (fills.length < MIN_OBSERVATIONS_FOR_CALIBRATION) return null;

  const spreadPcts = fills.map((f) => (f.ask - f.bid) / f.decisionMid).filter((v) => Number.isFinite(v) && v >= 0);
  const slippageBps = fills.map((f) => {
    const signed = f.side === 'BUY' ? f.actualFill - f.decisionMid : f.decisionMid - f.actualFill;
    return f.decisionMid > 0 ? (signed / f.decisionMid) * 10_000 : 0;
  });
  const latencies = fills.map((f) => f.latencyMs);
  const spreadFractions = fills.map((f) => {
    const halfSpread = (f.ask - f.bid) / 2;
    if (!(halfSpread > 0)) return 0;
    const adverse = f.side === 'BUY' ? f.actualFill - f.decisionMid : f.decisionMid - f.actualFill;
    return Math.max(0, Math.min(1, adverse / halfSpread));
  });

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: fills.length,
    meanSpreadPct: mean(spreadPcts), medianSpreadPct: median(spreadPcts),
    meanSlippageBps: mean(slippageBps), medianSlippageBps: median(slippageBps),
    meanLatencyMs: mean(latencies),
    observedSpreadFraction: mean(spreadFractions),
  };
}

/**
 * Builds REALISTIC_EMPIRICAL_V1 from a calibration summary — a
 * FillSimulatorConfig with the SAME shape as REALISTIC_V1/STRESS_V1, so it
 * drops straight into simulateStructureFill()/simulateSymbolRealistic()
 * without any downstream code change. Never mutates or replaces
 * REALISTIC_V1 itself — this is always a NEW object.
 */
export function buildEmpiricalConfig(summary: EmpiricalDistributionSummary): FillSimulatorConfig {
  return {
    mode: 'REALISTIC',
    realisticSpreadFraction: summary.observedSpreadFraction,
    assumedSpreadPctWhenUnknown: summary.meanSpreadPct, // only used as a fallback when a future quote genuinely has no bid/ask
    additionalSlippagePerUnit: 0,
    latencyMs: summary.meanLatencyMs,
    stressSpreadMultiplier: 1, stressExtraSlippagePerUnit: 0, stressLeggingAdverseMovePerLeg: 0,
    minOpenInterestForFullLiquidity: 500, minVolumeForFullLiquidity: 100, illiquidLegSlippageMultiplier: 1.5,
  };
}
