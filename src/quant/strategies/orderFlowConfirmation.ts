/**
 * OBSERVE-ONLY order-flow confirmation experiment. Takes order-flow
 * features published by the Alpha Ladder worker (G1/A1/d1, G2/A2/d2,
 * alignment, final direction D) and classifies how they relate to the RR
 * bias, in two independent ways so they can be compared:
 *
 *  A. RAW d1/d2: the naive reading. +1 means bid-side (buy-looking)
 *     pressure. Both d1 and d2 must agree on a side to count.
 *  B. Alpha Ladder's own final direction D, used purely as a feature. D
 *     already embeds Alpha Ladder's "aligned = fade" rule and Variation C;
 *     that rule is NOT assumed to be right for this strategy — it is one of
 *     the two things under test.
 *
 * Nothing here can place, size, block or modify an order. The hypothetical
 * structure is recorded for later comparison only.
 */
import type { Bias } from './regimeSelect.ts';
import type { StructureLabel } from './directionConfirmation.ts';

export type OrderFlowConfirmationMode = 'OFF' | 'OBSERVE';
export const DEFAULT_ORDER_FLOW_CONFIRMATION_MODE: OrderFlowConfirmationMode = 'OBSERVE';
export function parseOrderFlowConfirmationMode(value: unknown): OrderFlowConfirmationMode {
  return value === 'OFF' || value === 'OBSERVE' ? value : DEFAULT_ORDER_FLOW_CONFIRMATION_MODE;
}

/** Features exactly as the worker publishes them (snake_case row). */
export interface OrderFlowFeatureRow {
  created_at: string;
  session_date: string;
  as_of_sec: number;
  g1: number | null; a1: number; d1: number;
  g2: number | null; a2: number; d2: number;
  d2_basis: string;
  g2_crossed: boolean;
  alpha: number | null;
  base_direction: number | null;
  final_direction: number | null;
  g1_active: boolean;
  session_valid: boolean;
}

export type FlowDirection = 'bullish' | 'bearish' | 'mixed' | 'unavailable';
export type FlowMatch = 'MATCH' | 'CONFLICT' | 'NOT_COMPARABLE';

export const MAX_FEATURE_AGE_SEC = 180;

export interface FeatureAvailability {
  available: boolean;
  reason: 'OK' | 'NO_FEATURE_ROW' | 'STALE' | 'WRONG_SESSION_DATE' | 'G1_NOT_ACTIVE';
  ageSec: number | null;
}

export function assessFeatureAvailability(row: OrderFlowFeatureRow | null, nowMs: number, todayISO: string): FeatureAvailability {
  if (!row) return { available: false, reason: 'NO_FEATURE_ROW', ageSec: null };
  const ageSec = Math.round((nowMs - Date.parse(row.created_at)) / 1000);
  if (row.session_date !== todayISO) return { available: false, reason: 'WRONG_SESSION_DATE', ageSec };
  if (ageSec > MAX_FEATURE_AGE_SEC) return { available: false, reason: 'STALE', ageSec };
  if (!row.g1_active) return { available: false, reason: 'G1_NOT_ACTIVE', ageSec };
  return { available: true, reason: 'OK', ageSec };
}

/** Variant A. Missing/inactive data is 'unavailable' — never read as neutral. */
export function classifyRawFlow(row: OrderFlowFeatureRow | null, availability: FeatureAvailability): FlowDirection {
  if (!row || !availability.available) return 'unavailable';
  if (row.d1 === 0) return 'mixed';
  if (row.d1 === row.d2) return row.d1 > 0 ? 'bullish' : 'bearish';
  return 'mixed'; // d1 and d2 disagree (or d2 is zero): no raw confirmation either way
}

/** Variant B: Alpha Ladder's final D as a feature. */
export function classifyAlphaFlow(row: OrderFlowFeatureRow | null, availability: FeatureAvailability): FlowDirection {
  if (!row || !availability.available) return 'unavailable';
  if (row.final_direction === null) return 'mixed'; // d1 = 0: Alpha Ladder has no direction yet
  return row.final_direction > 0 ? 'bullish' : 'bearish';
}

export function compareRrToFlow(rrBias: Bias | null, flow: FlowDirection): FlowMatch {
  if (rrBias === null || rrBias === 'neutral') return 'NOT_COMPARABLE';
  if (flow === 'unavailable' || flow === 'mixed') return 'NOT_COMPARABLE';
  return (rrBias === 'bullish') === (flow === 'bullish') ? 'MATCH' : 'CONFLICT';
}

/** Hypothetical structure under RR + order-flow confirmation (recorded only, never acted on). */
export function hypotheticalStructure(rrBias: Bias | null, rrStructure: StructureLabel, flow: FlowDirection): StructureLabel | 'NO_TRADE' {
  if (rrBias === null) return 'NO_TRADE';
  if (flow === 'unavailable') return 'NO_TRADE'; // missing data is not neutral
  const m = compareRrToFlow(rrBias, flow);
  if (m === 'MATCH') return rrStructure;
  return 'Iron Condor'; // conflict, mixed flow, or neutral RR: no directional confirmation
}
