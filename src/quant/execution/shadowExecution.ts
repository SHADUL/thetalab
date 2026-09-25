/**
 * SHADOW-specific execution logic (live-data-capture wiring phase, Tasks
 * 5/6/12). Deliberately ISOLATED from liveFill.ts/paperFill.ts — this
 * module is never imported by the AUTO or PAPER code paths, and it has no
 * dependency capable of placing a real order at all (there is no
 * `placeOrder`-shaped parameter anywhere in this file), which is a
 * stronger guarantee than a runtime check: it is structurally impossible
 * for this module to submit a broker order, not just tested to not do so.
 *
 * Reuses the EXACT enriched quotes the live decision pipeline already
 * computed (enrichChain's own EnrichedQuote, with real bid/ask/OI/volume
 * when the source is live Kite data) — never a second fetch "just for
 * logging/execution," per this phase's explicit instruction. The decision
 * pipeline itself (normalise -> enrichChain -> evaluateExpiries ->
 * decideTrade -> computePositionSize -> runPreTradeValidation) is NOT
 * duplicated here — it stays exactly where it already is, shared across
 * PAPER/SHADOW/AUTO in api/options-autotrade.ts. This module only covers
 * what happens AFTER that shared pipeline has already produced a
 * candidate: building SHADOW's simulated fills and judging whether the
 * result is eligible to count toward the official forward-validation
 * sample.
 */
import { SHADOW_EXECUTION_V1, simulateStructureFill, type LegQuote, type SimulatedFill } from './fillSimulator.ts';
import { afterSubmission, afterProtectionConfirmed, beginMonitoring } from './stateMachine.ts';
import { deriveProtectionState } from './legFailureHandler.ts';
import type { ValidationResult } from './preTradeValidation.ts';
import type { PlannedLeg, PaperFillResult } from './paperFill.ts';
import type { EnrichedQuote } from '../types.ts';

export interface ShadowCandidateLeg {
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
  /** The decision-time price the candidate was built/priced from (markPrice). */
  price: number;
  quantity: number;
}

/**
 * Builds fillSimulator.ts's LegQuote[] input directly from the SAME
 * EnrichedQuote objects the decision engine already used for this exact
 * candidate — the quote state that existed when the decision was made,
 * never a fresh query. Returns `null` for any leg whose corresponding
 * EnrichedQuote can't be found (should not happen if the caller passes the
 * same slice the candidate was built from) — the caller must treat a null
 * as a data-quality failure (EXECUTION_DATA_INSUFFICIENT), never silently
 * skip it.
 */
export function buildShadowLegQuotes(
  legs: ShadowCandidateLeg[],
  sliceQuotes: EnrichedQuote[],
): Array<{ leg: ShadowCandidateLeg; legQuote: LegQuote } | { leg: ShadowCandidateLeg; legQuote: null }> {
  const byKey = new Map(sliceQuotes.map((q) => [`${q.quote.strike}:${q.quote.right}`, q]));
  return legs.map((leg) => {
    const eq = byKey.get(`${leg.strike}:${leg.right}`);
    if (!eq) return { leg, legQuote: null };
    const legQuote: LegQuote = {
      side: leg.side, tradingsymbol: eq.quote.symbol,
      bid: eq.quote.bid, ask: eq.quote.ask,
      referencePrice: leg.price,
      spreadPct: eq.spreadPct,
      openInterest: eq.quote.openInterest, volume: eq.quote.volume,
    };
    return { leg, legQuote };
  });
}

export type ShadowFillOutcome =
  | { status: 'FILLED'; fills: SimulatedFill[]; hasRealBidAsk: boolean }
  | { status: 'EXECUTION_DATA_INSUFFICIENT'; reason: string };

/**
 * Runs the actual SHADOW fill simulation via SHADOW_EXECUTION_V1 — real
 * live bid/ask when present. Per this phase's explicit instruction, a leg
 * missing real bid/ask does NOT silently fall back to the historical
 * assumed-2%-spread model for the OFFICIAL sample — the caller (via
 * isEligibleForForwardValidation) must exclude such a signal from the
 * count, even though this function still returns a (diagnostic-only) fill
 * using fillSimulator's own EOD_APPROXIMATION path so the signal can still
 * be stored for inspection, never discarded.
 */
export function runShadowFillSimulation(
  legs: ShadowCandidateLeg[],
  sliceQuotes: EnrichedQuote[],
): ShadowFillOutcome {
  const resolved = buildShadowLegQuotes(legs, sliceQuotes);
  const missing = resolved.filter((r): r is { leg: ShadowCandidateLeg; legQuote: null } => r.legQuote === null);
  if (missing.length > 0) {
    return { status: 'EXECUTION_DATA_INSUFFICIENT', reason: `${missing.length} leg(s) had no matching enriched quote in the decision-time slice.` };
  }
  const legQuotes = resolved.map((r) => r.legQuote!);
  const fills = simulateStructureFill(legQuotes, 'REALISTIC', SHADOW_EXECUTION_V1);
  const hasRealBidAsk = legQuotes.every((q) => q.bid !== null && q.ask !== null && q.bid > 0 && q.ask > 0);
  return { status: 'FILLED', fills, hasRealBidAsk };
}

