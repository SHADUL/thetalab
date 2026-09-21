/**
 * Drives a validated, sized candidate through the execution state machine
 * in PAPER mode — the only mode this system is allowed to run in until
 * the validation/backtest phases the spec itself requires (Phase 25-32)
 * actually exist. Every planned leg fills INSTANTLY at its quoted price:
 * paper mode does not model partial fills, broker rejection, or slippage
 * between decision and fill — those are real risks a live broker
 * introduces that a paper simulation, by construction, cannot reproduce.
 * That's a deliberate, stated limitation, not an oversight: the
 * leg-failure handler and retry loop this drives through are fully real
 * and fully tested (legFailureHandler.test.ts, stateMachine.test.ts) —
 * paper mode simply never has a reason to exercise them, since there is
 * no live broker response that can fail partially.
 *
 * This is the ONE place in the execution folder that composes the state
 * machine transitions into an actual run — everything it calls
 * (afterSubmission, deriveProtectionState, afterProtectionConfirmed,
 * beginMonitoring) already exists and is independently tested; this file
 * only sequences them and produces a human-readable trace, mirroring
 * auto_trade_log's own "the log IS the audit trail" convention.
 */
import { afterSubmission, afterProtectionConfirmed, beginMonitoring } from './stateMachine.ts';
import { deriveProtectionState } from './legFailureHandler.ts';
import type { ExecutionState, LegFillState, ProtectionState } from './types.ts';
import type { ValidationResult } from './preTradeValidation.ts';

export interface PlannedLeg {
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
  tradingsymbol: string;
  quantity: number;
  fillPrice: number;
}

export interface PaperFillResult {
  /** FAILED when validation didn't pass; ACTIVE when the paper structure "filled" and is now being monitored. */
  state: ExecutionState;
  legFills: Array<LegFillState & { tradingsymbol: string; quantity: number; fillPrice: number }>;
  protection: ProtectionState;
  /** Ordered, human-readable trace of every state transition — not a summary, the actual sequence. */
  log: string[];
}

export function runPaperExecution(legs: PlannedLeg[], validation: ValidationResult): PaperFillResult {
  const log: string[] = [];

  if (!validation.passed) {
    const failedDetail = validation.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join(' | ');
    log.push(`VALIDATING -> FAILED: ${failedDetail}`);
    return {
      state: 'FAILED',
      legFills: legs.map((l) => ({ ...l, status: 'REJECTED' })),
      protection: 'NONE',
      log,
    };
  }
  log.push('VALIDATING -> SUBMITTING: all pre-trade checks passed.');

  const legFills = legs.map((l) => ({ ...l, status: 'FILLED' as const }));
  const submissionState = afterSubmission(legFills);
  log.push(`SUBMITTING -> ${submissionState}: every leg filled at its quoted price (paper — no partial fills modeled).`);

  const protection = deriveProtectionState(legFills);
  const protectedState = afterProtectionConfirmed(submissionState);
  log.push(`${submissionState} -> ${protectedState}: structure complete, protection ${protection}.`);

  const activeState = beginMonitoring();
  log.push(`${protectedState} -> ${activeState}: handed off to position monitoring.`);

  return { state: activeState, legFills, protection, log };
}