/** Everything Task 12's official-sample gate needs to check, gathered in one place so the gate itself stays a small, pure, fully-testable function. */
export interface ForwardEligibilityInput {
  baselineVersion: string;
  executionMode: 'SHADOW';
  fillModel: 'SHADOW_EXECUTION_V1';
  everyLegHasRealBidAsk: boolean;
  quotesFreshMs: number;
  maxQuoteAgeMs: number;
  snapshotStoredSuccessfully: boolean;
  ledgerSignalStoredSuccessfully: boolean;
  knownIngestionBug: boolean;
  brokerOrderPlaced: boolean;
  expectedBaselineVersion: string;
  expectedFillModel: 'SHADOW_EXECUTION_V1';
}

export interface ForwardEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * The official-sample gate (Task 12). A signal that fails this is NEVER
 * deleted — it is stored with `valid_for_forward_validation = false` and
 * the specific reason(s) attached, per this phase's explicit "never delete
 * it" instruction.
 */
export function isEligibleForForwardValidation(input: ForwardEligibilityInput): ForwardEligibilityResult {
  const reasons: string[] = [];
  if (input.baselineVersion !== input.expectedBaselineVersion) reasons.push(`baseline drift: expected ${input.expectedBaselineVersion}, got ${input.baselineVersion}`);
  if (input.executionMode !== 'SHADOW') reasons.push(`execution_mode must be SHADOW, got ${input.executionMode}`);
  if (input.fillModel !== input.expectedFillModel) reasons.push(`fill model drift: expected ${input.expectedFillModel}, got ${input.fillModel}`);
  if (!input.everyLegHasRealBidAsk) reasons.push('not every leg had real bid/ask at decision time');
  if (input.quotesFreshMs > input.maxQuoteAgeMs) reasons.push(`quote age ${input.quotesFreshMs}ms exceeds max ${input.maxQuoteAgeMs}ms`);
  if (!input.snapshotStoredSuccessfully) reasons.push('option-chain snapshot failed to persist');
  if (!input.ledgerSignalStoredSuccessfully) reasons.push('forward-validation ledger signal failed to persist');
  if (input.knownIngestionBug) reasons.push('a known ingestion bug was flagged for this scan');
  if (input.brokerOrderPlaced) reasons.push('a broker order was placed — this can never be a valid SHADOW signal');
  return { eligible: reasons.length === 0, reasons };
}

/**
 * The COMPLETED-trade eligibility gate (lifecycle-completion phase, Task
 * 8) — a second, stricter validator layered on top of
 * isEligibleForForwardValidation(): a trade counts toward the official
 * 30-trade forward-validation sample only when BOTH its entry AND its
 * exit independently satisfy every protocol requirement. Never deletes a
 * failing row — the caller stores it with `valid_for_forward_validation =
 * false` and these exact reasons attached, same discipline as the
 * entry-only gate.
 */
export interface CompletedTradeEligibilityInput {
  entryEligibility: ForwardEligibilityResult;
  exitEverLegHasRealBidAsk: boolean;
  exitQuotesFreshMs: number;
  maxQuoteAgeMs: number;
  entryExecutionTelemetryStored: boolean;
  exitExecutionTelemetryStored: boolean;
  outcomeStoredSuccessfully: boolean;
  strategyDrift: boolean;
  fillModelDrift: boolean;
  knownIngestionBug: boolean;
  brokerOrderPlaced: boolean;
  /**
   * Forward-start blocker phase, Task 2: the protocol-timing verdict for
   * this exact signal, ALREADY computed by the caller via
   * protocolTiming.ts's evaluateProtocolTimingEligibility (a pure
   * function that itself does no DB query — the caller does the read and
   * hands in the facts). Optional only so existing call sites/tests that
   * predate protocol-timing enforcement keep compiling; a caller that
   * omits it gets no protocol-timing check at all, which the readiness
   * evaluator (Task 9) refuses to call READY.
   */
  protocolTiming?: ForwardEligibilityResult;
}

export function isCompletedTradeEligibleForForwardValidation(input: CompletedTradeEligibilityInput): ForwardEligibilityResult {
  const reasons: string[] = [...input.entryEligibility.reasons.map((r) => `entry: ${r}`)];
  if (!input.exitEverLegHasRealBidAsk) reasons.push('exit: not every leg had real bid/ask at exit time');
  if (input.exitQuotesFreshMs > input.maxQuoteAgeMs) reasons.push(`exit: quote age ${input.exitQuotesFreshMs}ms exceeds max ${input.maxQuoteAgeMs}ms`);
  if (!input.entryExecutionTelemetryStored) reasons.push('entry execution-quality telemetry failed to persist');
  if (!input.exitExecutionTelemetryStored) reasons.push('exit execution-quality telemetry failed to persist');
  if (!input.outcomeStoredSuccessfully) reasons.push('ledger outcome failed to persist (or was already completed by another invocation)');
  if (input.strategyDrift) reasons.push('BASELINE_V1 strategy parameters drifted between entry and exit');
  if (input.fillModelDrift) reasons.push('fill model drifted between entry and exit');
  if (input.knownIngestionBug) reasons.push('a known ingestion bug was flagged for this trade');
  if (input.brokerOrderPlaced) reasons.push('a broker order was placed — this can never be a valid SHADOW trade');
  if (input.protocolTiming && !input.protocolTiming.eligible) reasons.push(...input.protocolTiming.reasons.map((r) => `protocol: ${r}`));
  return { eligible: reasons.length === 0, reasons };
}

/**
 * SHADOW's drop-in replacement for runPaperExecution() — same shape
 * (`PaperFillResult`), same state-machine transitions (mirrors
 * paperFill.ts's own sequencing exactly, via the same real
 * afterSubmission/deriveProtectionState/afterProtectionConfirmed/
 * beginMonitoring functions, not reimplemented), but every leg's
 * `fillPrice` comes from SHADOW_EXECUTION_V1's real-live-bid/ask
 * simulation (shadowExecution.ts's own runShadowFillSimulation) instead of
 * the raw decision price paperFill.ts uses unmodified. Used ONLY behind
 * `execution_mode === 'SHADOW'` in api/options-autotrade.ts — never
 * imported by the AUTO or PAPER code paths.
 */
export function runShadowExecutionForLegs(
  legs: PlannedLeg[],
  validation: ValidationResult,
  sliceQuotes: EnrichedQuote[],
): PaperFillResult & { hasRealBidAsk: boolean } {
  const log: string[] = [];

  if (!validation.passed) {
    const failedDetail = validation.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join(' | ');
    log.push(`VALIDATING -> FAILED: ${failedDetail}`);
    return { state: 'FAILED', legFills: legs.map((l) => ({ ...l, status: 'REJECTED' as const })), protection: 'NONE', log, hasRealBidAsk: false };
  }

  const shadowLegs: ShadowCandidateLeg[] = legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, price: l.fillPrice, quantity: l.quantity }));
  const fillOutcome = runShadowFillSimulation(shadowLegs, sliceQuotes);

  if (fillOutcome.status === 'EXECUTION_DATA_INSUFFICIENT') {
    log.push(`VALIDATING -> FAILED: ${fillOutcome.reason}`);
    return { state: 'FAILED', legFills: legs.map((l) => ({ ...l, status: 'REJECTED' as const })), protection: 'NONE', log, hasRealBidAsk: false };
  }

  log.push('VALIDATING -> SUBMITTING: all pre-trade checks passed.');
  const legFills = legs.map((l, i) => ({ ...l, fillPrice: fillOutcome.fills[i].filledPrice, status: 'FILLED' as const }));
  const submissionState = afterSubmission(legFills);
  log.push(`SUBMITTING -> ${submissionState}: every leg filled via SHADOW_EXECUTION_V1 (real live bid/ask: ${fillOutcome.hasRealBidAsk}).`);

  const protection = deriveProtectionState(legFills);
  const protectedState = afterProtectionConfirmed(submissionState);
  log.push(`${submissionState} -> ${protectedState}: structure complete, protection ${protection}.`);

  const activeState = beginMonitoring();
  log.push(`${protectedState} -> ${activeState}: handed off to position monitoring (SHADOW — zero broker orders placed).`);

  return { state: activeState, legFills, protection, log, hasRealBidAsk: fillOutcome.hasRealBidAsk };
}

/** Kite's own raw /quote response shape for one instrument — the same object api/options-autotrade.ts's quoteMap already holds. Used to build a LegQuote directly, without going through enrichChain/EnrichedQuote at all (position-monitor doesn't run enrichChain). */
export interface RawKiteQuote {
  last_price?: number;
  oi?: number;
  volume?: number;
  depth?: { buy?: Array<{ price: number; quantity?: number }>; sell?: Array<{ price: number; quantity?: number }> };
}

/** Mirrors the mid/last preference already established elsewhere (enrich.ts, api/options-autotrade.ts's own midOrLastPrice) — bid/ask come straight off Kite's own market depth when present. */
export function buildLegQuoteFromRawKiteQuote(
  side: 'BUY' | 'SELL', tradingsymbol: string, referencePrice: number, raw: RawKiteQuote | undefined,
): LegQuote {
  const bid = raw?.depth?.buy?.[0]?.price;
  const ask = raw?.depth?.sell?.[0]?.price;
  const hasBid = bid !== undefined && bid > 0;
  const hasAsk = ask !== undefined && ask > 0;
  return {
    side, tradingsymbol,
    bid: hasBid ? bid! : null, ask: hasAsk ? ask! : null,
    referencePrice,
    spreadPct: hasBid && hasAsk && referencePrice > 0 ? (ask! - bid!) / referencePrice : null,
    openInterest: raw?.oi ?? null, volume: raw?.volume ?? null,
  };
}
